// Size sanity (T26 item 7; implemented in T12, routes/uploads.ts complete): a node's `size` is the
// size of what the store holds — `head().size` at complete — for a single PUT and for a multipart
// upload; a store whose object is any other size than the session declared refuses the upload
// (400) and no node exists. Archive and bomb limits are ClamAV's (T20).
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nodes } from "../../../src/worker/db/schema";
import { makeFolder, testDb } from "../services-core/helpers";
import { complete, init, putParts, sessionRow, TWO_PARTS, uploaded, uploader } from "../uploads/helpers";

const nodesIn = (parentId: string) => testDb().select().from(nodes).where(eq(nodes.parentId, parentId));

/** The real bucket, whose head() reports `delta` more bytes than the object has. */
function lyingHead(delta: number) {
  const real = env.FILES;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "head") {
        return async (key: string) => {
          const object = await target.head(key);
          return object
            ? Object.assign(Object.create(Object.getPrototypeOf(object)), object, {
                size: object.size + delta,
              })
            : null;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a node's size is the stored object's size", () => {
  it("single PUT and multipart: node.size === head().size === the declared size", async () => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const single = await uploaded(user, { parentId: folder.id });
    expect((await complete(user, single.uploadId)).status).toBe(201);

    const multi = await init(user, { parentId: folder.id, size: TWO_PARTS });
    const parts = await putParts(user, multi, TWO_PARTS);
    expect((await complete(user, multi.uploadId, { parts })).status).toBe(201);

    const made = await nodesIn(folder.id);
    expect(made).toHaveLength(2);
    for (const node of made) {
      const head = await env.FILES.head(node.r2Key!);
      expect(node.size, node.name).toBe(head!.size);
    }
    expect(made.map((node) => node.size).sort((a, b) => a - b)).toEqual([1000, TWO_PARTS]);
  });

  it.each(["single", "multi"] as const)(
    "control: the same stand-in reporting the true size (%s) → 201",
    async (mode) => {
      const user = await uploader();
      const folder = await makeFolder(user.id);
      const FILES = lyingHead(0);
      if (mode === "single") {
        const { uploadId } = await uploaded(user, { parentId: folder.id });
        expect((await complete(user, uploadId, {}, { env: { FILES } })).status).toBe(201);
      } else {
        const session = await init(user, { parentId: folder.id, size: TWO_PARTS });
        const parts = await putParts(user, session, TWO_PARTS);
        expect((await complete(user, session.uploadId, { parts }, { env: { FILES } })).status).toBe(201);
      }
    },
  );

  it.each([
    ["single PUT, one byte more", 1, "single"],
    ["single PUT, one byte less", -1, "single"],
    ["multipart, one byte more", 1, "multi"],
    ["multipart, one byte less", -1, "multi"],
  ] as const)("%s in the store than declared → 400, no node", async (_label, delta, mode) => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const FILES = lyingHead(delta);
    let answer;
    let uploadId;
    if (mode === "single") {
      uploadId = (await uploaded(user, { parentId: folder.id })).uploadId;
      answer = await complete(user, uploadId, {}, { env: { FILES } });
    } else {
      const session = await init(user, { parentId: folder.id, size: TWO_PARTS });
      uploadId = session.uploadId;
      const parts = await putParts(user, session, TWO_PARTS);
      answer = await complete(user, uploadId, { parts }, { env: { FILES } });
    }
    expect(answer.status).toBe(400);
    expect(await nodesIn(folder.id)).toEqual([]);
    expect((await sessionRow(uploadId))?.status).toBe("aborted");
  });
});
