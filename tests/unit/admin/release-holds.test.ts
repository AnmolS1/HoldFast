// "Release holds" — the one release of what a suspected-CSAM lock held (task §6). When it is
// allowed is read from the report row alone (the release table, one test per row); what it
// releases is decided from the rows, and every hold another row still needs is kept and named.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { insertReport } from "../../../src/worker/db/queries/moderation";
import { reports } from "../../../src/worker/db/schema";
import { releasableAt } from "../../../src/worker/services/admin-actions";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import {
  addressRows,
  admin,
  adminCall,
  auditOf,
  baId,
  linkRowOf,
  madeUpSha,
  makeFile,
  makeFolder,
  makeLink,
  member,
  nodeRowOf,
  oldVersion,
  operators,
  rand,
  reportRowOf,
  reported,
  serviceDeps,
  testDb,
  uploadAddress,
  userRowOf,
  type Who,
} from "./helpers";

const DAY = 86_400_000;
type Person = { id: string };

/** A file in `parentId` (owner's), uploaded by `uploader`, LOCKED through T10's handler. */
async function lockFile(
  owner: Person,
  opts: { parentId?: string | null; uploader?: Person; sha256?: string } = {},
) {
  const uploader = opts.uploader ?? owner;
  const file = await makeFile(owner.id, opts.parentId ?? null, {
    scanStatus: "clean",
    sha256: opts.sha256 ?? madeUpSha(),
    createdBy: uploader.id,
  });
  await uploadAddress(file.id, file.versionId!, uploader.id, "192.0.2.20");
  const service = serviceDeps(operators().env);
  const { reportId } = await lockSuspectedCsam(service.deps, file.id, { source: "admin" });
  await service.settle();
  return { file, reportId };
}

/** One year back from now, shifted by `days`. */
function yearAgo(days: number): Date {
  const at = new Date();
  at.setUTCFullYear(at.getUTCFullYear() - 1);
  return new Date(at.getTime() + days * DAY);
}

const release = (who: Who, reportId: string, confirm = false, reason: string | null = "Counsel agreed.") =>
  adminCall(who, "POST", `/reports/${reportId}/release-holds`, {
    body: { ...(reason === null ? {} : { reason }), ...(confirm ? { confirm: true } : {}) },
  });
const clear = (who: Who, reportId: string) =>
  adminCall(who, "POST", `/reports/${reportId}/clear-lock`, {
    body: { reason: "The listing was added in error.", confirm: true },
    env: operators().env,
  });
/** The procedure as it runs: started (the case locked and held), then filed. */
const file = async (who: Who, reportId: string, filedAt: Date) => {
  const started = await adminCall(who, "POST", `/reports/${reportId}/ncmec/start`, { env: operators().env });
  if (started.status !== 200) return started;
  return adminCall(who, "POST", `/reports/${reportId}/ncmec/filed`, {
    body: { reportId: `CT-${rand(4)}`, filedAt: filedAt.toISOString() },
  });
};

const held = async (ids: string[]) => Promise.all(ids.map(async (id) => (await userRowOf(id))!.legalHold));

describe("the release table — one test per row", () => {
  it("filed, one day BEFORE filedAt + 1 year → 409 hold_not_releasable with releasableAt; nothing changes", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    const filedAt = yearAgo(1);
    const filed = await file(op.as, reportId, filedAt);
    expect(filed.status).toBe(200);
    const row = (await reportRowOf(reportId))!;
    expect(row.status).toBe("actioned");
    expect(row.ncmecFiledAt?.toISOString()).toBe(filedAt.toISOString());
    expect(row.resolution).toBe(`release_not_before:${releasableAt(filedAt).toISOString()}`);

    for (const confirm of [false, true]) {
      const answer = await release(op.as, reportId, confirm);
      expect([answer.status, answer.body.details]).toEqual([
        409,
        { reason: "hold_not_releasable", releasableAt: releasableAt(filedAt).toISOString() },
      ]);
    }
    expect((await nodeRowOf(node.id))!.legalHold).toBe(true);
    expect(await held([owner.id])).toEqual([true]);
    expect(await auditOf("admin.csam_holds_released", reportId)).toHaveLength(0);
  });

  it("filed, one day AFTER filedAt + 1 year → the first call previews and changes nothing; the confirmed call releases", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    const link = await makeLink(node.id, owner.id, ["moderation"]);
    expect((await file(op.as, reportId, yearAgo(-1))).status).toBe(200);

    const preview = await release(op.as, reportId);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      confirmed: false,
      releasedUserIds: [owner.id],
      node: { released: true },
    });
    expect((await nodeRowOf(node.id))!.legalHold).toBe(true);
    expect(await held([owner.id])).toEqual([true]);
    expect(await auditOf("admin.csam_holds_released", reportId)).toHaveLength(0);

    const done = await release(op.as, reportId, true);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      confirmed: true,
      releasedUserIds: [owner.id],
      node: { released: true },
    });
    expect((await nodeRowOf(node.id))!.legalHold).toBe(false);
    expect(await held([owner.id])).toEqual([false]);
    const [row] = await auditOf("admin.csam_holds_released", reportId);
    expect(row?.actorUserId).toBe(op.id);
    expect(row?.meta).toMatchObject({ nodeId: node.id, releasedUserIds: [owner.id], kept: [] });
    // It changes no status: still locked, its links still paused.
    expect((await nodeRowOf(node.id))!.scanStatus).toBe("suspected_csam");
    expect((await linkRowOf(link.id)).pauseReasons).toContain("moderation");
  });

  it("dismissed and never filed (Clear lock) → released at once", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    expect((await clear(op.as, reportId)).status).toBe(200);
    expect((await reportRowOf(reportId))!.status).toBe("dismissed");
    const done = await release(op.as, reportId, true);
    expect(done.status).toBe(200);
    expect(done.body.releasedUserIds).toEqual([owner.id]);
    expect((await nodeRowOf(node.id))!.legalHold).toBe(false);
  });

  it("open, and reviewing (the procedure started) → 409 hold_not_releasable with no date", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    const open = await release(op.as, reportId, true);
    expect([open.status, open.body.details]).toEqual([409, { reason: "hold_not_releasable" }]);
    expect((await adminCall(op.as, "POST", `/reports/${reportId}/ncmec/start`)).status).toBe(200);
    expect((await reportRowOf(reportId))!.status).toBe("reviewing");
    const reviewing = await release(op.as, reportId, true);
    expect([reviewing.status, reviewing.body.details]).toEqual([409, { reason: "hold_not_releasable" }]);
    expect((await nodeRowOf(node.id))!.legalHold).toBe(true);
    expect(await held([owner.id])).toEqual([true]);
  });

  it("actioned with ncmecFiledAt null — a defect state — is treated as never: 409, no date", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    await testDb().update(reports).set({ status: "actioned" }).where(eq(reports.id, reportId));
    const answer = await release(op.as, reportId, true);
    expect([answer.status, answer.body.details]).toEqual([409, { reason: "hold_not_releasable" }]);
    expect((await nodeRowOf(node.id))!.legalHold).toBe(true);
  });
});

describe("what is released, and what is kept", () => {
  it("the node, its upload addresses, the owner and two uploaders of two versions → all released", async () => {
    const op = await admin();
    const [owner, first, second] = await Promise.all([member(), member(), member()]);
    const node = await makeFile(owner.id, null, {
      scanStatus: "clean",
      sha256: madeUpSha(),
      createdBy: second.id,
    });
    const old = await oldVersion(node.id, owner.id, first.id);
    await uploadAddress(node.id, old, first.id, "192.0.2.31");
    await uploadAddress(node.id, node.versionId!, second.id, "192.0.2.32");
    const service = serviceDeps(operators().env);
    const { reportId } = await lockSuspectedCsam(service.deps, node.id, { source: "admin" });
    await service.settle();
    expect(await held([owner.id, first.id, second.id])).toEqual([true, true, true]);
    expect((await addressRows(node.id)).map((row) => row.legalHold)).toEqual([true, true]);

    expect((await clear(op.as, reportId)).status).toBe(200);
    const done = await release(op.as, reportId, true);
    expect(done.status).toBe(200);
    expect([...done.body.releasedUserIds].sort()).toEqual([owner.id, first.id, second.id].sort());
    expect(done.body.uploadIpsReleased).toBe(2);
    expect(await held([owner.id, first.id, second.id])).toEqual([false, false, false]);
    expect((await addressRows(node.id)).map((row) => row.legalHold)).toEqual([false, false]);
    expect((await nodeRowOf(node.id))!.legalHold).toBe(false);

    // A second confirmed call releases nothing and says so.
    const again = await release(op.as, reportId, true);
    expect(again.body).toMatchObject({ confirmed: true, nothingToRelease: true, releasedUserIds: [] });
  });

  it("a user who is also a subject of a second, still-open csam report stays held; control: that report dismissed (never filed) → released", async () => {
    const op = await admin();
    const owner = await member();
    const { reportId } = await lockFile(owner);
    // A user's csam-category report on another file of the same owner: not locked, still open.
    const other = await makeFile(owner.id, null, { scanStatus: "clean" });
    const second = await reported(other.id, owner.id, "csam");
    expect((await clear(op.as, reportId)).status).toBe(200);

    const kept = await release(op.as, reportId, true);
    expect(kept.body.kept).toEqual([{ userId: owner.id, because: "other_csam_report" }]);
    expect(await held([owner.id])).toEqual([true]);

    // Control: the second report dismissed — the same release now lets the owner go.
    const dismissed = await adminCall(op.as, "POST", `/reports/${second}/action`, {
      body: { action: "dismiss", resolution: "Reviewed with the people involved." },
    });
    expect(dismissed.status).toBe(200);
    const done = await release(op.as, reportId, true);
    expect(done.body.releasedUserIds).toEqual([owner.id]);
    expect(await held([owner.id])).toEqual([false]);
  });

  it("m3: an editor who uploaded into O1's folder and O2's folder stays held while node 2 is locked; released with lock 2", async () => {
    const op = await admin();
    const [o1, o2, editor] = await Promise.all([member(), member(), member()]);
    const f1 = await makeFolder(o1.id);
    const f2 = await makeFolder(o2.id);
    const one = await lockFile(o1, { parentId: f1.id, uploader: editor });
    const two = await lockFile(o2, { parentId: f2.id, uploader: editor });

    expect((await clear(op.as, one.reportId)).status).toBe(200);
    const first = await release(op.as, one.reportId, true);
    expect(first.body.releasedUserIds).toEqual([o1.id]);
    expect(first.body.kept).toEqual([{ userId: editor.id, because: "other_locked_node" }]);
    expect(first.body.node.released).toBe(true);
    expect(await held([o1.id, editor.id])).toEqual([false, true]);
    expect((await nodeRowOf(one.file.id))!.legalHold).toBe(false);

    expect((await clear(op.as, two.reportId)).status).toBe(200);
    const second = await release(op.as, two.reportId, true);
    expect([...second.body.releasedUserIds].sort()).toEqual([o2.id, editor.id].sort());
    expect(await held([o2.id, editor.id])).toEqual([false, false]);
  });

  it("m3 control: an editor who uploaded to node 1 only is released by the first release", async () => {
    const op = await admin();
    const [o1, editor] = await Promise.all([member(), member()]);
    const f1 = await makeFolder(o1.id);
    const one = await lockFile(o1, { parentId: f1.id, uploader: editor });
    expect((await clear(op.as, one.reportId)).status).toBe(200);
    const done = await release(op.as, one.reportId, true);
    expect([...done.body.releasedUserIds].sort()).toEqual([o1.id, editor.id].sort());
    expect(done.body.kept).toEqual([]);
  });

  it("a hold set by hand BEFORE the lock stays (set_by_hand); control: no toggle row → released", async () => {
    const op = await admin();
    const [byHand, plain] = await Promise.all([member(), member()]);
    const toggled = await adminCall(op.as, "POST", `/users/${byHand.id}/legal-hold`, {
      body: { held: true, note: "Preservation letter 7." },
    });
    expect(toggled.status).toBe(200);
    const a = await lockFile(byHand);
    const b = await lockFile(plain);
    for (const reportId of [a.reportId, b.reportId]) expect((await clear(op.as, reportId)).status).toBe(200);
    const keptByHand = await release(op.as, a.reportId, true);
    expect(keptByHand.body.kept).toEqual([{ userId: byHand.id, because: "set_by_hand" }]);
    expect(await held([byHand.id])).toEqual([true]);
    const control = await release(op.as, b.reportId, true);
    expect(control.body.releasedUserIds).toEqual([plain.id]);
    expect(await held([plain.id])).toEqual([false]);
  });

  it("the node stays held when a second open csam report names it", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    expect((await file(op.as, reportId, yearAgo(-1))).status).toBe(200);
    // A second csam report on the same (still locked) file, from a user: open.
    await insertReport(testDb(), {
      nodeId: node.id,
      ownerId: owner.id,
      source: "user",
      category: "csam",
      reporterIpHashStable: `made-up-${rand(8)}`,
    });
    const done = await release(op.as, reportId, true);
    expect(done.body.node).toEqual({ released: false, keptBecause: "other_csam_report" });
    expect(done.body.kept).toEqual([{ userId: owner.id, because: "other_csam_report" }]);
    expect((await nodeRowOf(node.id))!.legalHold).toBe(true);
    expect((await addressRows(node.id)).every((row) => row.legalHold)).toBe(true);
  });
});

describe("refusals change nothing", () => {
  it("without confirm, without 2FA, under impersonation, without a reason → the holds stay", async () => {
    const op = await admin();
    const owner = await member();
    const { file: node, reportId } = await lockFile(owner);
    expect((await clear(op.as, reportId)).status).toBe(200);
    expect((await release(op.as, reportId)).body.confirmed).toBe(false);
    const no2fa = await adminCall(
      { ...op.as, secondFactorAt: null },
      "POST",
      `/reports/${reportId}/release-holds`,
      {
        body: { reason: "x", confirm: true },
      },
    );
    expect([no2fa.status, no2fa.body.error]).toEqual([403, "admin_requires_2fa"]);
    const impersonated = await adminCall(
      { ...op.as, impersonatedBy: baId() },
      "POST",
      `/reports/${reportId}/release-holds`,
      { body: { reason: "x", confirm: true } },
    );
    expect(impersonated.status).toBe(403);
    expect((await release(op.as, reportId, true, null)).status).toBe(400);
    expect((await release(op.as, reportId, true, "   ")).status).toBe(400);
    expect((await nodeRowOf(node.id))!.legalHold).toBe(true);
    expect(await held([owner.id])).toEqual([true]);
    expect(await auditOf("admin.csam_holds_released", reportId)).toHaveLength(0);
  });
});

describe("the Users toggle cannot be used to get round it", () => {
  it("clearing a subject of an unreleasable report → 409 hold_not_releasable; a hand-held user with no csam report → cleared", async () => {
    const op = await admin();
    const owner = await member();
    await lockFile(owner);
    const refused = await adminCall(op.as, "POST", `/users/${owner.id}/legal-hold`, {
      body: { held: false, note: "Trying the toggle." },
    });
    expect([refused.status, refused.body.details?.reason]).toEqual([409, "hold_not_releasable"]);
    expect(await held([owner.id])).toEqual([true]);

    const handHeld = await member({ legalHold: true });
    const cleared = await adminCall(op.as, "POST", `/users/${handHeld.id}/legal-hold`, {
      body: { held: false, note: "The letter was withdrawn." },
    });
    expect(cleared.status).toBe(200);
    expect(await held([handHeld.id])).toEqual([false]);
  });
});
