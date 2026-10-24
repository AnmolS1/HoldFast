// The console's own takedown, restore and node legal hold (safety-4, R1 ruling Q9): a file or a
// folder taken down with a typed reason (the CSAM variant also holds, folders only — a file is
// locked instead); a takedown that is NOT a copyright notice's restored from the quarantine item
// (a notice's takedown keeps its own restore: `409 dmca_restore_only`); the scanner's takedown
// for a dmca/admin blocklist hit restored together with that entry; a file's or folder's legal
// hold set and cleared. Every one audited, none deletes anything.
// Fixtures: fresh made-up hashes (Common addendum 3: the blocklist is shared by every file).
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminQuarantineDetailDto, QuarantineActionResponse } from "../../../src/shared/schemas/admin";
import { LegalHoldError } from "../../../src/worker/db/errors";
import { holdCausesOf } from "../../../src/worker/db/queries/admin";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { assertPurgeable } from "../../../src/worker/db/queries/trash";
import { nodes, strikes } from "../../../src/worker/db/schema";
import { eq } from "drizzle-orm";
import { api as nodesApi } from "../nodes/helpers";
import { openNoticeOn } from "../trash/helpers";
import {
  admin,
  adminCall,
  auditOf,
  blocklistRow,
  linkRowOf,
  lockedFile,
  madeUpSha,
  makeFile,
  makeFolder,
  makeLink,
  member,
  nodeRowOf,
  reported,
  testDb,
} from "./helpers";

type Admin = Awaited<ReturnType<typeof admin>>;

afterEach(() => {
  vi.useRealTimers();
});

const act = (who: Admin, nodeId: string, body: Record<string, unknown>, env?: Record<string, unknown>) =>
  adminCall(who.as, "POST", `/quarantine/${nodeId}`, { body, ...(env ? { env } : {}) });
const takedown = (who: Admin, nodeId: string, csam = false) =>
  act(who, nodeId, { action: "takedown", note: "Reported material.", ...(csam ? { csam: true } : {}) });
const restore = (who: Admin, nodeId: string, env?: Record<string, unknown>) =>
  act(who, nodeId, { action: "restore", note: "Taken down by mistake." }, env);
const hold = (who: Admin, nodeId: string, held: boolean) =>
  adminCall(who.as, "POST", `/quarantine/${nodeId}/legal-hold`, {
    body: { held, note: held ? "Lawsuit: notice 1." : "Matter ended." },
  });

const clean = (ownerId: string, parentId: string | null = null) =>
  makeFile(ownerId, parentId, { scanStatus: "clean", scannedAt: new Date(), sha256: madeUpSha() });

describe("restore of a takedown that is not a copyright notice's", () => {
  it("an abuse report's takedown → restored: visible to its owner again, its link unpaused, audited; the report strikes are offered, none lifted", async () => {
    const who = await admin();
    const owner = await member();
    const file = await clean(owner.id);
    const link = await makeLink(file.id, owner.id);
    const reportId = await reported(file.id, owner.id);
    const down = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "takedown", resolution: "Abuse confirmed." },
    });
    expect(down.status).toBe(200);
    expect((await nodesApi(owner.as, "GET", `/nodes/${file.id}`)).status).toBe(404);
    // A strike a report action gave for this file (as if struck as well): offered, not lifted.
    const [strike] = await testDb()
      .insert(strikes)
      .values({
        userId: owner.id,
        kind: "abuse",
        nodeId: file.id,
        reportId,
      })
      .returning();

    const answer = await restore(who, file.id);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.reportStrikeIds).toEqual([strike!.id]);
    expect(QuarantineActionResponse.safeParse(answer.body).success).toBe(true);
    expect(await nodeRowOf(file.id)).toMatchObject({
      takedownAt: null,
      takedownReason: null,
      takedownBy: null,
    });
    expect((await linkRowOf(link.id)).pauseReasons).toEqual([]);
    expect((await nodesApi(owner.as, "GET", `/nodes/${file.id}`)).status).toBe(200);
    expect(await auditOf("admin.takedown_restored", file.id)).toHaveLength(1);
    const [row] = await testDb().select().from(strikes).where(eq(strikes.id, strike!.id));
    expect(row!.liftedAt).toBeNull();
  });

  it("not taken down → 409 not_taken_down, nothing written", async () => {
    const who = await admin();
    const owner = await member();
    const file = await clean(owner.id);
    const answer = await restore(who, file.id);
    expect([answer.status, answer.body.error]).toEqual([409, "not_taken_down"]);
    expect(await auditOf("admin.takedown_restored", file.id)).toHaveLength(0);
  });

  it("a node a notice took down → 409 dmca_restore_only, nothing changed — also when the notice found it already down", async () => {
    const who = await admin();
    const owner = await member();
    // (a) the notice took it down.
    const a = await clean(owner.id);
    const noticeA = await openNoticeOn(a.id);
    const made = await adminCall(who.as, "POST", `/dmca/${noticeA}/action`, {
      body: { action: "takedown", note: "Complete." },
    });
    expect(made.status).toBe(200);
    // (b) down by an admin first; a notice then acted on it (its `took_down` is false).
    const b = await clean(owner.id);
    expect((await takedown(who, b.id)).status).toBe(200);
    const noticeB = await openNoticeOn(b.id);
    expect(
      (
        await adminCall(who.as, "POST", `/dmca/${noticeB}/action`, {
          body: { action: "takedown", note: "Complete." },
        })
      ).status,
    ).toBe(200);
    for (const node of [a, b]) {
      const before = await nodeRowOf(node.id);
      const answer = await restore(who, node.id);
      expect([answer.status, answer.body.error], node.id).toEqual([409, "dmca_restore_only"]);
      expect(await nodeRowOf(node.id)).toEqual(before);
    }
  });

  it("the scanner's takedown for a dmca/admin blocklist hit: restored and that entry removed (audited); a notice in force naming the content → 409 dmca_restore_only, the entry kept", async () => {
    const who = await admin();
    const owner = await member();
    for (const reason of ["dmca", "admin"] as const) {
      const file = await clean(owner.id);
      await blocklist.upsert(testDb(), { sha256: file.sha256!, reason });
      await testDb()
        .update(nodes)
        .set({ takedownAt: new Date(), takedownReason: reason, takedownBy: null })
        .where(eq(nodes.id, file.id));
      const answer = await restore(who, file.id);
      expect(answer.status, reason).toBe(200);
      expect(answer.body.blocklistRemoved, reason).toBe(true);
      expect(await blocklistRow(file.sha256!), reason).toBeNull();
      const [row] = await auditOf("admin.takedown_restored", file.id);
      expect(row!.meta, reason).toMatchObject({ blocklistRemoved: true });
    }
    // The control: the same content named by a notice that holds a takedown elsewhere.
    const elsewhere = await clean(owner.id);
    const file = await makeFile(owner.id, null, {
      scanStatus: "clean",
      scannedAt: new Date(),
      sha256: elsewhere.sha256,
    });
    const notice = await openNoticeOn(elsewhere.id);
    expect(
      (
        await adminCall(who.as, "POST", `/dmca/${notice}/action`, {
          body: { action: "takedown", note: "Complete." },
        })
      ).status,
    ).toBe(200);
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "dmca", takedownBy: null })
      .where(eq(nodes.id, file.id));
    const refused = await restore(who, file.id);
    expect([refused.status, refused.body.error]).toEqual([409, "dmca_restore_only"]);
    expect(await blocklistRow(file.sha256!)).toMatchObject({ reason: "dmca" });
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
  });

  it("restored while pending: one rescan is queued", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: madeUpSha() });
    expect((await takedown(who, file.id)).status).toBe(200);
    const sent: unknown[] = [];
    const answer = await restore(who, file.id, {
      SCAN_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    });
    expect(answer.status).toBe(200);
    expect(sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
  });
});

describe("takedown of a file or a folder", () => {
  it("a folder: everything under it hidden, every link in it paused `moderation`, audited; a second takedown → 409 already_taken_down", async () => {
    const who = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const child = await clean(owner.id, folder.id);
    const onFolder = await makeLink(folder.id, owner.id);
    const onChild = await makeLink(child.id, owner.id);
    const answer = await takedown(who, folder.id);
    expect(answer.status, answer.text).toBe(200);
    expect(await nodeRowOf(folder.id)).toMatchObject({
      takedownReason: "admin",
      takedownBy: who.id,
      legalHold: false,
    });
    expect((await nodesApi(owner.as, "GET", `/nodes/${child.id}`)).status).toBe(404);
    expect((await linkRowOf(onFolder.id)).pauseReasons).toEqual(["moderation"]);
    expect((await linkRowOf(onChild.id)).pauseReasons).toEqual(["moderation"]);
    expect(await auditOf("admin.takedown", folder.id)).toHaveLength(1);
    const again = await takedown(who, folder.id);
    expect([again.status, again.body.error]).toEqual([409, "already_taken_down"]);
    expect(await auditOf("admin.takedown", folder.id)).toHaveLength(1);
    // Restored: the child is back, both links unpaused.
    expect((await restore(who, folder.id)).status).toBe(200);
    expect((await nodesApi(owner.as, "GET", `/nodes/${child.id}`)).status).toBe(200);
    expect((await linkRowOf(onFolder.id)).pauseReasons).toEqual([]);
    expect((await linkRowOf(onChild.id)).pauseReasons).toEqual([]);
  });

  it("a folder as suspected CSAM: taken down AND held — a file under it cannot be purged; its restore waits for the hold to be cleared", async () => {
    const who = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const child = await clean(owner.id, folder.id);
    const answer = await takedown(who, folder.id, true);
    expect(answer.status, answer.text).toBe(200);
    expect(await nodeRowOf(folder.id)).toMatchObject({ takedownReason: "csam", legalHold: true });
    await expect(assertPurgeable(testDb(), [child.id])).rejects.toBeInstanceOf(LegalHoldError);

    const early = await restore(who, folder.id);
    expect([early.status, early.body.details?.reason]).toEqual([409, "held"]);
    expect((await nodeRowOf(folder.id))!.takedownReason).toBe("csam");
    expect((await hold(who, folder.id, false)).status).toBe(200);
    expect((await restore(who, folder.id)).status).toBe(200);
    expect(await nodeRowOf(folder.id)).toMatchObject({ takedownAt: null, legalHold: false });
  });

  it("a FILE as suspected CSAM → 409 use_lock (a file is locked), nothing written; a system node or an unknown id → 404", async () => {
    const who = await admin();
    const owner = await member();
    const file = await clean(owner.id);
    const answer = await takedown(who, file.id, true);
    expect([answer.status, answer.body.details?.reason]).toEqual([409, "use_lock"]);
    expect((await nodeRowOf(file.id))!.takedownAt).toBeNull();
    expect((await takedown(who, "01234567-89ab-7def-8123-456789abcdef")).status).toBe(404);
  });

  it("a reason is required (400, nothing written)", async () => {
    const who = await admin();
    const owner = await member();
    const file = await clean(owner.id);
    expect((await act(who, file.id, { action: "takedown" })).status).toBe(400);
    expect((await nodeRowOf(file.id))!.takedownAt).toBeNull();
  });
});

describe("a file's or a folder's legal hold", () => {
  it("set on a folder: everything under it is held (audited); cleared: released (audited)", async () => {
    const who = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const child = await clean(owner.id, folder.id);
    const set = await hold(who, folder.id, true);
    expect(set.status, set.text).toBe(200);
    expect(set.body.holds).toContain("node_legal_hold");
    expect(AdminQuarantineDetailDto.safeParse(set.body).success).toBe(true);
    expect(await holdCausesOf(testDb(), child.id)).toContain("inherited_legal_hold");
    await expect(assertPurgeable(testDb(), [child.id])).rejects.toBeInstanceOf(LegalHoldError);
    expect(await auditOf("admin.node_legal_hold_set", folder.id)).toHaveLength(1);
    const cleared = await hold(who, folder.id, false);
    expect(cleared.status).toBe(200);
    expect(await holdCausesOf(testDb(), child.id)).not.toContain("inherited_legal_hold");
    expect(await auditOf("admin.node_legal_hold_cleared", folder.id)).toHaveLength(1);
  });

  it("clearing the hold of a file locked as suspected CSAM → 409 hold_not_releasable, still held", async () => {
    const who = await admin();
    const t = await lockedFile();
    const answer = await hold(who, t.file.id, false);
    expect([answer.status, answer.body.details?.reason]).toEqual([409, "hold_not_releasable"]);
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(true);
  });
});
