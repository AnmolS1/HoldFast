// safety-1 (R1): a hash the CLIENT declared is never put on the blocklist, nor used as a
// content key, by an admin action. `nodes.sha256` is the server's own hash only once a scan
// recorded a verdict (`scannedAt` set); before that — `pending`, and for good on `error` /
// `skipped` — it is whatever the uploader declared. Each reader below goes red if it falls back
// to the declared value; each has a control with the same node scanned, which does list.
// Fixtures use fresh made-up hashes (Common addendum 3: the blocklist is shared by every file).
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DmcaNoticeDto } from "../../../src/shared/schemas/admin";
import {
  listLockedOnScan,
  lockSuspectedCsam as lockRowsOnly,
} from "../../../src/worker/db/queries/moderation";
import { dmcaNoticeNodes, reports } from "../../../src/worker/db/schema";
import {
  admin,
  adminCall,
  blocklistRow,
  madeUpSha,
  makeFile,
  member,
  nodeRowOf,
  reported,
  reportRowOf,
  strikesOfUser,
  testDb,
} from "./helpers";

type Admin = Awaited<ReturnType<typeof admin>>;

const intake = (nodeIds: string[]) => ({
  receivedVia: "email",
  complainantName: "A. Rights-Holder",
  complainantAddress: "1 Example Street",
  complainantEmail: "legal@example.test",
  workDescription: "A photograph I took.",
  infringingDescription: "The file named in this notice.",
  statementGoodFaith: true,
  statementAccuracy: true,
  signature: "A. Rights-Holder",
  rawText: "The notice as it was received.",
  nodeIds,
});

async function noticeAndTakedown(who: Admin, nodeId: string) {
  const made = await adminCall(who.as, "POST", "/dmca", { body: intake([nodeId]) });
  expect(made.status).toBe(200);
  const notice = made.body.notices[0] as DmcaNoticeDto;
  const down = await adminCall(who.as, "POST", `/dmca/${notice.id}/action`, {
    body: { action: "takedown", note: "Complete notice." },
  });
  expect(down.status).toBe(200);
  return notice;
}

/** A file whose `nodes.sha256` is the client's word: never scanned (`scannedAt` null). */
const declared = (ownerId: string, scanStatus: "pending" | "error" | "skipped", sha256 = madeUpSha()) =>
  makeFile(ownerId, null, { scanStatus, sha256, scannedAt: null });
/** The same, scanned: the hash is the server's. */
const scanned = (ownerId: string, sha256 = madeUpSha()) =>
  makeFile(ownerId, null, { scanStatus: "clean", sha256, scannedAt: new Date() });

describe("a DMCA takedown lists only a hash the server computed", () => {
  it("an `error` node (the scanner never answered): taken down, NOTHING listed, the snapshot keeps no hash", async () => {
    const who = await admin();
    const owner = await member();
    const file = await declared(owner.id, "error");
    const notice = await noticeAndTakedown(who, file.id);
    expect((await nodeRowOf(file.id))!.takedownReason).toBe("dmca");
    expect(await blocklistRow(file.sha256!)).toBeNull();
    const [snap] = await testDb()
      .select()
      .from(dmcaNoticeNodes)
      .where(eq(dmcaNoticeNodes.noticeId, notice.id));
    expect(snap!.sha256).toBeNull();
  });

  it("`under_review` over a pending node: nothing listed", async () => {
    const who = await admin();
    const owner = await member();
    const file = await declared(owner.id, "pending");
    await reported(file.id, owner.id);
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("under_review");
    await noticeAndTakedown(who, file.id);
    expect(await blocklistRow(file.sha256!)).toBeNull();
  });

  it("control: the same takedown of a SCANNED node lists its hash `dmca`", async () => {
    const who = await admin();
    const owner = await member();
    const file = await scanned(owner.id);
    const notice = await noticeAndTakedown(who, file.id);
    expect(await blocklistRow(file.sha256!)).toMatchObject({ reason: "dmca", sourceNodeId: file.id });
    const [snap] = await testDb()
      .select()
      .from(dmcaNoticeNodes)
      .where(eq(dmcaNoticeNodes.noticeId, notice.id));
    expect(snap!.sha256).toBe(file.sha256);
  });
});

describe("a report's strike keys on a server hash only", () => {
  it("strike on an unscanned (`error`) file: the strike carries no content hash; control: scanned carries it", async () => {
    const who = await admin();
    for (const kind of ["declared", "scanned"] as const) {
      const owner = await member();
      const file = kind === "declared" ? await declared(owner.id, "error") : await scanned(owner.id);
      const reportId = await reported(file.id, owner.id);
      const answer = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
        body: { action: "strike", resolution: "Abuse confirmed." },
      });
      expect(answer.status, kind).toBe(200);
      const [strike] = await strikesOfUser(owner.id);
      expect(strike!.contentSha256, kind).toBe(kind === "declared" ? null : file.sha256);
    }
  });
});

describe("the lock-from-notice lookup shows no declared hash", () => {
  it("an `error` node's match has sha256 null; a scanned one shows it", async () => {
    const who = await admin();
    const owner = await member();
    const unscanned = await declared(owner.id, "error");
    const done = await scanned(owner.id);
    const lookup = (id: string) =>
      adminCall(who.as, "POST", "/moderation/lock-csam", { body: { reference: id, reason: "A tip." } });
    expect((await lookup(unscanned.id)).body.match.sha256).toBeNull();
    expect((await lookup(done.id)).body.match.sha256).toBe(done.sha256);
  });
});

describe("a filing confirms only a server hash; the scan that brings it confirms it later", () => {
  /** A file locked as an admin's lock leaves it: held and locked, its declared hash NOT listed. */
  async function lockedUnverified() {
    const owner = await member();
    const file = await declared(owner.id, "pending");
    const locked = await lockRowsOnly(testDb(), file.id, { source: "admin", onlyVerifiedHash: true });
    expect(locked).not.toBeNull();
    expect(await blocklistRow(file.sha256!)).toBeNull();
    return { owner, file, reportId: locked!.reportId };
  }

  it("filed while the hash is the client's: the filing is recorded, the declared hash is NOT confirmed", async () => {
    const who = await admin();
    const t = await lockedUnverified();
    expect((await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/start`)).status).toBe(200);
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/filed`, {
      body: { reportId: "NCMEC-1", filedAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(answer.status).toBe(200);
    expect((await reportRowOf(t.reportId))!.status).toBe("actioned");
    expect(await blocklistRow(t.file.sha256!)).toBeNull();
  });

  it("the scan's hash of a locked node is listed as the lock's own entry, and confirmed once a report was filed", async () => {
    const t = await lockedUnverified();
    const server = madeUpSha();
    await testDb().transaction((tx) => listLockedOnScan(tx, t.file.id, server));
    expect(await blocklistRow(server)).toMatchObject({ reason: "csam", sourceNodeId: t.file.id });
    expect(await blocklistRow(t.file.sha256!)).toBeNull();

    await testDb()
      .update(reports)
      .set({ status: "actioned", ncmecFiledAt: new Date() })
      .where(and(eq(reports.id, t.reportId), eq(reports.category, "csam")));
    const later = madeUpSha();
    await testDb().transaction((tx) => listLockedOnScan(tx, t.file.id, later));
    expect(await blocklistRow(later)).toMatchObject({
      reason: "csam",
      sourceNodeId: null,
      raisedByNodeId: null,
    });
  });

  it("a node that is not locked: the scan lists nothing", async () => {
    const owner = await member();
    const file = await declared(owner.id, "pending");
    const server = madeUpSha();
    await testDb().transaction((tx) => listLockedOnScan(tx, file.id, server));
    expect(await blocklistRow(server)).toBeNull();
  });
});
