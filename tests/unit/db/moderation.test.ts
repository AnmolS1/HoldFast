import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { lookup } from "../../../src/worker/db/queries/blocklist";
import { getById, pauseLinks } from "../../../src/worker/db/queries/links";
import {
  closeNotice,
  csamReportsToAnnounce,
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
import {
  dmcaNotices,
  downloadLedger,
  nodes,
  reports,
  type ScanStatus,
  uploadIps,
  user,
} from "../../../src/worker/db/schema";
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

describe("csamReportsToAnnounce", () => {
  /** A locked file and its open `csam` report, filed `ageMinutes` ago. */
  async function lockedReport(ageMinutes: number) {
    const { file } = await reported("pending");
    const { reportId } = (await lockSuspectedCsam(db, file.id, { source: "system" }))!;
    await db
      .update(reports)
      .set({ createdAt: sql`(now() AT TIME ZONE 'UTC') - make_interval(mins => ${ageMinutes})` })
      .where(eq(reports.id, reportId));
    return { reportId, nodeId: file.id, source: "system" as const, lockRecorded: false };
  }
  /** The alert marker of a report, claimed `daysAgo` days ago (0 = today, the database's day). */
  const mark = (
    reportId: string,
    daysAgo: number,
    count = 1,
    what: "csam_alert" | "csam_locked" = "csam_alert",
  ) =>
    db.insert(downloadLedger).values({
      day: sql`((now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int)`,
      subjectType: "notice",
      subjectId: `${what}:${reportId}`,
      bytes: 0,
      count,
    });
  /** Of everything due (the table is shared with other tests), the rows this test made, in order. */
  const dueAmong = async (mine: { reportId: string }[]) => {
    const ids = new Set(mine.map((row) => row.reportId));
    return (await csamReportsToAnnounce(db, 100_000)).filter((row) => ids.has(row.reportId));
  };

  it("lists open csam reports nobody was told about today, oldest first, with the node", async () => {
    const newer = await lockedReport(10);
    const oldest = await lockedReport(30);
    const middle = await lockedReport(20);
    expect(await dueAmong([newer, oldest, middle])).toEqual([oldest, middle, newer]);
  });

  it("only `open`: a report being reviewed, actioned or dismissed is not listed", async () => {
    const open = await lockedReport(5);
    const others = [];
    for (const status of ["reviewing", "actioned", "dismissed"] as const) {
      const report = await lockedReport(5);
      await db.update(reports).set({ status }).where(eq(reports.id, report.reportId));
      others.push(report);
    }
    expect(await dueAmong([open, ...others])).toEqual([open]);
  });

  it("only category `csam`: an open report of another category is not listed", async () => {
    const csam = await lockedReport(5);
    const { file, owner } = await reported();
    const other = await insertReport(db, {
      nodeId: file.id,
      ownerId: owner,
      source: "user",
      category: "phishing",
    });
    expect(await dueAmong([csam, { reportId: other! }])).toEqual([csam]);
  });

  it("today's claimed marker takes a report off the list; yesterday's, another report's, or an unclaimed one does not", async () => {
    // Four days old, like their lock markers below: a marker is claimed during its report's life.
    const old = 4 * 1440;
    const toldToday = await lockedReport(old + 5);
    const toldYesterday = { ...(await lockedReport(old + 4)), lockRecorded: true };
    const unclaimed = { ...(await lockedReport(old + 3)), lockRecorded: true };
    const untold = { ...(await lockedReport(old + 2)), lockRecorded: true };
    // Every lock here was recorded (on some earlier day), so only the alert decides.
    for (const report of [toldToday, toldYesterday, unclaimed, untold]) {
      await mark(report.reportId, 3, 1, "csam_locked");
    }
    await mark(toldToday.reportId, 0);
    await mark(toldYesterday.reportId, 1);
    await mark(unclaimed.reportId, 0, 0);
    expect(await dueAmong([toldToday, toldYesterday, unclaimed, untold])).toEqual([
      toldYesterday,
      unclaimed,
      untold,
    ]);
  });

  it("a lock that was NEVER recorded keeps a report listed even when the operators were told today; a lock recorded on any day does not", async () => {
    const neverRecorded = await lockedReport(4);
    // Nine days old, recorded the day it was filed.
    const recordedDaysAgo = await lockedReport(9 * 1440 + 3);
    const zeroCountRow = await lockedReport(2);
    for (const report of [neverRecorded, recordedDaysAgo, zeroCountRow]) await mark(report.reportId, 0);
    await mark(recordedDaysAgo.reportId, 9, 1, "csam_locked");
    await mark(zeroCountRow.reportId, 0, 0, "csam_locked");
    // Told today, all three: what is still owed is the lock's record, for two of them.
    expect(await dueAmong([neverRecorded, recordedDaysAgo, zeroCountRow])).toEqual([
      neverRecorded,
      zeroCountRow,
    ]);
    // The row carries the report's own source.
    const { file } = await reported("pending");
    const { reportId } = (await lockSuspectedCsam(db, file.id, { source: "photodna" }))!;
    expect(await dueAmong([{ reportId }])).toEqual([
      { reportId, nodeId: file.id, source: "photodna", lockRecorded: false },
    ]);
  });

  it("the lock's record is looked for from the report's own day on: old rows of other subjects do not count, and nothing is read from before the report existed", async () => {
    const day = 1440;
    const told = async (ageMinutes: number) => {
      const report = await lockedReport(ageMinutes);
      await mark(report.reportId, 0);
      return report;
    };
    // An old, unrelated ledger row — another report's lock marker, a year back — says nothing
    // about this report.
    const besideOldRow = await told(5);
    await mark(uuidv7(), 400, 1, "csam_locked");
    await db.insert(downloadLedger).values({
      day: sql`((now() AT TIME ZONE 'UTC')::date - 400)`,
      subjectType: "notice",
      subjectId: `unrelated:${besideOldRow.reportId}`,
      bytes: 0,
      count: 1,
    });
    // Recorded on the day the report was filed, thirty days ago: found.
    const recordedAtFiling = await told(30 * day + 4);
    await mark(recordedAtFiling.reportId, 30, 1, "csam_locked");
    // Recorded yesterday, for a report filed thirty days ago (the sweep caught up): found.
    const recordedLater = await told(30 * day + 3);
    await mark(recordedLater.reportId, 1, 1, "csam_locked");
    // THE BOUND: a row dated long before the report existed is outside what is read. (No such
    // row can be written — the marker's id is the report's — which is why the scan may skip it.)
    const before = await told(2);
    await mark(before.reportId, 60, 1, "csam_locked");

    expect(await dueAmong([besideOldRow, recordedAtFiling, recordedLater, before])).toEqual([
      besideOldRow,
      before,
    ]);
  });

  it("returns at most `limit` rows and writes nothing", async () => {
    const a = await lockedReport(2);
    const b = await lockedReport(1);
    expect(await csamReportsToAnnounce(db, 1)).toHaveLength(1);
    expect((await csamReportsToAnnounce(db, 2)).length).toBe(2);
    // Read-only: asked twice, the same reports are still due and no marker appeared.
    expect(await dueAmong([a, b])).toEqual([a, b]);
    const markers = await db
      .select()
      .from(downloadLedger)
      .where(eq(downloadLedger.subjectId, `csam_alert:${a.reportId}`));
    expect(markers).toEqual([]);
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
