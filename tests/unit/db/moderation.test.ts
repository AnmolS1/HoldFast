import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { confirmCsam, lookup, upsert } from "../../../src/worker/db/queries/blocklist";
import { getById, pauseLinks, unpauseLinks } from "../../../src/worker/db/queries/links";
import {
  clearSuspectedCsam,
  closeNotice,
  csamReportsToAnnounce,
  csamSubjects,
  dismissReview,
  insertReport,
  lockSuspectedCsam,
  restoreTakedown,
  setNodeLegalHold,
  setUnderReview,
  setUserLegalHold,
  takedownNode,
} from "../../../src/worker/db/queries/moderation";
import { getNode, replaceVersion } from "../../../src/worker/db/queries/nodes";
import {
  dmcaNotices,
  downloadLedger,
  hashBlocklist,
  nodes,
  nodeVersions,
  reports,
  type ScanStatus,
  uploadIps,
  user,
} from "../../../src/worker/db/schema";
import { baId, makeFile, makeFolder, makeLink, makeUser, openDb, rand } from "./_helpers";

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

  it("repeated on a node whose csam report was FILED it returns that report and opens no second one; after a dismissed one it is a new case", async () => {
    const { file } = await reported("clean");
    const first = (await lockSuspectedCsam(db, file.id, { source: "photodna" }))!;
    await db.update(reports).set({ status: "actioned" }).where(eq(reports.id, first.reportId));
    const csamReports = async () =>
      (
        await db
          .select()
          .from(reports)
          .where(and(eq(reports.nodeId, file.id), eq(reports.category, "csam")))
      )
        .map((r) => r.id)
        .sort();

    // A redelivered verdict on the reported node.
    expect(await lockSuspectedCsam(db, file.id, { source: "photodna" })).toMatchObject({
      reportId: first.reportId,
    });
    expect(await csamReports()).toEqual([first.reportId]);

    // A report that is still being worked on comes before the filed one.
    const open = (await insertReport(db, {
      nodeId: file.id,
      source: "user",
      category: "csam",
      reporterIpHashStable: `ip-${rand()}`,
    }))!;
    expect((await lockSuspectedCsam(db, file.id, { source: "system" }))!.reportId).toBe(open);

    // The control: with every csam report on the node dismissed, a lock is a new case.
    await db.update(reports).set({ status: "dismissed" }).where(eq(reports.nodeId, file.id));
    const fresh = (await lockSuspectedCsam(db, file.id, { source: "system" }))!;
    expect([first.reportId, open]).not.toContain(fresh.reportId);
    expect(await csamReports()).toHaveLength(3);
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

  const heldUsers = async (ids: string[]) =>
    (
      await db
        .select({ id: user.id })
        .from(user)
        .where(and(inArray(user.id, ids), eq(user.legalHold, true)))
    )
      .map((r) => r.id)
      .sort();
  const ipRow = (nodeId: string, uploaderId: string, versionId = "v") => ({
    nodeId,
    versionId,
    uploaderId,
    ipEncrypted: Buffer.from("c"),
    iv: Buffer.from("i"),
    keyVersion: 1,
  });

  /**
   * Owner O's folder; editor E1 uploads a file into it, editor E2 replaces its contents. E3 is on
   * record only through an uploader address (their version is long purged). `bystander` has
   * nothing to do with the file.
   */
  async function replacedByEditors() {
    const owner = await makeUser(db);
    const [e1, e2, e3, bystander] = [
      await makeUser(db),
      await makeUser(db),
      await makeUser(db),
      await makeUser(db),
    ];
    const folder = await makeFolder(db, owner, null, `shared-${rand()}`);
    const file = await makeFile(db, owner, folder.id, `up-${rand()}.jpg`, { createdBy: e1 });
    await replaceVersion(db, file.id, {
      r2Key: `u/${owner}/${file.id}/v2`,
      versionId: "v2",
      size: 9,
      sha256: rand(32),
      createdBy: e2,
    });
    await db.insert(uploadIps).values(ipRow(file.id, e3, "v0"));
    return { owner, e1, e2, e3, bystander, folder, file };
  }

  it("holds every uploader of any version too: the editor who uploaded, the one who replaced, and one known only by an uploader address", async () => {
    const f = await replacedByEditors();
    const everyone = [f.owner, f.e1, f.e2, f.e3, f.bystander];
    // Each is known through ONE column: E2 is the current version's uploader (`nodes`), E1 the
    // replaced version's (`node_versions`), E3 only an address row's (`upload_ips`).
    expect((await getNode(db, f.file.id))!.createdBy).toBe(f.e2);
    expect(
      (await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, f.file.id))).map(
        (v) => v.createdBy,
      ),
    ).toEqual([f.e1]);
    expect(await heldUsers(everyone)).toEqual([]);

    const subjects = await csamSubjects(db, f.file.id);
    expect(subjects).toEqual({
      nodeId: f.file.id,
      ownerId: f.owner,
      uploaderIds: [f.e1, f.e2, f.e3].sort(),
    });

    const result = await lockSuspectedCsam(db, f.file.id, { source: "photodna" });
    expect(result).toEqual({ reportId: expect.any(String), ownerId: f.owner });
    expect(await getNode(db, f.file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await heldUsers(everyone)).toEqual([f.owner, f.e1, f.e2, f.e3].sort());
    // `csamSubjects` IS the set the lock held — what "Release holds" will release.
    expect(await heldUsers(everyone)).toEqual(
      [...new Set([subjects!.ownerId!, ...subjects!.uploaderIds])].sort(),
    );
    // Held is not banned.
    const accounts = await db.select({ banned: user.banned }).from(user).where(inArray(user.id, everyone));
    expect(accounts.every((u) => u.banned !== true)).toBe(true);
    // The folder the file sits in is not the subject.
    expect((await getNode(db, f.folder.id))!.legalHold).toBe(false);

    // Idempotent: the same report, the same holds, the same subjects.
    const again = await lockSuspectedCsam(db, f.file.id, { source: "admin" });
    expect(again).toEqual(result);
    expect(await heldUsers(everyone)).toEqual([f.owner, f.e1, f.e2, f.e3].sort());
    expect(await csamSubjects(db, f.file.id)).toEqual(subjects);
  });

  it("the control: an owner who uploaded their own file — exactly the owner and the node are held", async () => {
    const { file, owner } = await reported("clean");
    const bystander = await makeUser(db);
    const other = await makeFile(db, owner, null, `other-${rand()}.bin`);
    await db.insert(uploadIps).values(ipRow(file.id, owner));
    // An address row of the bystander for ANOTHER file of the same owner is not this file's.
    await db.insert(uploadIps).values(ipRow(other.id, bystander));
    expect(await csamSubjects(db, file.id)).toEqual({
      nodeId: file.id,
      ownerId: owner,
      uploaderIds: [owner],
    });
    await lockSuspectedCsam(db, file.id, { source: "system" });
    expect(await heldUsers([owner, bystander])).toEqual([owner]);
    expect((await getNode(db, file.id))!.legalHold).toBe(true);
    expect((await getNode(db, other.id))!.legalHold).toBe(false);
  });

  it("an uploader who is gone — anonymised, or an address row whose account was deleted — is skipped without a throw", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `anon-${rand()}.bin`, { createdBy: null });
    await db.insert(nodeVersions).values({
      nodeId: file.id,
      versionId: "old",
      r2Key: `k/${rand()}`,
      size: 1,
      createdBy: null,
      purgeAfter: new Date(Date.now() + 86_400_000),
    });
    const goneId = baId();
    await db.insert(uploadIps).values(ipRow(file.id, goneId));
    expect(await csamSubjects(db, file.id)).toEqual({ nodeId: file.id, ownerId: owner, uploaderIds: [] });
    expect(await lockSuspectedCsam(db, file.id, { source: "system" })).toMatchObject({ ownerId: owner });
    expect(await heldUsers([owner])).toEqual([owner]);
    // The gone uploader's address is still held with the node's rows.
    expect((await db.select().from(uploadIps).where(eq(uploadIps.nodeId, file.id)))[0]!.legalHold).toBe(true);
    expect(await db.select().from(user).where(eq(user.id, goneId))).toEqual([]);
  });

  it("csamSubjects is null for an unknown or malformed id", async () => {
    expect(await csamSubjects(db, uuidv7())).toBeNull();
    expect(await csamSubjects(db, "nope")).toBeNull();
  });
});

describe("clearSuspectedCsam", () => {
  /** A locked file with a link, an uploader address and its open report. */
  async function locked() {
    const { file, link, owner } = await reported("clean");
    await db.insert(uploadIps).values({
      nodeId: file.id,
      versionId: file.versionId!,
      uploaderId: owner,
      ipEncrypted: Buffer.from("c"),
      iv: Buffer.from("i"),
      keyVersion: 1,
    });
    const { reportId } = (await lockSuspectedCsam(db, file.id, { source: "photodna" }))!;
    return { file, link, owner, reportId };
  }
  const reportRow = async (id: string) => (await db.select().from(reports).where(eq(reports.id, id)))[0]!;

  it("puts the node back to pending — never clean — and reports what it did", async () => {
    const { file, reportId } = await locked();
    expect(await clearSuspectedCsam(db, file.id)).toEqual({
      cleared: true,
      refused: null,
      blocklistRemoved: true,
      blocklistRestoredTo: null,
      blocklistKept: null,
      reportIds: [reportId],
    });
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "pending", scanStatusPrev: null });
  });

  it("clears the verdict that came with the lock — what a rescan clears — whichever status the node goes back to", async () => {
    for (const otherCase of [false, true]) {
      const { file, owner } = await locked();
      await db
        .update(nodes)
        .set({
          scanReason: "engine",
          scanDetail: { engine: "photodna", signatures: ["x"] },
          scannedAt: new Date(),
          mimeSniffed: "image/jpeg",
        })
        .where(eq(nodes.id, file.id));
      if (otherCase)
        await insertReport(db, { nodeId: file.id, ownerId: owner, source: "user", category: "spam" });
      await clearSuspectedCsam(db, file.id);
      expect(await getNode(db, file.id), String(otherCase)).toMatchObject({
        scanStatus: otherCase ? "under_review" : "pending",
        scanReason: null,
        scanDetail: null,
        scannedAt: null,
        // Not a verdict: the sniffed type stays, as it does on a rescan.
        mimeSniffed: "image/jpeg",
      });
    }
    // The control: a refused clear leaves the verdict where it is.
    const { file } = await reported("clean");
    await db
      .update(nodes)
      .set({ scanReason: "hash_mismatch", scannedAt: new Date() })
      .where(eq(nodes.id, file.id));
    await clearSuspectedCsam(db, file.id);
    expect((await getNode(db, file.id))!.scanReason).toBe("hash_mismatch");
  });

  it("does not downgrade another open case: with an open or reviewing report of another category the node is under_review again, with pending saved under it", async () => {
    for (const status of ["open", "reviewing"] as const) {
      const { file, link, owner } = await locked();
      const other = (await insertReport(db, {
        nodeId: file.id,
        ownerId: owner,
        source: "user",
        category: "phishing",
      }))!;
      await db.update(reports).set({ status }).where(eq(reports.id, other));
      // The report arrived while the node was locked: `setUnderReview` leaves a locked node and
      // its links alone, so there is no `report` pause yet.
      expect(await setUnderReview(db, file.id)).toEqual({ changed: false });
      expect((await getById(db, link.id))!.pauseReasons, status).toEqual(["moderation"]);

      expect((await clearSuspectedCsam(db, file.id)).cleared, status).toBe(true);
      expect(await getNode(db, file.id), status).toMatchObject({
        scanStatus: "under_review",
        scanStatusPrev: "pending",
      });
      // Under review again, so the links carry the review's pause — what `setUnderReview` would
      // have put there had the lock not been in the way. The report itself is untouched.
      expect((await getById(db, link.id))!.pauseReasons, status).toEqual(["report"]);
      expect((await reportRow(other)).status, status).toBe(status);
      // …and ending that review gives back `pending` — scanned again before it is served — and
      // lifts the pause: nothing is left that nobody would ever remove.
      expect(await dismissReview(db, file.id)).toEqual({ restored: "pending" });
      expect(await getById(db, link.id), status).toMatchObject({ pauseReasons: [], pausedAt: null });
    }
    // The control: a report of another category that is already closed is no open case.
    for (const status of ["dismissed", "actioned"] as const) {
      const { file, owner } = await locked();
      const closed = (await insertReport(db, {
        nodeId: file.id,
        ownerId: owner,
        source: "user",
        category: "phishing",
      }))!;
      await db.update(reports).set({ status }).where(eq(reports.id, closed));
      await clearSuspectedCsam(db, file.id);
      expect(await getNode(db, file.id), status).toMatchObject({
        scanStatus: "pending",
        scanStatusPrev: null,
      });
    }
  });

  it("a review that ended while the node was locked leaves no `report` pause behind: the clear removes it", async () => {
    // Under review first (links paused `report`), then locked.
    const { file, link, owner } = await reported("clean");
    const other = (await insertReport(db, {
      nodeId: file.id,
      ownerId: owner,
      source: "user",
      category: "spam",
    }))!;
    expect(await setUnderReview(db, file.id)).toEqual({ changed: true });
    const alsoByOwner = await makeLink(db, file.id, owner, { pauseReasons: ["owner", "report"] });
    await lockSuspectedCsam(db, file.id, { source: "photodna" });
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["report", "moderation"]);
    // The admin closes the other report: `dismissReview` does nothing for a locked node.
    await db.update(reports).set({ status: "dismissed" }).where(eq(reports.id, other));
    expect(await dismissReview(db, file.id)).toEqual({ restored: null });
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["report", "moderation"]);

    await clearSuspectedCsam(db, file.id);
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "pending", scanStatusPrev: null });
    expect(await getById(db, link.id)).toMatchObject({ pauseReasons: [], pausedAt: null });
    // Only those two reasons: the owner's own pause stays.
    expect((await getById(db, alsoByOwner.id))!.pauseReasons).toEqual(["owner"]);

    // The control: the same, with the other report still open — the pause stays, with its review.
    const still = await reported("clean");
    await insertReport(db, { nodeId: still.file.id, ownerId: still.owner, source: "user", category: "spam" });
    await setUnderReview(db, still.file.id);
    await lockSuspectedCsam(db, still.file.id, { source: "photodna" });
    await clearSuspectedCsam(db, still.file.id);
    expect((await getNode(db, still.file.id))!.scanStatus).toBe("under_review");
    expect((await getById(db, still.link.id))!.pauseReasons).toEqual(["report"]);
  });

  it("is refused when a csam report on the node was FILED: nothing is written, and it says why", async () => {
    const { file, link, owner, reportId } = await locked();
    const filed = (await insertReport(db, {
      nodeId: file.id,
      ownerId: owner,
      source: "admin",
      category: "csam",
      reporterIpHashStable: `ip-${rand()}`,
    }))!;
    await db.update(reports).set({ status: "actioned", ncmecReportId: "N-7" }).where(eq(reports.id, filed));

    expect(await clearSuspectedCsam(db, file.id)).toEqual({
      cleared: false,
      refused: "reported",
      blocklistRemoved: false,
      blocklistRestoredTo: null,
      blocklistKept: null,
      reportIds: [],
    });
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["moderation"]);
    expect(await lookup(db, file.sha256!)).toEqual({ reason: "csam", sourceNodeId: file.id });
    expect(await reportRow(reportId)).toMatchObject({ status: "open", resolvedAt: null, resolution: null });
    expect(await reportRow(filed)).toMatchObject({ status: "actioned", ncmecReportId: "N-7" });

    // The control: the same node once that report is no longer `actioned` can be cleared.
    await db.update(reports).set({ status: "reviewing" }).where(eq(reports.id, filed));
    expect(await clearSuspectedCsam(db, file.id)).toMatchObject({ cleared: true, refused: null });
  });

  it("is refused for any node that is not suspected_csam, an unknown id and a malformed one: nothing is written", async () => {
    const notLocked = {
      cleared: false,
      refused: "not_locked",
      blocklistRemoved: false,
      blocklistRestoredTo: null,
      blocklistKept: null,
      reportIds: [],
    };
    for (const scanStatus of ["clean", "under_review", "infected", "pending", "skipped", "error"] as const) {
      const { file, link, owner } = await reported(scanStatus);
      // Everything the clear would touch, in the state a lock leaves it — but the node is not locked.
      await db.update(nodes).set({ scanStatusPrev: "clean", legalHold: true }).where(eq(nodes.id, file.id));
      await pauseLinks(db, { nodeId: file.id }, "moderation");
      await db.insert(hashBlocklist).values({ sha256: file.sha256!, reason: "csam", sourceNodeId: file.id });
      const reportId = (await insertReport(db, {
        nodeId: file.id,
        ownerId: owner,
        source: "system",
        category: "csam",
      }))!;

      expect(await clearSuspectedCsam(db, file.id), scanStatus).toEqual(notLocked);
      expect(await getNode(db, file.id), scanStatus).toMatchObject({ scanStatus, scanStatusPrev: "clean" });
      expect((await getById(db, link.id))!.pauseReasons, scanStatus).toEqual(["moderation"]);
      expect(await lookup(db, file.sha256!), scanStatus).toEqual({ reason: "csam", sourceNodeId: file.id });
      expect(await reportRow(reportId), scanStatus).toMatchObject({ status: "open", resolvedAt: null });
    }
    expect(await clearSuspectedCsam(db, uuidv7())).toEqual(notLocked);
    expect(await clearSuspectedCsam(db, "nope")).toEqual(notLocked);
  });

  it("removes `moderation` from the node's links and nothing else: a link its owner also paused stays paused", async () => {
    const { file, link, owner } = await locked();
    const alsoByOwner = await makeLink(db, file.id, owner, { pauseReasons: ["owner"] });
    await pauseLinks(db, { linkId: alsoByOwner.id }, "moderation");
    const elsewhere = await makeFile(db, owner, null, `else-${rand()}.bin`);
    const otherLink = await makeLink(db, elsewhere.id, owner, { pauseReasons: ["moderation"] });

    await clearSuspectedCsam(db, file.id);
    expect(await getById(db, link.id)).toMatchObject({ pauseReasons: [], pausedAt: null });
    const kept = (await getById(db, alsoByOwner.id))!;
    expect(kept.pauseReasons).toEqual(["owner"]);
    expect(kept.pausedAt).not.toBeNull();
    // The control: a link on another node keeps its own `moderation`.
    expect((await getById(db, otherLink.id))!.pauseReasons).toEqual(["moderation"]);
  });

  it("leaves `moderation` on the links while the node or an ancestor is taken down — that takedown's restore removes it", async () => {
    const owner = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `down-${rand()}`);
    const sub = await makeFolder(db, owner, folder.id, "sub");
    const underFolder = await makeFile(db, owner, sub.id, `under-${rand()}.bin`);
    const itself = await makeFile(db, owner, null, `itself-${rand()}.bin`);
    const free = await makeFile(db, owner, null, `free-${rand()}.bin`);
    const links: Record<string, string> = {};
    for (const [name, node] of Object.entries({ underFolder, itself, free })) {
      links[name] = (await makeLink(db, node.id, owner)).id;
      await lockSuspectedCsam(db, node.id, { source: "system" });
    }
    await takedownNode(db, folder.id, { reason: "abuse", by: null });
    await takedownNode(db, itself.id, { reason: "abuse", by: null });

    for (const node of [underFolder, itself, free]) {
      expect((await clearSuspectedCsam(db, node.id)).cleared).toBe(true);
      expect((await getNode(db, node.id))!.scanStatus).toBe("pending");
    }
    expect((await getById(db, links.underFolder!))!.pauseReasons).toEqual(["moderation"]);
    expect((await getById(db, links.itself!))!.pauseReasons).toEqual(["moderation"]);
    // The control: the same clear on a node nothing has taken down resumes its link.
    expect((await getById(db, links.free!))!.pauseReasons).toEqual([]);

    // The takedown's own restore then removes the reason.
    await restoreTakedown(db, folder.id);
    await unpauseLinks(db, { subtreeOf: folder.id }, "moderation");
    expect((await getById(db, links.underFolder!))!.pauseReasons).toEqual([]);
  });

  const entryOf = async (sha256: string) =>
    (await db.select().from(hashBlocklist).where(eq(hashBlocklist.sha256, sha256)))[0] ?? null;

  it("the lock RAISES an entry that was already there — provenance kept, what it was recorded — and the clear puts it back", async () => {
    const admin = await makeUser(db);
    for (const reason of ["malware", "dmca", "admin"] as const) {
      const { file } = await reported("clean");
      const earlierSource = uuidv7();
      const before = { reason, sourceNodeId: earlierSource, addedBy: admin, note: "listed before" };
      await upsert(db, { sha256: file.sha256!, ...before });
      const addedAt = (await entryOf(file.sha256!))!.addedAt;

      await lockSuspectedCsam(db, file.id, { source: "photodna" });
      expect(await entryOf(file.sha256!), reason).toMatchObject({
        ...before,
        reason: "csam",
        raisedFrom: reason,
        raisedByNodeId: file.id,
      });
      // A second lock call (a redelivery) records nothing over the raise that is in force.
      await lockSuspectedCsam(db, file.id, { source: "admin" });
      expect(await entryOf(file.sha256!), reason).toMatchObject({
        raisedFrom: reason,
        raisedByNodeId: file.id,
      });

      expect(await clearSuspectedCsam(db, file.id), reason).toMatchObject({
        cleared: true,
        blocklistRemoved: false,
        blocklistRestoredTo: reason,
        blocklistKept: null,
      });
      // Exactly the entry there was: still blocklisted, for its own reason, by its own author.
      expect(await entryOf(file.sha256!), reason).toMatchObject({
        ...before,
        addedAt,
        raisedFrom: null,
        raisedByNodeId: null,
      });
    }
  });

  it("an entry this very node's earlier verdict listed — { malware, source X } — is raised by the lock on X and RESTORED by the clear of X, never deleted", async () => {
    for (const reason of ["malware", "dmca", "admin"] as const) {
      const { file } = await reported("clean");
      await upsert(db, { sha256: file.sha256!, reason, sourceNodeId: file.id, note: "its own verdict" });
      await lockSuspectedCsam(db, file.id, { source: "photodna" });
      // Raised: `csam`, with this node as both the entry's source and the raiser.
      expect(await entryOf(file.sha256!), reason).toMatchObject({
        reason: "csam",
        sourceNodeId: file.id,
        raisedFrom: reason,
        raisedByNodeId: file.id,
      });
      expect(await clearSuspectedCsam(db, file.id), reason).toMatchObject({
        blocklistRemoved: false,
        blocklistRestoredTo: reason,
        blocklistKept: null,
      });
      expect(await entryOf(file.sha256!), reason).toMatchObject({
        reason,
        sourceNodeId: file.id,
        note: "its own verdict",
        raisedFrom: null,
        raisedByNodeId: null,
      });
    }
  });

  it("removes the blocklist entry only when a lock created it; an entry that is nobody's lock's is left", async () => {
    // This lock created it.
    const mine = await locked();
    expect(await entryOf(mine.file.sha256!)).toMatchObject({
      reason: "csam",
      sourceNodeId: mine.file.id,
      raisedFrom: null,
      raisedByNodeId: null,
    });
    expect(await clearSuspectedCsam(db, mine.file.id)).toMatchObject({
      blocklistRemoved: true,
      blocklistRestoredTo: null,
      blocklistKept: null,
    });
    expect(await lookup(db, mine.file.sha256!)).toBeNull();

    // The lock found a `csam` entry with a source nobody knows (rows from before there were
    // confirmed listings): it wrote nothing, and the clear leaves it.
    {
      const sourceNodeId = uuidv7();
      const { file } = await reported("clean");
      await db.insert(hashBlocklist).values({ sha256: file.sha256!, reason: "csam", sourceNodeId });
      await lockSuspectedCsam(db, file.id, { source: "system" });
      expect(await entryOf(file.sha256!)).toMatchObject({ reason: "csam", sourceNodeId, raisedFrom: null });
      expect(await clearSuspectedCsam(db, file.id)).toMatchObject({
        cleared: true,
        blocklistRemoved: false,
        blocklistRestoredTo: null,
        blocklistKept: "not_this_locks",
      });
      expect(await lookup(db, file.sha256!)).toEqual({ reason: "csam", sourceNodeId });
    }
    // The same for a `csam` entry whose source is a real node that was never locked and cleared
    // (an admin listed it from that node).
    const owner = await makeUser(db);
    const listedFrom = await makeFile(db, owner, null, `listed-${rand()}.bin`);
    const twin = await makeFile(db, owner, null, `twin-${rand()}.bin`, { sha256: listedFrom.sha256 });
    await db
      .insert(hashBlocklist)
      .values({ sha256: twin.sha256!, reason: "csam", sourceNodeId: listedFrom.id });
    await lockSuspectedCsam(db, twin.id, { source: "system" });
    expect(await clearSuspectedCsam(db, twin.id)).toMatchObject({ blocklistKept: "not_this_locks" });
    expect(await lookup(db, twin.sha256!)).toEqual({ reason: "csam", sourceNodeId: listedFrom.id });

    // A file with no hash, and one whose entry is gone: nothing to undo, nothing kept.
    const hashless = await makeFile(db, owner, null, `nohash-${rand()}.bin`, { sha256: null });
    await lockSuspectedCsam(db, hashless.id, { source: "system" });
    const nothing = {
      cleared: true,
      blocklistRemoved: false,
      blocklistRestoredTo: null,
      blocklistKept: null,
    };
    expect(await clearSuspectedCsam(db, hashless.id)).toMatchObject(nothing);
    const unlisted = await locked();
    await db.delete(hashBlocklist).where(eq(hashBlocklist.sha256, unlisted.file.sha256!));
    expect(await clearSuspectedCsam(db, unlisted.file.id)).toMatchObject(nothing);
  });

  it("an entry somebody edited between the lock and the clear is left as they made it, and the result says so", async () => {
    // Created by this lock, its reason changed since.
    const created = await locked();
    await db
      .update(hashBlocklist)
      .set({ reason: "malware" })
      .where(eq(hashBlocklist.sha256, created.file.sha256!));
    expect(await clearSuspectedCsam(db, created.file.id)).toMatchObject({
      blocklistRemoved: false,
      blocklistRestoredTo: null,
      blocklistKept: "edited",
    });
    expect(await lookup(db, created.file.sha256!)).toEqual({
      reason: "malware",
      sourceNodeId: created.file.id,
    });

    // Raised by this lock, then set to another reason by an admin: not put back to the old one.
    const { file } = await reported("clean");
    await upsert(db, { sha256: file.sha256!, reason: "malware", note: "first" });
    await lockSuspectedCsam(db, file.id, { source: "system" });
    await db
      .update(hashBlocklist)
      .set({ reason: "dmca", note: "second" })
      .where(eq(hashBlocklist.sha256, file.sha256!));
    expect(await clearSuspectedCsam(db, file.id)).toMatchObject({
      blocklistRestoredTo: null,
      blocklistKept: "edited",
    });
    expect(await entryOf(file.sha256!)).toMatchObject({ reason: "dmca", note: "second" });

    // Removed and listed again by hand as `csam`: a new entry, no lock's.
    const relisted = await locked();
    await db.delete(hashBlocklist).where(eq(hashBlocklist.sha256, relisted.file.sha256!));
    await upsert(db, { sha256: relisted.file.sha256!, reason: "csam", note: "by hand" });
    expect(await clearSuspectedCsam(db, relisted.file.id)).toMatchObject({ blocklistKept: "confirmed" });
    expect(await entryOf(relisted.file.sha256!)).toMatchObject({ reason: "csam", note: "by hand" });
  });

  it("a CONFIRMED csam listing is permanent to every clear: confirmCsam, or an explicit csam upsert, detaches the entry from the lock that made or raised it", async () => {
    const detached = { reason: "csam", sourceNodeId: null, raisedFrom: null, raisedByNodeId: null };
    const stays = {
      cleared: true,
      blocklistRemoved: false,
      blocklistRestoredTo: null,
      blocklistKept: "confirmed",
    };

    // A lock CREATED the entry; the report is filed (the console confirms the hash); a clear
    // of that lock — or of anything — no longer removes it.
    const created = await locked();
    expect(await confirmCsam(db, created.file.sha256!)).toBe(true);
    expect(await entryOf(created.file.sha256!)).toMatchObject(detached);
    // Idempotent: nothing left to write.
    expect(await confirmCsam(db, created.file.sha256!)).toBe(false);
    expect(await clearSuspectedCsam(db, created.file.id)).toMatchObject(stays);
    expect(await entryOf(created.file.sha256!)).toMatchObject(detached);

    // A lock RAISED a `malware` entry; confirmed; the clear does not lower it. Author and note stay.
    const admin = await makeUser(db);
    const raised = await reported("clean");
    await upsert(db, {
      sha256: raised.file.sha256!,
      reason: "malware",
      addedBy: admin,
      note: "first listed",
    });
    await lockSuspectedCsam(db, raised.file.id, { source: "photodna" });
    expect(await entryOf(raised.file.sha256!)).toMatchObject({ raisedFrom: "malware" });
    expect(await confirmCsam(db, raised.file.sha256!)).toBe(true);
    expect(await entryOf(raised.file.sha256!)).toMatchObject({
      ...detached,
      addedBy: admin,
      note: "first listed",
    });
    expect(await clearSuspectedCsam(db, raised.file.id)).toMatchObject(stays);
    expect(await entryOf(raised.file.sha256!)).toMatchObject(detached);

    // An explicit `csam` upsert on a raised entry is the same confirmation — and names no source.
    const listed = await reported("clean");
    await upsert(db, { sha256: listed.file.sha256!, reason: "dmca", note: "notice 3" });
    await lockSuspectedCsam(db, listed.file.id, { source: "photodna" });
    await upsert(db, {
      sha256: listed.file.sha256!,
      reason: "csam",
      sourceNodeId: listed.file.id,
      note: "ignored",
    });
    expect(await entryOf(listed.file.sha256!)).toMatchObject({ ...detached, note: "notice 3" });
    expect(await clearSuspectedCsam(db, listed.file.id)).toMatchObject(stays);

    // No entry yet: confirmCsam creates a detached one, and a lock that then finds it writes nothing.
    const fresh = await reported("clean");
    expect(await confirmCsam(db, fresh.file.sha256!)).toBe(true);
    await lockSuspectedCsam(db, fresh.file.id, { source: "system" });
    expect(await entryOf(fresh.file.sha256!)).toMatchObject(detached);
    expect(await clearSuspectedCsam(db, fresh.file.id)).toMatchObject(stays);

    // The controls: the same three without the confirmation are removed or lowered.
    const plain = await locked();
    expect(await clearSuspectedCsam(db, plain.file.id)).toMatchObject({ blocklistRemoved: true });
    const lowered = await reported("clean");
    await upsert(db, { sha256: lowered.file.sha256!, reason: "malware" });
    await lockSuspectedCsam(db, lowered.file.id, { source: "photodna" });
    expect(await clearSuspectedCsam(db, lowered.file.id)).toMatchObject({ blocklistRestoredTo: "malware" });
  });

  it("that a hash was REPORTED lives on the entry: the reported node's row gone, a twin's clear still leaves the hash blocklisted", async () => {
    const owner = await makeUser(db);
    const scenario = async (filingConfirms: boolean) => {
      const sha256 = rand(32);
      const reportedNode = await makeFile(db, owner, null, `reported-${rand()}.bin`, { sha256 });
      const twin = await makeFile(db, owner, null, `twin-${rand()}.bin`, { sha256 });
      // The twin's lock is the one that created the entry (it was found first).
      await lockSuspectedCsam(db, twin.id, { source: "photodna" });
      const first = (await lockSuspectedCsam(db, reportedNode.id, { source: "photodna" }))!;
      // The report on the first node is FILED — as the console leaves it: the report `actioned`
      // and the hash confirmed on the entry.
      await db.update(reports).set({ status: "actioned" }).where(eq(reports.id, first.reportId));
      if (filingConfirms) await confirmCsam(db, sha256);
      // Later the reported node's row is gone (its hold released and purged): the join from
      // reports to nodes can no longer say the hash was reported.
      await db.delete(nodes).where(eq(nodes.id, reportedNode.id));
      return { sha256, result: await clearSuspectedCsam(db, twin.id) };
    };

    const kept = await scenario(true);
    expect(kept.result).toMatchObject({ cleared: true, blocklistRemoved: false, blocklistKept: "confirmed" });
    expect(await lookup(db, kept.sha256)).toEqual({ reason: "csam", sourceNodeId: null });

    // The control — what the join from reports to nodes alone does once the node is gone:
    // nothing says "reported" any more, and the clear removes the entry.
    const unconfirmed = await scenario(false);
    expect(unconfirmed.result).toMatchObject({ blocklistRemoved: true, blocklistKept: null });
    expect(await lookup(db, unconfirmed.sha256)).toBeNull();
  });

  it("two locked twins: the first clear leaves the entry, the SECOND puts it back to what it was — whichever of the two created or raised it", async () => {
    const owner = await makeUser(db);
    const twins = async (before: "nothing" | "malware") => {
      const sha256 = rand(32);
      if (before === "malware") await upsert(db, { sha256, reason: "malware", note: "admin's" });
      const first = await makeFile(db, owner, null, `first-${rand()}.bin`, { sha256 });
      const second = await makeFile(db, owner, null, `second-${rand()}.bin`, { sha256 });
      // `first`'s lock creates or raises the entry; `second`'s finds it `csam` and writes nothing.
      await lockSuspectedCsam(db, first.id, { source: "photodna" });
      const afterFirst = await entryOf(sha256);
      await lockSuspectedCsam(db, second.id, { source: "photodna" });
      expect(await entryOf(sha256)).toEqual(afterFirst);
      return { sha256, first, second };
    };
    const kept = { blocklistRemoved: false, blocklistRestoredTo: null, blocklistKept: "other_node_locked" };

    for (const order of ["maker first", "maker last"] as const) {
      // A lock CREATED the entry: after both clears there is none.
      const created = await twins("nothing");
      const [one, two] =
        order === "maker first" ? [created.first, created.second] : [created.second, created.first];
      expect(await clearSuspectedCsam(db, one.id), order).toMatchObject(kept);
      expect(await lookup(db, created.sha256), order).toEqual({
        reason: "csam",
        sourceNodeId: created.first.id,
      });
      expect(await clearSuspectedCsam(db, two.id), order).toMatchObject({
        blocklistRemoved: true,
        blocklistRestoredTo: null,
        blocklistKept: null,
      });
      expect(await entryOf(created.sha256), order).toBeNull();

      // A lock RAISED the entry: after both clears it is the admin's `malware` entry again.
      const raised = await twins("malware");
      const [three, four] =
        order === "maker first" ? [raised.first, raised.second] : [raised.second, raised.first];
      expect(await clearSuspectedCsam(db, three.id), order).toMatchObject(kept);
      expect(await entryOf(raised.sha256), order).toMatchObject({
        reason: "csam",
        raisedFrom: "malware",
        raisedByNodeId: raised.first.id,
      });
      expect(await clearSuspectedCsam(db, four.id), order).toMatchObject({
        blocklistRemoved: false,
        blocklistRestoredTo: "malware",
        blocklistKept: null,
      });
      expect(await entryOf(raised.sha256), order).toMatchObject({
        reason: "malware",
        note: "admin's",
        sourceNodeId: null,
        raisedFrom: null,
        raisedByNodeId: null,
      });
    }
  });

  it("keeps the hash blocklisted while a csam report on a node with that content was filed", async () => {
    const owner = await makeUser(db);
    // Three twins; the third was reported and filed: it cannot be cleared, and stays locked.
    const sha256 = rand(32);
    const twin = async () => {
      const file = await makeFile(db, owner, null, `twin-${rand()}.bin`, { sha256 });
      const { reportId } = (await lockSuspectedCsam(db, file.id, { source: "photodna" }))!;
      return { file, reportId };
    };
    const first = await twin();
    const second = await twin();
    const third = await twin();
    await db.update(reports).set({ status: "actioned" }).where(eq(reports.id, third.reportId));
    expect(await clearSuspectedCsam(db, second.file.id)).toMatchObject({
      blocklistKept: "other_node_locked",
    });
    expect(await clearSuspectedCsam(db, third.file.id)).toMatchObject({
      cleared: false,
      refused: "reported",
    });
    expect(await clearSuspectedCsam(db, first.file.id)).toMatchObject({
      cleared: true,
      blocklistRemoved: false,
      blocklistKept: "other_node_locked",
    });
    expect(await lookup(db, sha256)).toEqual({ reason: "csam", sourceNodeId: first.file.id });

    // A filed report on a node with this hash that is NOT locked (it was dealt with another way).
    const sha2 = rand(32);
    const mine = await makeFile(db, owner, null, `mine-${rand()}.bin`, { sha256: sha2 });
    await lockSuspectedCsam(db, mine.id, { source: "photodna" });
    const elsewhere = await makeFile(db, owner, null, `filed-${rand()}.bin`, { sha256: sha2 });
    const filed = (await insertReport(db, {
      nodeId: elsewhere.id,
      ownerId: owner,
      source: "admin",
      category: "csam",
    }))!;
    await db.update(reports).set({ status: "actioned" }).where(eq(reports.id, filed));
    expect(await clearSuspectedCsam(db, mine.id)).toMatchObject({
      cleared: true,
      blocklistRemoved: false,
      blocklistRestoredTo: null,
      blocklistKept: "reported",
    });
    expect(await lookup(db, sha2)).toEqual({ reason: "csam", sourceNodeId: mine.id });

    // The control: the same pair with the other node's report only OPEN and the node not locked —
    // the entry goes.
    const sha3 = rand(32);
    const alone = await makeFile(db, owner, null, `alone-${rand()}.bin`, { sha256: sha3 });
    await lockSuspectedCsam(db, alone.id, { source: "photodna" });
    const unfiled = await makeFile(db, owner, null, `unfiled-${rand()}.bin`, { sha256: sha3 });
    await insertReport(db, { nodeId: unfiled.id, ownerId: owner, source: "admin", category: "csam" });
    expect(await clearSuspectedCsam(db, alone.id)).toMatchObject({
      blocklistRemoved: true,
      blocklistKept: null,
    });
    expect(await lookup(db, sha3)).toBeNull();
  });

  it("dismisses the node's open and reviewing csam reports as false positives; one closed before, another category and another node's are untouched", async () => {
    const { file, owner, reportId } = await locked();
    const admin = await makeUser(db);
    const csam = (hash: string) =>
      insertReport(db, {
        nodeId: file.id,
        ownerId: owner,
        source: "user",
        category: "csam",
        reporterIpHashStable: hash,
      });
    const reviewing = (await csam(`ip-${rand()}`))!;
    await db.update(reports).set({ status: "reviewing", assignedTo: admin }).where(eq(reports.id, reviewing));
    // A csam report on this node that was dismissed before stays as it was.
    const dismissedBefore = (await csam(`ip-${rand()}`))!;
    await db
      .update(reports)
      .set({ status: "dismissed", resolvedAt: new Date(1_700_000_000_000), resolution: "duplicate" })
      .where(eq(reports.id, dismissedBefore));
    const otherCategory = (await insertReport(db, {
      nodeId: file.id,
      ownerId: owner,
      source: "user",
      category: "malware",
    }))!;
    const other = await locked();

    const result = await clearSuspectedCsam(db, file.id);
    expect(result.reportIds).toEqual([reportId, reviewing].sort());
    for (const id of [reportId, reviewing]) {
      const row = await reportRow(id);
      expect(row).toMatchObject({ status: "dismissed", resolution: "false_positive" });
      expect(Math.abs(row.resolvedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    }
    // Who was assigned is another fact, and stays; who cleared it is the caller's audit row.
    expect((await reportRow(reviewing)).assignedTo).toBe(admin);
    expect((await reportRow(reportId)).assignedTo).toBeNull();
    expect(await reportRow(dismissedBefore)).toMatchObject({
      status: "dismissed",
      resolution: "duplicate",
      resolvedAt: new Date(1_700_000_000_000),
    });
    expect(await reportRow(otherCategory)).toMatchObject({
      status: "open",
      resolvedAt: null,
      resolution: null,
    });
    expect(await reportRow(other.reportId)).toMatchObject({ status: "open", resolvedAt: null });
  });

  it("touches no legal hold — the node's, the owner's, an uploader's, the address rows' — and a second call writes nothing", async () => {
    const owner = await makeUser(db);
    const editor = await makeUser(db);
    const file = await makeFile(db, owner, null, `held-${rand()}.bin`, { createdBy: editor });
    await db.insert(uploadIps).values({
      nodeId: file.id,
      versionId: file.versionId!,
      uploaderId: editor,
      ipEncrypted: Buffer.from("c"),
      iv: Buffer.from("i"),
      keyVersion: 1,
    });
    const link = await makeLink(db, file.id, owner);
    const { reportId } = (await lockSuspectedCsam(db, file.id, { source: "photodna" }))!;
    const holds = async () => ({
      node: (await getNode(db, file.id))!.legalHold,
      users: (
        await db
          .select({ held: user.legalHold })
          .from(user)
          .where(inArray(user.id, [owner, editor]))
      ).map((u) => u.held),
      addresses: (await db.select().from(uploadIps).where(eq(uploadIps.nodeId, file.id))).map(
        (r) => r.legalHold,
      ),
    });
    const allHeld = { node: true, users: [true, true], addresses: [true] };
    expect(await holds()).toEqual(allHeld);

    expect((await clearSuspectedCsam(db, file.id)).cleared).toBe(true);
    expect(await holds()).toEqual(allHeld);

    // A second call: refused, and nothing it could write has moved — set up so that it would show.
    await db.update(nodes).set({ scanStatus: "clean" }).where(eq(nodes.id, file.id));
    await pauseLinks(db, { nodeId: file.id }, "moderation");
    const resolvedAt = (await reportRow(reportId)).resolvedAt;
    expect(await clearSuspectedCsam(db, file.id)).toMatchObject({
      cleared: false,
      refused: "not_locked",
      reportIds: [],
    });
    expect((await getNode(db, file.id))!.scanStatus).toBe("clean");
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["moderation"]);
    expect((await reportRow(reportId)).resolvedAt).toEqual(resolvedAt);
    expect(await holds()).toEqual(allHeld);
  });

  it("runs inside the caller's transaction and is undone with it", async () => {
    const { file, link, reportId } = await locked();
    await expect(
      db.transaction(async (tx) => {
        expect((await clearSuspectedCsam(tx, file.id)).cleared).toBe(true);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect((await getNode(db, file.id))!.scanStatus).toBe("suspected_csam");
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["moderation"]);
    expect(await lookup(db, file.sha256!)).toEqual({ reason: "csam", sourceNodeId: file.id });
    expect((await reportRow(reportId)).status).toBe("open");
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
