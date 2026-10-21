// The pause switch on the REQUEST paths (task §11, ruling 2026-10-21; PLAN §6 rule 17): read
// inside `readsRolledBack`, so every request path that deletes an object keeps it while the
// switch is on — exactly as when the database reads as rolled back (tests/unit/trash/
// s16-uploads.test.ts) — with no wiring of its own. One case per path, each run with the switch
// ON and, as its control, OFF.
//
// The switch and the generation object live in this file's OWN bucket (isolated per test file):
// the generation is put in step with the database once, the switch is removed after every test.
// No setting is written.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { THUMB_SIZES } from "../../../src/shared/constants";
import { trash as trashQuery } from "../../../src/worker/db/queries/trash";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { thumbKey } from "../../../src/worker/services/storage";
import {
  api,
  audits,
  generationInStep,
  makeFile,
  member,
  nodeById,
  objectExists,
  storeFile,
  testDb,
} from "../trash/helpers";
import {
  call as uploadCall,
  complete,
  init,
  putSingle,
  sessionRow,
  sha256Of,
  uniqueBytes,
  uploaded,
  uploader,
} from "../uploads/helpers";
import { adminCall, admin, rand } from "./helpers";

beforeAll(async () => {
  await generationInStep();
});
afterEach(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});

/** Runs `scenario` with the switch ON, then OFF (the control). */
async function bothWays<T>(scenario: (paused: boolean) => Promise<T>): Promise<[T, T]> {
  await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");
  const paused = await scenario(true);
  await env.FILES.delete(DESTROY_PAUSED_KEY);
  const live = await scenario(false);
  return [paused, live];
}

/** An owner with a trashed file whose object (and a thumbnail) is stored. */
async function trashedFile() {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const stored = await storeFile(file);
  await trashQuery(testDb(), file.id, owner.id);
  return { owner, file, stored };
}

describe("the switch ON keeps every object a request path would delete", () => {
  it('trash "delete forever" (DELETE /nodes/:id) takes the held path: row, marker, object, `node.purge_requested`; control: deleted', async () => {
    const [paused, live] = await bothWays(async () => {
      const t = await trashedFile();
      const answer = await api({ user: t.owner }, `/nodes/${t.file.id}`, { method: "DELETE" });
      const row = await nodeById(t.file.id);
      return {
        status: answer.status,
        row: row !== null,
        marked: row?.purgeRequestedAt != null,
        object: await objectExists(t.stored.object),
        requested: (await audits("node.purge_requested", t.file.id)).length,
        purged: (await audits("node.purge", t.file.id)).length,
      };
    });
    expect(paused).toEqual({ status: 204, row: true, marked: true, object: true, requested: 1, purged: 0 });
    expect(live).toEqual({ status: 204, row: false, marked: false, object: false, requested: 1, purged: 1 });
  });

  it("DELETE /trash (empty the trash) takes the held path too; control: deleted", async () => {
    const [paused, live] = await bothWays(async () => {
      const t = await trashedFile();
      const answer = await api({ user: t.owner }, "/trash", { method: "DELETE" });
      return {
        status: answer.status,
        row: (await nodeById(t.file.id)) !== null,
        object: await objectExists(t.stored.object),
      };
    });
    expect(paused).toEqual({ status: 204, row: true, object: true });
    expect(live).toEqual({ status: 204, row: false, object: false });
  });

  it("the upload route's discard (DELETE /uploads/:id, a single-PUT session): the object stays; control: deleted", async () => {
    const [paused, live] = await bothWays(async () => {
      const user = await uploader();
      const session = await uploaded(user, { size: 1000 });
      const key = (await sessionRow(session.uploadId))!.r2Key;
      const answer = await uploadCall(user, "DELETE", `/uploads/${session.uploadId}`);
      return {
        status: answer.status,
        session: (await sessionRow(session.uploadId))!.status,
        kept: await objectExists(key),
      };
    });
    expect(paused).toEqual({ status: 204, session: "aborted", kept: true });
    expect(live).toEqual({ status: 204, session: "aborted", kept: false });
  });

  it("a replaced version's thumbnails: they stay; control: deleted", async () => {
    const [paused, live] = await bothWays(async () => {
      const user = await uploader();
      const name = `photo-${rand()}.bin`;
      const file = await makeFile(user.id, null, { name, scanStatus: "clean", size: 10 });
      const thumbs = THUMB_SIZES.map((size) => thumbKey(file.id, file.versionId!, size));
      for (const key of thumbs) await env.FILES.put(key, "thumb");
      const bytes = uniqueBytes(10);
      const session = await init(user, { name, size: 10, onConflict: "replace", replaceNodeId: file.id });
      expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
      const answer = await complete(user, session.uploadId, { sha256: await sha256Of(bytes) });
      const left = [];
      for (const key of thumbs) left.push(await objectExists(key));
      return { status: answer.status, left };
    });
    expect(paused).toEqual({ status: 200, left: THUMB_SIZES.map(() => true) });
    expect(live).toEqual({ status: 200, left: THUMB_SIZES.map(() => false) });
  });

  it("the switch put through the admin's audited action has the same effect as one put by hand", async () => {
    const who = await admin();
    const reason = `test ${rand()}`;
    const on = await adminCall(who.as, "POST", "/system/destroy-pause", {
      body: { on: true, reason, confirm: true },
    });
    expect(on.body.after).toBe("on");
    const t = await trashedFile();
    expect((await api({ user: t.owner }, `/nodes/${t.file.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await nodeById(t.file.id)).not.toBeNull();
    expect(await objectExists(t.stored.object)).toBe(true);
    const off = await adminCall(who.as, "POST", "/system/destroy-pause", {
      body: { on: false, reason, confirm: true },
    });
    expect(off.body.after).toBe("off");
    // Control: the switch off through the same action — the next delete goes through.
    const u = await trashedFile();
    expect((await api({ user: u.owner }, `/nodes/${u.file.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await nodeById(u.file.id)).toBeNull();
    expect(await objectExists(u.stored.object)).toBe(false);
  });
});
