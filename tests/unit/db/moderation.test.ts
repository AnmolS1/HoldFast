import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { lookup } from "../../../src/worker/db/queries/blocklist";
import { getById, pauseLinks } from "../../../src/worker/db/queries/links";
import {
  closeNotice,
  dismissReview,
  insertReport,
  lockSuspectedCsam,
  restoreTakedown,
  setNodeLegalHold,
  setUnderReview,
  setUserLegalHold,
  takedownNode,
} from "../../../src/worker/db/queries/moderation";
import { getNode } from "../../../src/worker/db/queries/nodes";
import { dmcaNotices, nodes, reports, type ScanStatus, uploadIps, user } from "../../../src/worker/db/schema";
import { makeFile, makeLink, makeUser, openDb, rand } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

async function reported(scanStatus: ScanStatus = "clean") {
  const owner = await makeUser(db);
  const file = await makeFile(db, owner, null, `m-${rand()}.bin`, { scanStatus });
  const link = await makeLink(db, file.id, owner);
  return { owner, file, link };
}

describe("setUnderReview / dismissReview", () => {
  it("saves the status, sets under_review and pauses the node's links with 'report'", async () => {
    const { file, link, owner } = await reported("skipped");
    const otherFile = await makeFile(db, owner, null, `other-${rand()}.bin`);
    const otherLink = await makeLink(db, otherFile.id, owner);

    expect(await setUnderReview(db, file.id)).toEqual({ changed: true });
    expect(await getNode(db, file.id)).toMatchObject({
      scanStatus: "under_review",
      scanStatusPrev: "skipped",
    });
    const paused = (await getById(db, link.id))!;
    expect(paused.pauseReasons).toEqual(["report"]);
    expect(paused.pausedAt).not.toBeNull();
    expect((await getById(db, otherLink.id))!.pauseReasons).toEqual([]);
  });

  it("twice keeps the first scanStatusPrev, and dismissReview restores it", async () => {
    const { file, link } = await reported("clean");
    expect(await setUnderReview(db, file.id)).toEqual({ changed: true });
    expect(await setUnderReview(db, file.id)).toEqual({ changed: false });
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "under_review", scanStatusPrev: "clean" });
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["report"]);

    expect(await dismissReview(db, file.id)).toEqual({ restored: "clean" });
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "clean", scanStatusPrev: null });
    expect(await getById(db, link.id)).toMatchObject({ pauseReasons: [], pausedAt: null });
    // Not under review any more: nothing to dismiss.
    expect(await dismissReview(db, file.id)).toEqual({ restored: null });
    expect(await dismissReview(db, uuidv7())).toEqual({ restored: null });
  });

  it("restores a pending node to pending, so the caller can re-enqueue its scan", async () => {
    const { file } = await reported("pending");
    await setUnderReview(db, file.id);
    expect(await dismissReview(db, file.id)).toEqual({ restored: "pending" });
  });

  it("changes nothing and pauses nothing for an infected or suspected_csam node", async () => {
    for (const status of ["infected", "suspected_csam"] as const) {
      const { file, link } = await reported(status);
      expect(await setUnderReview(db, file.id)).toEqual({ changed: false });
      expect(await getNode(db, file.id)).toMatchObject({ scanStatus: status, scanStatusPrev: null });
      expect(await getById(db, link.id)).toMatchObject({ pauseReasons: [], pausedAt: null });
    }
    expect(await setUnderReview(db, uuidv7())).toEqual({ changed: false });
  });

  it("dismissing a report cannot lift another pause on the same link", async () => {
    const { file, link } = await reported("clean");
    await pauseLinks(db, { linkId: link.id }, "owner_deletion");
    await setUnderReview(db, file.id);
    expect([...(await getById(db, link.id))!.pauseReasons].sort()).toEqual(["owner_deletion", "report"]);
    await dismissReview(db, file.id);
    const after = (await getById(db, link.id))!;
    expect(after.pauseReasons).toEqual(["owner_deletion"]);
    expect(after.pausedAt).not.toBeNull();
  });

  it("runs inside a caller's transaction and rolls back with it", async () => {
    const { file, link } = await reported("clean");
    await expect(
      db.transaction(async (tx) => {
        expect(await setUnderReview(tx, file.id)).toEqual({ changed: true });
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect((await getNode(db, file.id))!.scanStatus).toBe("clean");
    expect((await getById(db, link.id))!.pauseReasons).toEqual([]);
  });
});

describe("insertReport", () => {
  it("writes the tabled columns and returns the id", async () => {
    const { file, link, owner } = await reported();
    const reporter = await makeUser(db);
    const id = await insertReport(db, {
      nodeId: file.id,
      ownerId: owner,
      linkId: link.id,
      source: "user",
      category: "phishing",
      reporterUserId: reporter,
      reporterEmail: "Reporter@Example.test",
      reporterIpHashStable: "stable-hash",
      details: "looks like a fake bank page",
    });
    const [row] = await db.select().from(reports).where(eq(reports.id, id!));
    expect(row).toMatchObject({
      nodeId: file.id,
      ownerId: owner,
      linkId: link.id,
      source: "user",
      category: "phishing",
      reporterUserId: reporter,
      reporterEmail: "Reporter@Example.test",
      reporterIpHashStable: "stable-hash",
      details: "looks like a fake bank page",
      status: "open",
      assignedTo: null,
      resolvedAt: null,
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("drops a duplicate open report silently, inside a transaction, and accepts it again once resolved", async () => {
    const { file, owner } = await reported();
    const input = {
      nodeId: file.id,
      ownerId: owner,
      source: "user",
      category: "malware",
      reporterIpHashStable: `ip-${rand()}`,
    } as const;
    const first = await insertReport(db, input);
    expect(first).toEqual(expect.any(String));
    await db.transaction(async (tx) => {
      expect(await insertReport(tx, input)).toBeNull();
      // The transaction is still usable after the conflict.
      expect(await insertReport(tx, { ...input, category: "spam" })).toEqual(expect.any(String));
    });
    expect(await insertReport(db, { ...input, reporterIpHashStable: `ip-${rand()}` })).toEqual(
      expect.any(String),
    );
    await db.update(reports).set({ status: "reviewing" }).where(eq(reports.id, first!));
    expect(await insertReport(db, input)).toBeNull();
    await db.update(reports).set({ status: "dismissed" }).where(eq(reports.id, first!));
    expect(await insertReport(db, input)).toEqual(expect.any(String));
  });

  it("accepts an account-level system finding with no node", async () => {
    const owner = await makeUser(db);
    const id = await insertReport(db, {
      ownerId: owner,
      source: "system",
      category: "other",
      details: "many distinct addresses",
    });
    const [row] = await db.select().from(reports).where(eq(reports.id, id!));
    expect(row).toMatchObject({
      nodeId: null,
      linkId: null,
      ownerId: owner,
      source: "system",
      reporterIpHashStable: null,
    });
  });
});

describe("lockSuspectedCsam", () => {
  it("locks the node and the owner, pauses links, holds upload IPs, blocklists the hash and files one report", async () => {
    const { file, link, owner } = await reported("pending");
    await db.insert(uploadIps).values({
      nodeId: file.id,
      versionId: file.versionId!,
      uploaderId: owner,
      ipEncrypted: Buffer.from("c"),
      iv: Buffer.from("i"),
      keyVersion: 1,
    });
    const result = await lockSuspectedCsam(db, file.id, { source: "photodna" });
    expect(result).toEqual({ reportId: expect.any(String), ownerId: owner });

    expect(await getNode(db, file.id)).toMatchObject({
      scanStatus: "suspected_csam",
      legalHold: true,
      r2Key: file.r2Key,
    });
    const [account] = await db.select({ legalHold: user.legalHold }).from(user).where(eq(user.id, owner));
    expect(account!.legalHold).toBe(true);
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["moderation"]);
    const [ip] = await db.select().from(uploadIps).where(eq(uploadIps.nodeId, file.id));
    expect(ip!.legalHold).toBe(true);
    expect(await lookup(db, file.sha256!)).toEqual({ reason: "csam", sourceNodeId: file.id });
    const filed = await db
      .select()
      .from(reports)
      .where(and(eq(reports.nodeId, file.id), eq(reports.category, "csam")));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      id: result!.reportId,
      source: "photodna",
      ownerId: owner,
      status: "open",
    });

    // Repeating it (a redelivery, or an admin confirming) files no second report.
    const again = await lockSuspectedCsam(db, file.id, { source: "admin" });
    expect(again!.reportId).toBe(result!.reportId);
    expect(await db.select().from(reports).where(eq(reports.nodeId, file.id))).toHaveLength(1);
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["moderation"]);
    expect(await lockSuspectedCsam(db, uuidv7(), { source: "system" })).toBeNull();
    await db.update(user).set({ legalHold: false }).where(eq(user.id, owner));
  });

  it("is all or nothing", async () => {
    const { file, link, owner } = await reported("clean");
    await expect(
      db.transaction(async (tx) => {
        await lockSuspectedCsam(tx, file.id, { source: "system" });
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "clean", legalHold: false });
    const [account] = await db.select({ legalHold: user.legalHold }).from(user).where(eq(user.id, owner));
    expect(account!.legalHold).toBe(false);
    expect((await getById(db, link.id))!.pauseReasons).toEqual([]);
    expect(await lookup(db, file.sha256!)).toBeNull();
  });
});

describe("takedown, notices and holds", () => {
  it("takedownNode sets the three columns; csam also sets the hold; restoreTakedown clears them", async () => {
    const { file } = await reported();
    const admin = await makeUser(db);
    expect(await takedownNode(db, file.id, { reason: "dmca", by: admin })).toBe(true);
    const down = (await getNode(db, file.id))!;
    expect(down).toMatchObject({ takedownReason: "dmca", takedownBy: admin, legalHold: false });
    expect(down.takedownAt).toBeInstanceOf(Date);
    expect(await restoreTakedown(db, file.id)).toBe(true);
    expect(await getNode(db, file.id)).toMatchObject({
      takedownAt: null,
      takedownReason: null,
      takedownBy: null,
    });
    expect(await restoreTakedown(db, file.id)).toBe(false);

    expect(await takedownNode(db, file.id, { reason: "csam", by: null })).toBe(true);
    expect(await getNode(db, file.id)).toMatchObject({
      takedownReason: "csam",
      takedownBy: null,
      legalHold: true,
    });
    await restoreTakedown(db, file.id);
    expect((await getNode(db, file.id))!.legalHold).toBe(true);
    expect(await takedownNode(db, uuidv7(), { reason: "admin", by: null })).toBe(false);
  });

  it("closeNotice moves an open notice to a terminal status, once", async () => {
    const [notice] = await db
      .insert(dmcaNotices)
      .values({ receivedVia: "form", status: "actioned" })
      .returning();
    expect(await closeNotice(db, notice!.id, "closed")).toBe(true);
    const [after] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, notice!.id));
    expect(after!.status).toBe("closed");
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(notice!.updatedAt.getTime());
    expect(await closeNotice(db, notice!.id, "withdrawn")).toBe(false);
    expect(await closeNotice(db, uuidv7(), "closed")).toBe(false);
  });

  it("the legal-hold setters set and release", async () => {
    const { file, owner } = await reported();
    expect(await setNodeLegalHold(db, file.id, true)).toBe(true);
    expect((await getNode(db, file.id))!.legalHold).toBe(true);
    expect(await setNodeLegalHold(db, file.id, false)).toBe(true);
    expect((await getNode(db, file.id))!.legalHold).toBe(false);
    expect(await setUserLegalHold(db, owner, true)).toBe(true);
    const [held] = await db.select({ legalHold: user.legalHold }).from(user).where(eq(user.id, owner));
    expect(held!.legalHold).toBe(true);
    expect(await setUserLegalHold(db, owner, false)).toBe(true);
    expect(await setUserLegalHold(db, "nobody", true)).toBe(false);
    expect(await setNodeLegalHold(db, uuidv7(), true)).toBe(false);
    expect((await db.select().from(nodes).where(eq(nodes.id, file.id)))[0]!.legalHold).toBe(false);
  });
});
