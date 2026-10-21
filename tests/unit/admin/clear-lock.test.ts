// "Clear lock (false positive)" — the way back from a wrong lock (task §6). Two steps; T05's
// `clearSuspectedCsam` decides; the console shows its whole result. It never touches a hold.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { insertReport } from "../../../src/worker/db/queries/moderation";
import { hashBlocklist, nodes, reports, shareLinks } from "../../../src/worker/db/schema";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import {
  admin,
  adminCall,
  auditOf,
  baId,
  blocklistRow,
  contentUrlsIn,
  linkRowOf,
  madeUpSha,
  makeFile,
  makeLink,
  member,
  nodeRowOf,
  operators,
  rand,
  reportRowOf,
  serviceDeps,
  testDb,
  uploadAddress,
  userRowOf,
  type Who,
} from "./helpers";

type Person = { id: string };

async function lockFile(owner: Person, sha256: string = madeUpSha()) {
  const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256 });
  await uploadAddress(file.id, file.versionId!, owner.id, "192.0.2.40");
  const service = serviceDeps(operators().env);
  const { reportId } = await lockSuspectedCsam(service.deps, file.id, { source: "admin" });
  await service.settle();
  return { file, reportId, sha256 };
}

const clear = (who: Who, reportId: string, confirm = true, reason: string | null = "Listed in error.") =>
  adminCall(who, "POST", `/reports/${reportId}/clear-lock`, {
    body: { ...(reason === null ? {} : { reason }), ...(confirm ? { confirm: true } : {}) },
    env: operators().env,
  });

/** A user's csam-category report on a node that is NOT locked (as the intake files one). */
async function csamReportOn(nodeId: string, ownerId: string) {
  return (await insertReport(testDb(), {
    nodeId,
    ownerId,
    source: "user",
    category: "csam",
    reporterIpHashStable: `made-up-${rand(8)}`,
  }))!;
}

const NOTHING = { blocklistRemoved: false, blocklistRestoredTo: null, blocklistKept: null };

describe("a confirmed clear", () => {
  it("node → pending, moderation off its links (an owner pause stays), the entry the lock made gone, the report dismissed, audited, one rescan — and every hold still there", async () => {
    const op = await admin();
    const owner = await member();
    const { file, reportId, sha256 } = await lockFile(owner);
    const live = await makeLink(file.id, owner.id);
    const ownerPaused = await makeLink(file.id, owner.id, ["owner"]);
    // Links made after the lock: give them the lock's pause as it would have.
    for (const link of [live, ownerPaused]) {
      await testDb()
        .update(shareLinks)
        .set({ pauseReasons: [...link.pauseReasons, "moderation"], pausedAt: new Date() })
        .where(eq(shareLinks.id, link.id));
    }
    expect((await blocklistRow(sha256))?.sourceNodeId).toBe(file.id);

    const answer = await clear(op.as, reportId);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      confirmed: true,
      nodeStatus: "pending",
      result: { cleared: true, refused: null, blocklistRemoved: true, reportIds: [reportId] },
    });
    expect(contentUrlsIn(answer.text)).toEqual([]);
    const node = (await nodeRowOf(file.id))!;
    expect(node.scanStatus).toBe("pending");
    expect((await linkRowOf(live.id)).pauseReasons).toEqual([]);
    expect((await linkRowOf(ownerPaused.id)).pauseReasons).toEqual(["owner"]);
    expect(await blocklistRow(sha256)).toBeNull();
    expect(await reportRowOf(reportId)).toMatchObject({ status: "dismissed", resolution: "false_positive" });
    const [row] = await auditOf("admin.csam_lock_cleared", file.id);
    expect(row?.actorUserId).toBe(op.id);
    expect(row?.meta).toMatchObject({ reportId, blocklist: "removed" });
    expect(await auditOf("scan.rescan_requested", file.id)).toHaveLength(1);
    // Holds are not touched.
    expect(node.legalHold).toBe(true);
    expect((await userRowOf(owner.id))!.legalHold).toBe(true);

    // Release holds then follows the "dismissed, never filed" row: at once.
    const released = await adminCall(op.as, "POST", `/reports/${reportId}/release-holds`, {
      body: { reason: "False positive confirmed.", confirm: true },
    });
    expect(released.status).toBe(200);
    expect(released.body.releasedUserIds).toEqual([owner.id]);

    // A second confirmed clear is the not_locked row.
    const again = await clear(op.as, reportId);
    expect([again.status, again.body.details?.reason]).toEqual([409, "not_locked"]);
  });

  it("a node with another open NON-csam report ends under_review, not pending", async () => {
    const op = await admin();
    const owner = await member();
    const { file, reportId } = await lockFile(owner);
    await insertReport(testDb(), {
      nodeId: file.id,
      ownerId: owner.id,
      source: "user",
      category: "spam",
      reporterIpHashStable: `made-up-${rand(8)}`,
    });
    const answer = await clear(op.as, reportId);
    expect(answer.body.nodeStatus).toBe("under_review");
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("under_review");
  });
});

describe("one test per CsamClearResult row", () => {
  it("refused not_locked: a csam report on a node that is not locked → 409, nothing written, nothing enqueued", async () => {
    const op = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
    const reportId = await csamReportOn(file.id, owner.id);
    for (const confirm of [false, true]) {
      const answer = await clear(op.as, reportId, confirm);
      expect([answer.status, answer.body.details?.reason]).toEqual([409, "not_locked"]);
    }
    expect((await reportRowOf(reportId))!.status).toBe("open");
    expect(await auditOf("admin.csam_lock_cleared", file.id)).toHaveLength(0);
    expect(await auditOf("scan.rescan_requested", file.id)).toHaveLength(0);
  });

  it("refused reported: a filed report → 409 reported; the node stays locked", async () => {
    const op = await admin();
    const owner = await member();
    const { file, reportId } = await lockFile(owner);
    expect((await adminCall(op.as, "POST", `/reports/${reportId}/ncmec/start`)).status).toBe(200);
    const filed = await adminCall(op.as, "POST", `/reports/${reportId}/ncmec/filed`, {
      body: { reportId: "CT-1", filedAt: new Date(Date.now() - 86_400_000).toISOString() },
    });
    expect(filed.status).toBe(200);
    for (const confirm of [false, true]) {
      const answer = await clear(op.as, reportId, confirm);
      expect([answer.status, answer.body.details?.reason]).toEqual([409, "reported"]);
    }
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("suspected_csam");
  });

  it("blocklistRestoredTo: an entry the lock RAISED from malware goes back to malware", async () => {
    const op = await admin();
    const owner = await member();
    const sha256 = madeUpSha();
    await blocklist.upsert(testDb(), { sha256, reason: "malware", sourceNodeId: null });
    const { reportId } = await lockFile(owner, sha256);
    expect((await blocklistRow(sha256))?.reason).toBe("csam");
    const answer = await clear(op.as, reportId);
    expect(answer.body.result).toMatchObject({ ...NOTHING, blocklistRestoredTo: "malware" });
    expect((await blocklistRow(sha256))?.reason).toBe("malware");
  });

  it("blocklistKept confirmed: an entry confirmed before the lock stays csam", async () => {
    const op = await admin();
    const owner = await member();
    const sha256 = madeUpSha();
    await blocklist.confirmCsam(testDb(), sha256);
    const { reportId } = await lockFile(owner, sha256);
    const answer = await clear(op.as, reportId);
    expect(answer.body.result).toMatchObject({ ...NOTHING, blocklistKept: "confirmed" });
    expect((await blocklistRow(sha256))?.reason).toBe("csam");
  });

  it("blocklistKept reported: a twin's csam report with the same content was filed", async () => {
    const op = await admin();
    const owner = await member();
    const twin = await lockFile(owner);
    const node = await lockFile(owner, twin.sha256);
    // The twin's report filed (without the route's confirmation of the hash), and the twin no
    // longer locked: only the filing is left behind the entry.
    await testDb()
      .update(reports)
      .set({ status: "actioned", ncmecFiledAt: new Date(), ncmecReportId: "CT-2" })
      .where(eq(reports.id, twin.reportId));
    await testDb().update(nodes).set({ scanStatus: "clean" }).where(eq(nodes.id, twin.file.id));
    const answer = await clear(op.as, node.reportId);
    expect(answer.body.result).toMatchObject({ ...NOTHING, blocklistKept: "reported" });
    expect((await blocklistRow(twin.sha256))?.reason).toBe("csam");
  });

  it("blocklistKept other_node_locked: a twin is still locked (and the entry is handed to it)", async () => {
    const op = await admin();
    const owner = await member();
    const first = await lockFile(owner);
    const second = await lockFile(owner, first.sha256);
    const answer = await clear(op.as, first.reportId);
    expect(answer.body.result).toMatchObject({ ...NOTHING, blocklistKept: "other_node_locked" });
    expect((await blocklistRow(first.sha256))?.sourceNodeId).toBe(second.file.id);
    // The last clear undoes it.
    const last = await clear(op.as, second.reportId);
    expect(last.body.result.blocklistRemoved).toBe(true);
  });

  it("blocklistKept not_this_locks: the entry names another node as its source", async () => {
    const op = await admin();
    const owner = await member();
    const sha256 = madeUpSha();
    await testDb()
      .insert(hashBlocklist)
      .values({ sha256, reason: "csam", sourceNodeId: "0199d3c2-7a10-7000-8000-0000000000e9" });
    const { reportId } = await lockFile(owner, sha256);
    const answer = await clear(op.as, reportId);
    expect(answer.body.result).toMatchObject({ ...NOTHING, blocklistKept: "not_this_locks" });
    expect(await blocklistRow(sha256)).not.toBeNull();
  });

  it("blocklistKept edited: an admin changed the reason of this lock's entry after the lock", async () => {
    const op = await admin();
    const owner = await member();
    const { reportId, sha256 } = await lockFile(owner);
    await testDb().update(hashBlocklist).set({ reason: "admin" }).where(eq(hashBlocklist.sha256, sha256));
    const answer = await clear(op.as, reportId);
    expect(answer.body.result).toMatchObject({ ...NOTHING, blocklistKept: "edited" });
    expect((await blocklistRow(sha256))?.reason).toBe("admin");
  });

  it("no entry: all three empty", async () => {
    const op = await admin();
    const owner = await member();
    const { file, reportId, sha256 } = await lockFile(owner);
    await testDb().delete(hashBlocklist).where(eq(hashBlocklist.sha256, sha256));
    const answer = await clear(op.as, reportId);
    expect(answer.body.result).toMatchObject({ cleared: true, ...NOTHING });
    const [row] = await auditOf("admin.csam_lock_cleared", file.id);
    expect(row?.meta).toMatchObject({ blocklist: "none" });
  });

  it("ncmec/filed confirms the hash: clearing a twin leaves the entry csam (confirmed); control: without the filing the same content's entry is removed", async () => {
    const op = await admin();
    const owner = await member();
    const filedNode = await lockFile(owner);
    const twin = await lockFile(owner, filedNode.sha256);
    expect((await adminCall(op.as, "POST", `/reports/${filedNode.reportId}/ncmec/start`)).status).toBe(200);
    expect(
      (
        await adminCall(op.as, "POST", `/reports/${filedNode.reportId}/ncmec/filed`, {
          body: { reportId: "CT-3", filedAt: new Date(Date.now() - 3_600_000).toISOString() },
        })
      ).status,
    ).toBe(200);
    const kept = await clear(op.as, twin.reportId);
    expect(kept.body.result).toMatchObject({ ...NOTHING, blocklistKept: "confirmed" });
    expect((await blocklistRow(filedNode.sha256))?.reason).toBe("csam");

    // Control: the same two twins, nothing filed — clearing both removes the entry.
    const a = await lockFile(owner);
    const b = await lockFile(owner, a.sha256);
    await clear(op.as, a.reportId);
    const removed = await clear(op.as, b.reportId);
    expect(removed.body.result.blocklistRemoved).toBe(true);
    expect(await blocklistRow(a.sha256)).toBeNull();
  });
});

describe("refusals", () => {
  it.each(["clean", "under_review", "infected"] as const)(
    "a %s node (not suspected_csam) → 409, nothing written, nothing enqueued",
    async (scanStatus) => {
      const op = await admin();
      const owner = await member();
      const file = await makeFile(owner.id, null, { scanStatus, sha256: madeUpSha() });
      const reportId = await csamReportOn(file.id, owner.id);
      const answer = await clear(op.as, reportId);
      expect([answer.status, answer.body.details?.reason]).toEqual([409, "not_locked"]);
      expect((await nodeRowOf(file.id))!.scanStatus).toBe(scanStatus);
      expect((await reportRowOf(reportId))!.status).toBe("open");
      expect(await auditOf("scan.rescan_requested", file.id)).toHaveLength(0);
    },
  );

  it("no confirm (the preview), no 2FA, impersonated, no reason → the node stays locked, nothing audited", async () => {
    const op = await admin();
    const owner = await member();
    const { file, reportId, sha256 } = await lockFile(owner);
    const preview = await clear(op.as, reportId, false);
    expect(preview.body).toEqual({ confirmed: false, result: null, nodeStatus: "suspected_csam" });
    const body = { reason: "x", confirm: true };
    const no2fa = await adminCall(
      { ...op.as, secondFactorAt: null },
      "POST",
      `/reports/${reportId}/clear-lock`,
      {
        body,
      },
    );
    expect(no2fa.body.error).toBe("admin_requires_2fa");
    const imp = await adminCall(
      { ...op.as, impersonatedBy: baId() },
      "POST",
      `/reports/${reportId}/clear-lock`,
      {
        body,
      },
    );
    expect(imp.status).toBe(403);
    expect((await clear(op.as, reportId, true, null)).status).toBe(400);
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("suspected_csam");
    expect((await reportRowOf(reportId))!.status).toBe("open");
    expect(await blocklistRow(sha256)).not.toBeNull();
    expect(await auditOf("admin.csam_lock_cleared", file.id)).toHaveLength(0);
  });
});
