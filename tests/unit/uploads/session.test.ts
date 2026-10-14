// A session belongs to its uploader, and giving one up gives its reservation back — once.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { claimCompleting } from "../../../src/worker/db/queries/uploads";
import { uploads } from "../../../src/worker/db/schema";
import { storage } from "../../../src/worker/services/storage";
import { testDb } from "../services-core/helpers";
import {
  call,
  complete,
  init,
  partRows,
  putSingle,
  ROOMY,
  sessionRow,
  sha,
  TWO_PARTS,
  uploaded,
  uploader,
  usedBytes,
  zeros,
  type UserRow,
} from "./helpers";

/** The four `:id` routes, as one caller. */
function everyRoute(caller: UserRow | null, id: string) {
  return Promise.all([
    call(caller, "PUT", `/uploads/${id}/parts/1`, { body: new Uint8Array(4) }),
    call(caller, "PUT", `/uploads/${id}/single`, { body: new Uint8Array(1000) }),
    call(caller, "POST", `/uploads/${id}/complete`, { json: { sha256: sha(), parts: [] } }),
    call(caller, "DELETE", `/uploads/${id}`),
  ]);
}

describe("session ownership (IDOR)", () => {
  it("another signed-in user gets 404 on every :id route — byte for byte what an unknown id gets — and changes nothing", async () => {
    const owner = await uploader();
    const other = await uploader();
    const session = await init(owner, { size: 1000 });
    const theirs = await everyRoute(other, session.uploadId);
    const unknown = await everyRoute(other, uuidv7());
    for (const [index, answer] of theirs.entries()) {
      expect(answer.status).toBe(404);
      expect(answer.body.error).toBe("not_found");
      expect(answer.bytes).toBe(unknown[index]!.bytes);
    }
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "open", uploaderId: owner.id });
    expect(await env.FILES.head((await sessionRow(session.uploadId))!.r2Key)).toBeNull();
    expect(await usedBytes(owner.id)).toBe(1000);

    // The same with a body no route would accept: whose session it is, is decided first.
    const garbage = await call(other, "POST", `/uploads/${session.uploadId}/complete`, { json: { nope: 1 } });
    expect(garbage.status).toBe(404);

    // Control: the uploader is not answered 404 on any of them.
    const own = await everyRoute(owner, session.uploadId);
    expect(own.map((answer) => answer.status)).not.toContain(404);
  });

  it("the owner of the tree is not the uploader either: an editor's session is the editor's", async () => {
    const { makeFolder, makeShare } = await import("../services-core/helpers");
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const session = await init(editor, { parentId: folder.id });
    for (const answer of await everyRoute(owner, session.uploadId)) expect(answer.status).toBe(404);
    expect((await sessionRow(session.uploadId))?.status).toBe("open");
    expect((await call(owner, "GET", "/uploads/open")).body).toEqual([]);
  });

  it("signed out → 401 on every route; an id that is not a uuid is no route at all", async () => {
    const owner = await uploader();
    const session = await init(owner);
    for (const answer of await everyRoute(null, session.uploadId)) expect(answer.status).toBe(401);
    expect((await call(owner, "DELETE", "/uploads/open")).status).toBe(404);
    expect(
      (await call(owner, "PUT", `/uploads/${session.uploadId}/parts/abc`, { body: new Uint8Array(1) }))
        .status,
    ).toBe(404);
  });
});

describe("abort", () => {
  it("DELETE releases the reservation, deletes the object and the part rows — once, however often it is sent", async () => {
    const user = await uploader();
    const kept = await init(user, { size: 700 });
    const session = await uploaded(user, { size: 1000 });
    const key = (await sessionRow(session.uploadId))!.r2Key;
    expect(await env.FILES.head(key)).not.toBeNull();
    expect(await usedBytes(user.id)).toBe(1700);

    // Also with uploads switched off: giving space back is always allowed.
    const off = { settings: { ...ROOMY, uploadsEnabled: false } };
    expect((await call(user, "DELETE", `/uploads/${session.uploadId}`, off)).status).toBe(204);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await partRows(session.uploadId)).toHaveLength(0);
    expect(await env.FILES.head(key)).toBeNull();
    expect(await usedBytes(user.id)).toBe(700);

    const again = await Promise.all(
      [1, 2, 3].map(() => call(user, "DELETE", `/uploads/${session.uploadId}`)),
    );
    expect(again.map((answer) => answer.status)).toEqual([204, 204, 204]);
    expect(await usedBytes(user.id)).toBe(700);
    expect((await sessionRow(kept.uploadId))?.status).toBe("open");
    // Nothing more can be done with it.
    expect((await putSingle(user, session.uploadId, new Uint8Array(1000))).status).toBe(409);
    expect((await complete(user, session.uploadId)).status).toBe(409);
    expect(await usedBytes(user.id)).toBe(700);
  });

  it("five DELETEs at once release once", async () => {
    const user = await uploader();
    await init(user, { size: 300 });
    const session = await init(user, { size: 1000 });
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => call(user, "DELETE", `/uploads/${session.uploadId}`)),
    );
    expect(answers.every((answer) => answer.status === 204)).toBe(true);
    expect(await usedBytes(user.id)).toBe(300);
  });

  it("a multipart session: the store's upload is aborted", async () => {
    const user = await uploader();
    const session = await init(user, { size: TWO_PARTS });
    const row = (await sessionRow(session.uploadId))!;
    expect((await call(user, "DELETE", `/uploads/${session.uploadId}`)).status).toBe(204);
    expect(await usedBytes(user.id)).toBe(0);
    const store = storage(env);
    await expect(
      store.uploadPart(store.resumeMultipart(row.r2Key, row.r2UploadId!), 1, zeros(8), 8),
    ).rejects.toThrow();
  });

  it("a session past its expiry takes no bytes and cannot be completed, and DELETE still gives its space back", async () => {
    const user = await uploader();
    const session = await uploaded(user, { size: 1000 });
    await testDb()
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.id, session.uploadId));
    expect((await putSingle(user, session.uploadId, new Uint8Array(1000))).status).toBe(409);
    const refused = await complete(user, session.uploadId);
    expect(refused.status).toBe(409);
    expect((await sessionRow(session.uploadId))?.status).toBe("open");
    expect(await usedBytes(user.id)).toBe(1000);
    expect((await call(user, "DELETE", `/uploads/${session.uploadId}`)).status).toBe(204);
    expect(await usedBytes(user.id)).toBe(0);
  });

  it("a session that is being completed, or is done, is not DELETE's to abort", async () => {
    const user = await uploader();
    const claimed = await uploaded(user, { size: 1000 });
    expect(await claimCompleting(testDb(), claimed.uploadId, user.id)).not.toBeNull();
    const refused = await call(user, "DELETE", `/uploads/${claimed.uploadId}`);
    expect(refused.status).toBe(409);
    expect((await sessionRow(claimed.uploadId))?.status).toBe("completing");
    expect(await usedBytes(user.id)).toBe(1000);
    expect(await env.FILES.head((await sessionRow(claimed.uploadId))!.r2Key)).not.toBeNull();

    const done = await uploaded(user, { size: 500 });
    expect((await complete(user, done.uploadId)).status).toBe(201);
    expect((await call(user, "DELETE", `/uploads/${done.uploadId}`)).status).toBe(409);
    expect(await usedBytes(user.id)).toBe(1500);
  });

  it("DELETE racing complete: exactly one of them has the session, and the bytes are counted once or not at all", async () => {
    for (let round = 0; round < 6; round++) {
      const user = await uploader();
      const session = await uploaded(user, { size: 1000 });
      const key = (await sessionRow(session.uploadId))!.r2Key;
      const [finished, aborted] = await Promise.all([
        complete(user, session.uploadId),
        call(user, "DELETE", `/uploads/${session.uploadId}`),
      ]);
      const row = (await sessionRow(session.uploadId))!;
      if (row.status === "done") {
        expect([finished.status, aborted.status]).toEqual([201, 409]);
        expect(await usedBytes(user.id)).toBe(1000);
        expect(await env.FILES.head(key)).not.toBeNull();
      } else {
        expect(row.status).toBe("aborted");
        expect(aborted.status).toBe(204);
        expect([409, 400]).toContain(finished.status);
        expect(await usedBytes(user.id)).toBe(0);
      }
    }
  });
});
