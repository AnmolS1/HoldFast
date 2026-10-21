// "Lock from an outside notice" — `POST /api/admin/moderation/lock-csam`, "find, then lock as
// suspected CSAM" (task §6): a node id, an R2 object key, or a files-host URL/path; only the node
// id is taken from it (the token is neither verified, stored nor logged). A folder is refused.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailTo } from "../auth/helpers";
import { reports } from "../../../src/worker/db/schema";
import { eq } from "drizzle-orm";
import {
  admin,
  adminCall,
  auditAbout,
  auditOf,
  baId,
  blocklistRow,
  contentUrlsIn,
  madeUpSha,
  makeFile,
  makeFolder,
  member,
  nodeRowOf,
  oldVersion,
  operators,
  reported,
  testDb,
  uploadAddress,
  userRowOf,
  type Who,
} from "./helpers";

const TOKEN = "MadeUpTokenNotARealOne0123456789abcdef";

const lock = (who: Who, reference: string, confirm: boolean, env = operators().env) =>
  adminCall(who, "POST", "/moderation/lock-csam", {
    body: { reference, reason: "Cloudflare match e-mail.", ...(confirm ? { confirm: true } : {}) },
    env,
  });

/** A file whose old version was uploaded by `first` and current one by `second` (both with addresses). */
async function twoUploaders() {
  const [owner, first, second] = await Promise.all([member(), member(), member()]);
  const file = await makeFile(owner.id, null, {
    scanStatus: "clean",
    sha256: madeUpSha(),
    createdBy: second.id,
  });
  const old = await oldVersion(file.id, owner.id, first.id);
  await uploadAddress(file.id, old, first.id, "192.0.2.51");
  await uploadAddress(file.id, file.versionId!, second.id, "192.0.2.52");
  return { owner, first, second, file, oldKey: `u/${owner.id}/${file.id}/${old}` };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the lookup accepts exactly the three kinds of reference", () => {
  it("a node id, the current and a superseded object key, and the three files-host forms resolve to the node; the lookup locks nothing", async () => {
    const op = await admin();
    const t = await twoUploaders();
    const references: [string, string][] = [
      [t.file.id, "node_id"],
      [t.file.r2Key!, "object_key"],
      [t.oldKey, "object_key"],
      [`http://files.localhost/d/${t.file.id}/${TOKEN}`, "files_url"],
      [`/i/${t.file.id}/${TOKEN}`, "files_url"],
      [`http://files.localhost/t/${t.file.id}/256/${TOKEN}?x=1`, "files_url"],
    ];
    for (const [reference, kind] of references) {
      const answer = await lock(op.as, reference, false);
      expect([answer.status, answer.body.referenceKind, answer.body.match?.nodeId], reference).toEqual([
        200,
        kind,
        t.file.id,
      ]);
      expect(answer.body.confirmed).toBe(false);
      expect(contentUrlsIn(answer.text)).toEqual([]);
    }
    const match = (await lock(op.as, t.file.id, false)).body.match;
    expect(match.uploaders.map((u: { uploader: { id: string } | null }) => u.uploader?.id).sort()).toEqual(
      [t.first.id, t.second.id].sort(),
    );
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("clean");
    expect(await auditOf("admin.csam_lock_manual", t.file.id)).toHaveLength(0);
  });

  it("the confirm locks with source admin — node, owner and EVERY distinct uploader held — and lands on the case", async () => {
    const op = await admin();
    const t = await twoUploaders();
    const ops = operators();
    const answer = await lock(op.as, `http://files.localhost/d/${t.file.id}/${TOKEN}`, true, ops.env);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ confirmed: true, match: { scanStatus: "suspected_csam" } });
    const reportId = answer.body.reportId as string;
    expect(reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(contentUrlsIn(answer.text)).toEqual([]);
    const node = (await nodeRowOf(t.file.id))!;
    expect([node.scanStatus, node.legalHold]).toEqual(["suspected_csam", true]);
    for (const who of [t.owner, t.first, t.second]) expect((await userRowOf(who.id))!.legalHold).toBe(true);
    const [lockRow] = await auditOf("scan.suspected_csam", t.file.id);
    expect(lockRow?.meta).toMatchObject({ source: "admin", reportId });
    const [manual] = await auditOf("admin.csam_lock_manual", t.file.id);
    expect(manual?.actorUserId).toBe(op.id);
    expect(manual?.meta).toMatchObject({ referenceKind: "files_url", reportId });
    expect(mailTo(ops.address).length).toBeGreaterThan(0);
  });

  it("a public-link URL, an unknown id and a malformed key → 404, nothing written", async () => {
    const op = await admin();
    const t = await twoUploaders();
    for (const reference of [
      `http://localhost/s/${TOKEN}`,
      `/s/${TOKEN}`,
      "0199d3c2-7a10-7000-8000-0000000000ee",
      "u/not-a-user/not-a-node/v",
      `u/${t.owner.id}/${t.file.id}`,
    ]) {
      for (const confirm of [false, true]) {
        expect((await lock(op.as, reference, confirm)).status, reference).toBe(404);
      }
    }
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("clean");
  });

  it("non-admin 403, no 2FA admin_requires_2fa, impersonated 403 — nothing locked", async () => {
    const op = await admin();
    const someone = await member();
    const t = await twoUploaders();
    const body = { reference: t.file.id, reason: "x", confirm: true };
    expect((await adminCall(someone.as, "POST", "/moderation/lock-csam", { body })).status).toBe(403);
    const no2fa = await adminCall({ ...op.as, secondFactorAt: null }, "POST", "/moderation/lock-csam", {
      body,
    });
    expect(no2fa.body.error).toBe("admin_requires_2fa");
    const imp = await adminCall({ ...op.as, impersonatedBy: baId() }, "POST", "/moderation/lock-csam", {
      body,
    });
    expect(imp.status).toBe(403);
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("clean");
  });

  it("the token of a files-host reference is in no audit row and no log line", async () => {
    const op = await admin();
    const t = await twoUploaders();
    const lines: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args));
    }
    expect((await lock(op.as, `/d/${t.file.id}/${TOKEN}`, false)).status).toBe(200);
    expect((await lock(op.as, `/d/${t.file.id}/${TOKEN}`, true)).status).toBe(200);
    const rows = await auditAbout(t.file.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });
});

describe("a folder cannot be locked", () => {
  it("its id, or a files URL naming it → 409 folder on lookup and on confirm; nothing about it changes, nobody is mailed; control: a file inside → locked", async () => {
    const op = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const inside = await makeFile(owner.id, folder.id, { scanStatus: "clean", sha256: madeUpSha() });
    const ops = operators();
    for (const reference of [folder.id, `http://files.localhost/d/${folder.id}/${TOKEN}`]) {
      for (const confirm of [false, true]) {
        const answer = await lock(op.as, reference, confirm, ops.env);
        expect([answer.status, answer.body.details?.reason], reference).toEqual([409, "folder"]);
      }
    }
    const after = (await nodeRowOf(folder.id))!;
    expect([after.scanStatus, after.legalHold]).toEqual([folder.scanStatus, false]);
    expect((await userRowOf(owner.id))!.legalHold).toBe(false);
    expect(await testDb().select().from(reports).where(eq(reports.nodeId, folder.id))).toEqual([]);
    expect(mailTo(ops.address)).toEqual([]);

    // Control: the file inside, the same request → locked, holds set.
    const locked = await lock(op.as, inside.id, true, ops.env);
    expect(locked.status).toBe(200);
    expect((await nodeRowOf(inside.id))!.scanStatus).toBe("suspected_csam");
    expect((await userRowOf(owner.id))!.legalHold).toBe(true);
    expect((await blocklistRow(inside.sha256!))?.reason).toBe("csam");
    // Nothing inherits from a lock: the folder itself is as it was.
    expect((await nodeRowOf(folder.id))!.legalHold).toBe(false);
  });

  it("section 5's escalate on a report whose node is a folder → 409 folder, nothing locked", async () => {
    const op = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const reportId = await reported(folder.id, owner.id, "other");
    const ops = operators();
    const answer = await adminCall(op.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "escalate_csam", resolution: "Looks like CSAM." },
      env: ops.env,
    });
    expect([answer.status, answer.body.details?.reason]).toEqual([409, "folder"]);
    expect((await nodeRowOf(folder.id))!.legalHold).toBe(false);
    expect((await userRowOf(owner.id))!.legalHold).toBe(false);
    const rows = await testDb().select().from(reports).where(eq(reports.nodeId, folder.id));
    expect(rows.map((row) => [row.category, row.status])).toEqual([["other", "open"]]);
    expect(mailTo(ops.address)).toEqual([]);
  });
});
