// The R2 moderation delta (rd-mod mod-1, mod-3, mod-4, mod-5), each the rd-mod probe that showed
// the defect, turned round:
//   - "Restore takedown" never makes servable a file whose server hash is listed as suspected CSAM
//     (or malware) — also when a lock RAISES the entry between the restore's read and its removal;
//   - "Delete now" purges only what the quarantine holds for a reason of its own: an admin's or a
//     report's takedown does not make any file or folder deletable (safety-7);
//   - "Release holds" keeps a node hold an admin set by hand;
//   - clearing a node's legal hold from the console also releases the uploader addresses the lock
//     held, so they age out on the normal 90-day rule once nothing else keeps them.
// Fixtures: fresh made-up hashes (Common addendum 3: the blocklist is shared by every file).
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { listAsLocked } from "../../../src/worker/db/queries/moderation";
import { expired } from "../../../src/worker/db/queries/upload-ips";
import { nodes, uploadIps } from "../../../src/worker/db/schema";
import { adminHooks } from "../../../src/worker/services/admin-actions";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { api as nodesApi } from "../nodes/helpers";
import {
  addressRows,
  admin,
  adminCall,
  auditOf,
  blocklistRow,
  lockedFile,
  madeUpSha,
  makeFile,
  makeFolder,
  member,
  nodeRowOf,
  operators,
  reported,
  serviceDeps,
  testDb,
  userRowOf,
} from "./helpers";

type Admin = Awaited<ReturnType<typeof admin>>;

afterEach(() => {
  adminHooks.beforeRestoreEntryRemoval = null;
});

const act = (who: Admin, nodeId: string, body: Record<string, unknown>) =>
  adminCall(who.as, "POST", `/quarantine/${nodeId}`, { body });
const restore = (who: Admin, nodeId: string) =>
  act(who, nodeId, { action: "restore", note: "Taken down by mistake." });
const takedown = (who: Admin, nodeId: string) =>
  act(who, nodeId, { action: "takedown", note: "Reported material." });
const remove = (who: Admin, nodeId: string) => act(who, nodeId, { action: "delete", note: "Delete it." });
const nodeHold = (who: Admin, nodeId: string, held: boolean) =>
  adminCall(who.as, "POST", `/quarantine/${nodeId}/legal-hold`, {
    body: { held, note: held ? "Lawsuit: notice 1." : "Matter ended." },
  });
const clearLock = (who: Admin, reportId: string) =>
  adminCall(who.as, "POST", `/reports/${reportId}/clear-lock`, {
    body: { reason: "Listed in error.", confirm: true },
  });
const releaseHolds = (who: Admin, reportId: string) =>
  adminCall(who.as, "POST", `/reports/${reportId}/release-holds`, {
    body: { reason: "Dismissed, never filed.", confirm: true },
  });

const scannedClean = (ownerId: string, sha256 = madeUpSha(), extra: Record<string, unknown> = {}) =>
  makeFile(ownerId, null, { scanStatus: "clean", scannedAt: new Date(), sha256, ...extra });

/** Taken down by the scanner for a blocklist hit (`takedownBy` null), the entry listed `reason`. */
async function scannerTakedown(ownerId: string, reason: "admin" | "dmca") {
  const file = await scannedClean(ownerId);
  await blocklist.upsert(testDb(), { sha256: file.sha256!, reason });
  await testDb()
    .update(nodes)
    .set({ takedownAt: new Date(), takedownReason: reason, takedownBy: null })
    .where(eq(nodes.id, file.id));
  return file;
}

describe("mod-1: a restore never serves content whose server hash is listed csam (or malware)", () => {
  it("the scanner's admin-hit takedown, its hash then RAISED to csam by another account's lock → 409 content_listed; still down, the entry still csam, the owner still gets 404", async () => {
    const who = await admin();
    const owner = await member();
    const a = await scannerTakedown(owner.id, "admin");
    const other = await member();
    const b = await scannedClean(other.id, a.sha256!, { createdBy: other.id });
    const service = serviceDeps(operators().env);
    await lockSuspectedCsam(service.deps, b.id, { source: "admin", onlyVerifiedHash: true });
    await service.settle();
    expect((await blocklistRow(a.sha256!))?.reason).toBe("csam");

    const answer = await restore(who, a.id);
    expect([answer.status, answer.body.details?.reason], answer.text).toEqual([409, "content_listed"]);
    expect(answer.body.details?.listed).toBe("csam");
    expect((await nodeRowOf(a.id))!.takedownAt).not.toBeNull();
    expect((await blocklistRow(a.sha256!))?.reason).toBe("csam");
    expect((await nodesApi(owner.as, "GET", `/nodes/${a.id}`)).status).toBe(404);
    expect(await auditOf("admin.takedown_restored", a.id)).toHaveLength(0);
  });

  it("an admin's takedown (no blocklist hit) whose hash was listed csam / malware since → 409 content_listed; control: not listed → restored", async () => {
    const who = await admin();
    const owner = await member();
    for (const reason of ["csam", "malware"] as const) {
      const file = await scannedClean(owner.id);
      expect((await takedown(who, file.id)).status).toBe(200);
      if (reason === "csam") await blocklist.confirmCsam(testDb(), file.sha256!);
      else await blocklist.upsert(testDb(), { sha256: file.sha256!, reason });
      const answer = await restore(who, file.id);
      expect([answer.status, answer.body.details?.reason], reason).toEqual([409, "content_listed"]);
      expect((await nodeRowOf(file.id))!.takedownAt, reason).not.toBeNull();
    }
    const control = await scannedClean(owner.id);
    expect((await takedown(who, control.id)).status).toBe(200);
    expect((await restore(who, control.id)).status).toBe(200);
    expect((await nodeRowOf(control.id))!.takedownAt).toBeNull();
  });

  it("the race: a lock raises the entry between the restore's read and its removal → 409 content_listed, nothing restored, the raised entry kept", async () => {
    const who = await admin();
    const owner = await member();
    const a = await scannerTakedown(owner.id, "admin");
    const other = await member();
    const b = await scannedClean(other.id, a.sha256!, { createdBy: other.id });
    let raised = false;
    adminHooks.beforeRestoreEntryRemoval = async () => {
      // Another connection, committed at once: the raise a concurrent lock of B writes.
      await listAsLocked(testDb(), a.sha256!, b.id);
      raised = true;
    };
    const answer = await restore(who, a.id);
    expect(raised).toBe(true);
    expect([answer.status, answer.body.details?.reason], answer.text).toEqual([409, "content_listed"]);
    expect(await nodeRowOf(a.id)).toMatchObject({ takedownReason: "admin", takedownBy: null });
    expect((await nodeRowOf(a.id))!.takedownAt).not.toBeNull();
    expect(await blocklistRow(a.sha256!)).toMatchObject({ reason: "csam", raisedFrom: "admin" });
    expect(await auditOf("admin.takedown_restored", a.id)).toHaveLength(0);
  });
});

describe("mod-3: Take down then Delete now does not purge anyone's clean item (safety-7)", () => {
  it("a clean folder taken down from the console → Delete now 409 not_quarantined, the folder and its child kept", async () => {
    const who = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id, null);
    const child = await scannedClean(owner.id, madeUpSha(), { parentId: folder.id });
    expect((await takedown(who, folder.id)).status).toBe(200);
    const answer = await remove(who, folder.id);
    expect([answer.status, answer.body.error], answer.text).toEqual([409, "not_quarantined"]);
    expect(await nodeRowOf(folder.id)).not.toBeNull();
    expect(await nodeRowOf(child.id)).not.toBeNull();
    expect(await auditOf("admin.node_purged", folder.id)).toHaveLength(0);
  });

  it("a clean file taken down on a report (abuse) → Delete now 409 not_quarantined, kept", async () => {
    const who = await admin();
    const owner = await member();
    const file = await scannedClean(owner.id);
    const reportId = await reported(file.id, owner.id);
    const down = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "takedown", resolution: "Abuse confirmed." },
    });
    expect(down.status).toBe(200);
    const answer = await remove(who, file.id);
    expect([answer.status, answer.body.error], answer.text).toEqual([409, "not_quarantined"]);
    expect(await nodeRowOf(file.id)).not.toBeNull();
  });
});

describe("mod-4 / mod-5: a node hold set by hand, and the uploader addresses a lock held", () => {
  it("mod-4: a node hold set by hand after a lock was cleared is KEPT by Release holds (set_by_hand); the users are released", async () => {
    const who = await admin();
    const t = await lockedFile();
    expect((await clearLock(who, t.reportId)).status).toBe(200);
    // Set by hand while the lock's hold is still on the row: no change written, but it is the operator's now.
    expect((await nodeHold(who, t.file.id, true)).status).toBe(200);
    const released = await releaseHolds(who, t.reportId);
    expect(released.status, released.text).toBe(200);
    expect(released.body.node).toEqual({ released: false, keptBecause: "set_by_hand" });
    expect(released.body.releasedUserIds).toEqual([t.owner.id]);
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(true);
    expect((await userRowOf(t.owner.id))!.legalHold).toBe(false);
    // Cleared by hand: then it goes.
    expect((await nodeHold(who, t.file.id, false)).status).toBe(200);
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(false);
  });

  it("mod-4 control: a hold set by hand and cleared by hand again is the lock's — Release holds releases it", async () => {
    const who = await admin();
    const t = await lockedFile();
    expect((await clearLock(who, t.reportId)).status).toBe(200);
    expect((await nodeHold(who, t.file.id, true)).status).toBe(200);
    expect((await nodeHold(who, t.file.id, false)).status).toBe(200);
    // (Cleared by hand: the lock's hold went with it.)
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(false);
    const released = await releaseHolds(who, t.reportId);
    expect(released.body.node).toEqual({ released: false, keptBecause: null });
  });

  it("mod-5: Clear lock, then the console's Clear legal hold (not Release holds): the address rows are released with it — and once the account holds go, they age out after 90 days", async () => {
    const who = await admin();
    const t = await lockedFile();
    expect((await addressRows(t.file.id)).map((r) => r.legalHold)).toEqual([true]);
    expect((await clearLock(who, t.reportId)).status).toBe(200);
    const cleared = await nodeHold(who, t.file.id, false);
    expect(cleared.status, cleared.text).toBe(200);
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(false);
    expect((await addressRows(t.file.id)).map((r) => r.legalHold)).toEqual([false]);
    const [row] = await auditOf("admin.node_legal_hold_cleared", t.file.id);
    expect(row!.meta).toMatchObject({ uploadIps: 1 });

    // The account hold the lock set, cleared on the Users page; the row is far past 90 days.
    const user = await adminCall(who.as, "POST", `/users/${t.owner.id}/legal-hold`, {
      body: { held: false, note: "Matter ended." },
    });
    expect(user.status, user.text).toBe(200);
    const [address] = await addressRows(t.file.id);
    await testDb()
      .update(uploadIps)
      .set({ at: new Date("1971-01-01T00:00:00.000Z") })
      .where(eq(uploadIps.id, address!.id));
    expect(await expired(testDb(), 1_000)).toContain(address!.id);
  });

  it("mod-4 + mod-5: Release holds keeps a hand-set node hold but releases the address flags; the node hold alone keeps them until it is cleared by hand", async () => {
    const who = await admin();
    const t = await lockedFile();
    expect((await clearLock(who, t.reportId)).status).toBe(200);
    expect((await nodeHold(who, t.file.id, true)).status).toBe(200);
    const released = await releaseHolds(who, t.reportId);
    expect(released.body.uploadIpsReleased).toBe(1);
    const [address] = await addressRows(t.file.id);
    expect(address!.legalHold).toBe(false);
    await testDb()
      .update(uploadIps)
      .set({ at: new Date("1971-01-01T00:00:00.000Z") })
      .where(eq(uploadIps.id, address!.id));
    // Kept by the node's hold (the purge gate's view of the node).
    expect(await expired(testDb(), 1_000)).not.toContain(address!.id);
    expect((await nodeHold(who, t.file.id, false)).status).toBe(200);
    expect(await expired(testDb(), 1_000)).toContain(address!.id);
  });
});
