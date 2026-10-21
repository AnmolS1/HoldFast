// S16: every path of the upload routes that deletes or aborts something in the object store asks
// the restore detector first (`readsRolledBack`) and, while the database reads as rolled back,
// removes NOTHING — the answer is as usual; what stays is unreferenced, the orphan sweep's once
// the rollback is cleared. One case per helper, each run rolled back and, as its control, in step.
//
// The rollback is made in this file's OWN bucket (isolated per test file): the generation object
// two ahead of the database's number. No setting is written.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { THUMB_SIZES } from "../../../src/shared/constants";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { uploads } from "../../../src/worker/db/schema";
import { GENERATION_KEY } from "../../../src/worker/jobs/reconcile";
import { thumbKey } from "../../../src/worker/services/storage";
import { pngBytes } from "../../setup/fixture-bytes";
import { makeFile } from "../services-core/helpers";
import {
  call,
  complete,
  init,
  initBody,
  putSingle,
  sessionRow,
  sha256Of,
  TWO_PARTS,
  uniqueBytes,
  uploaded,
  uploader,
  watchedBucket,
  type UserRow,
} from "../uploads/helpers";
import { databaseGeneration, generationInStep, testDb } from "./helpers";

let database = 0;
beforeAll(async () => {
  database = await generationInStep();
});
afterEach(async () => {
  await env.FILES.put(GENERATION_KEY, String(database));
});

/** Runs `scenario` with the database reading as rolled back, then in step (the control). */
async function bothWays<T>(scenario: (rolledBack: boolean) => Promise<T>): Promise<[T, T]> {
  expect(await databaseGeneration()).toBe(database);
  await env.FILES.put(GENERATION_KEY, String(database + 2));
  const rolled = await scenario(true);
  await env.FILES.put(GENERATION_KEY, String(database));
  const inStep = await scenario(false);
  return [rolled, inStep];
}

const exists = async (key: string) => (await env.FILES.head(key)) !== null;

describe("S16 — the upload routes delete nothing while the database reads as rolled back", () => {
  it("discardStored (DELETE /uploads/:id, a single-PUT session): the object stays; the answer is the same", async () => {
    const [rolled, inStep] = await bothWays(async () => {
      const user = await uploader();
      const session = await uploaded(user, { size: 1000 });
      const key = (await sessionRow(session.uploadId))!.r2Key;
      const answer = await call(user, "DELETE", `/uploads/${session.uploadId}`);
      return {
        status: answer.status,
        status2: (await sessionRow(session.uploadId))!.status,
        kept: await exists(key),
      };
    });
    expect(rolled).toEqual({ status: 204, status2: "aborted", kept: true });
    expect(inStep).toEqual({ status: 204, status2: "aborted", kept: false });
  });

  it("discardStored (DELETE /uploads/:id, a multipart session): the store's upload is not aborted", async () => {
    const [rolled, inStep] = await bothWays(async () => {
      const user = await uploader();
      const session = await init(user, { size: TWO_PARTS });
      const watched = watchedBucket();
      const answer = await call(user, "DELETE", `/uploads/${session.uploadId}`, {
        env: { FILES: watched.bucket },
      });
      return { status: answer.status, aborts: watched.calls["upload.abort"] ?? 0 };
    });
    expect(rolled).toEqual({ status: 204, aborts: 0 });
    expect(inStep).toEqual({ status: 204, aborts: 1 });
  });

  it("refuseBlocked (a malware-listed file at complete): the object stays; the same 403, the session aborted", async () => {
    const [rolled, inStep] = await bothWays(async () => {
      const user = await uploader();
      const bytes = uniqueBytes();
      const sha256 = await sha256Of(bytes);
      await blocklist.upsert(testDb(), { sha256, reason: "malware" });
      const session = await uploaded(user, {}, bytes);
      const key = (await sessionRow(session.uploadId))!.r2Key;
      const answer = await complete(user, session.uploadId, { sha256 });
      return {
        status: answer.status,
        // The answer minus its request id (it differs per request by design).
        body: { ...answer.body, requestId: typeof answer.body.requestId },
        session: (await sessionRow(session.uploadId))!.status,
        kept: await exists(key),
      };
    });
    expect(rolled.kept).toBe(true);
    expect(inStep.kept).toBe(false);
    expect([rolled.status, rolled.session]).toEqual([403, "aborted"]);
    expect({ ...rolled, kept: null }).toEqual({ ...inStep, kept: null });
  });

  it("discardRemoved (an avatar replaced): the old avatar's object stays; the new one is the avatar either way", async () => {
    const PNG = pngBytes(32, 32);
    const picture = (n: number) => {
      const bytes = new Uint8Array(PNG.byteLength + 4);
      bytes.set(PNG);
      new DataView(bytes.buffer).setUint32(PNG.byteLength, n);
      return bytes;
    };
    async function avatar(user: UserRow, n: number) {
      const bytes = picture(n);
      const session = await init(user, {
        purpose: "avatar",
        mimeDeclared: "image/png",
        name: "me.png",
        size: bytes.byteLength,
        fileLastModified: new Date(Date.now() - n * 1000).toISOString(),
      });
      expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
      const answer = await complete(user, session.uploadId, {});
      expect(answer.status).toBe(201);
      return `a/${user.id}/${String(answer.body.id)}`;
    }
    // The first avatar is made in step; only the replacement runs rolled back (or in step).
    const users = [await uploader(), await uploader()];
    const firsts = [await avatar(users[0]!, 1), await avatar(users[1]!, 1)];
    const [rolled, inStep] = await bothWays(async (rolledBack) => {
      const i = rolledBack ? 0 : 1;
      const second = await avatar(users[i]!, 2);
      return { old: await exists(firsts[i]!), current: await exists(second) };
    });
    expect(rolled).toEqual({ old: true, current: true });
    expect(inStep).toEqual({ old: false, current: true });
  });

  it("the replaced version's thumbnails: they stay; the replace answers the same", async () => {
    const [rolled, inStep] = await bothWays(async () => {
      const user = await uploader();
      const name = `photo-${crypto.randomUUID().slice(0, 8)}.bin`;
      const file = await makeFile(user.id, null, { name, scanStatus: "clean", size: 10 });
      const thumbs = THUMB_SIZES.map((size) => thumbKey(file.id, file.versionId!, size));
      for (const key of thumbs) await env.FILES.put(key, "thumb");
      const bytes = uniqueBytes(10);
      const session = await init(user, { name, size: 10, onConflict: "replace", replaceNodeId: file.id });
      expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
      const answer = await complete(user, session.uploadId, { sha256: await sha256Of(bytes) });
      const left = [];
      for (const key of thumbs) left.push(await exists(key));
      return { status: answer.status, left };
    });
    // (A replace answers 200: the node already existed.)
    expect(rolled).toEqual({ status: 200, left: THUMB_SIZES.map(() => true) });
    expect(inStep).toEqual({ status: 200, left: THUMB_SIZES.map(() => false) });
  });

  it("withMultipart (another init recorded its upload first): its own new upload is not aborted", async () => {
    const [rolled, inStep] = await bothWays(async () => {
      const user = await uploader();
      const name = `big-${crypto.randomUUID().slice(0, 8)}.bin`;
      const first = await init(user, { name, size: TWO_PARTS });
      const recorded = (await sessionRow(first.uploadId))!.r2UploadId!;
      // The session lost its store upload (the init died after the admission) …
      await testDb().update(uploads).set({ r2UploadId: null }).where(eq(uploads.id, first.uploadId));
      // … and while this init creates one, another init records its own first.
      let aborts = 0;
      const bucket = new Proxy(env.FILES, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (typeof value !== "function") return value;
          if (property !== "createMultipartUpload") return (value as () => unknown).bind(target);
          return async (...args: unknown[]) => {
            const created = (await (value as (...a: unknown[]) => Promise<R2MultipartUpload>).apply(
              target,
              args,
            )) as R2MultipartUpload;
            await testDb()
              .update(uploads)
              .set({ r2UploadId: recorded })
              .where(eq(uploads.id, first.uploadId));
            return new Proxy(created, {
              get(upload, name) {
                const member = Reflect.get(upload, name) as unknown;
                if (name === "abort") {
                  return async () => {
                    aborts += 1;
                    return (member as () => Promise<void>).apply(upload);
                  };
                }
                return typeof member === "function" ? (member as () => unknown).bind(upload) : member;
              },
            });
          };
        },
      });
      const again = await call<{ uploadId: string }>(user, "POST", "/uploads", {
        json: initBody({ name, size: TWO_PARTS }),
        env: { FILES: bucket },
      });
      return { status: again.status, same: again.body.uploadId === first.uploadId, aborts };
    });
    expect(rolled).toEqual({ status: 200, same: true, aborts: 0 });
    expect(inStep).toEqual({ status: 200, same: true, aborts: 1 });
  });
});
