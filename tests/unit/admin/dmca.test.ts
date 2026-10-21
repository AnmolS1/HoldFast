// The DMCA workflow (T25 section 7) on T05's columns: intake (snapshotted, split per alleged
// infringer), take down (links PAUSED with `moderation`, the strike, the owner's mail once), the
// counter-notice and its window (10 / 14 business days, weekends skipped, compared with the
// Worker's clock), restore inside the window, the lawsuit notice, close — and a FOLDER taken down
// and restored by subtree, with a file inside taken down separately keeping its own pause.
//
// Time: `vi.useFakeTimers({ toFake: ["Date"] })` moves the Worker's clock (`now(c)`) and the
// stand-in session's second factor together; the X-Holdfast-Test-Now header is not used (it would
// make the session's second factor look days old). Postgres' own `now()` is not moved.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateDmcaNoticeResponse, DmcaNoticeDto } from "../../../src/shared/schemas/admin";
import { LegalHoldError } from "../../../src/worker/db/errors";
import { assertPurgeable } from "../../../src/worker/db/queries/trash";
import { dmcaNoticeNodes, shares } from "../../../src/worker/db/schema";
import { mailTo } from "../auth/helpers";
import { api as nodesApi } from "../nodes/helpers";
import {
  admin,
  adminCall,
  auditOf,
  blocklistRow,
  linkRowOf,
  madeUpSha,
  makeFile,
  makeFolder,
  makeLink,
  makeShare,
  member,
  nodeRowOf,
  strikesOfUser,
  testDb,
  uploadAddress,
} from "./helpers";

type Admin = Awaited<ReturnType<typeof admin>>;
const DAY = 86_400_000;

afterEach(() => {
  vi.useRealTimers();
});

const intake = (nodeIds: string[], extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});

async function notice(who: Admin, nodeIds: string[]) {
  const answer = await adminCall(who.as, "POST", "/dmca", { body: intake(nodeIds) });
  expect(answer.status).toBe(200);
  expect(answer.body.notices).toHaveLength(1);
  return answer.body.notices[0] as DmcaNoticeDto;
}

const act = (who: Admin, id: string, action: string, extra: Record<string, unknown> = {}) =>
  adminCall(who.as, "POST", `/dmca/${id}/action`, { body: { action, ...extra } });

const counter = (who: Admin, id: string) =>
  adminCall(who.as, "POST", `/dmca/${id}/counter`, {
    body: {
      counterName: "The Uploader",
      counterAddress: "2 Example Road",
      counterEmail: "uploader@example.test",
      counterStatement: "I believe in good faith the file was removed by mistake.",
      counterConsentJurisdiction: true,
      counterSignature: "The Uploader",
    },
  });

/** The next Friday at noon UTC after `from` (a forward on a Friday crosses two weekends). */
function nextFriday(from: Date): Date {
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 12));
  while (at.getUTCDay() !== 5) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/** Notice → take down → counter-notice → forwarded at `forwardAt` (the clock set there). */
async function upToForward(who: Admin, nodeIds: string[], forwardAt: Date) {
  const made = await notice(who, nodeIds);
  expect((await act(who, made.id, "takedown", { note: "Complete notice." })).status).toBe(200);
  expect((await counter(who, made.id)).status).toBe(200);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(forwardAt);
  const forwarded = await act(who, made.id, "forward_counter");
  expect(forwarded.status).toBe(200);
  return forwarded.body as DmcaNoticeDto;
}

describe("intake", () => {
  it("the §512(c)(3) fields as given, the nodes snapshotted into dmca_notice_nodes; status received; audited", async () => {
    const who = await admin();
    const owner = await member();
    const sha256 = madeUpSha();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256, name: "photo.jpg" });
    const answer = await adminCall(who.as, "POST", "/dmca", { body: intake([file.id]) });
    expect(answer.status).toBe(200);
    expect(CreateDmcaNoticeResponse.safeParse(answer.body).success).toBe(true);
    const [made] = answer.body.notices as DmcaNoticeDto[];
    expect(made).toMatchObject({
      status: "received",
      complainantName: "A. Rights-Holder",
      workDescription: "A photograph I took.",
      statementGoodFaith: true,
      statementAccuracy: true,
      signature: "A. Rights-Holder",
      handledBy: who.id,
      nodes: [{ nodeId: file.id, nodeName: "photo.jpg", sha256 }],
    });
    const snapshot = await testDb()
      .select()
      .from(dmcaNoticeNodes)
      .where(eq(dmcaNoticeNodes.noticeId, made!.id));
    expect(snapshot).toEqual([{ noticeId: made!.id, nodeId: file.id, nodeName: "photo.jpg", sha256 }]);
    expect(await auditOf("admin.dmca_notice_created", made!.id)).toHaveLength(1);
  });

  it("a notice naming two uploaders' files is split: one notice per alleged infringer", async () => {
    const who = await admin();
    const owner = await member();
    const editor = await member();
    const mine = await makeFile(owner.id, null, { scanStatus: "clean" });
    const theirs = await makeFile(owner.id, null, { scanStatus: "clean", createdBy: editor.id });
    await uploadAddress(theirs.id, theirs.versionId!, editor.id, "192.0.2.20");
    const answer = await adminCall(who.as, "POST", "/dmca", { body: intake([mine.id, theirs.id]) });
    expect(answer.status).toBe(200);
    const named = (answer.body.notices as DmcaNoticeDto[]).map((n) => n.nodes.map((node) => node.nodeId));
    expect(named).toHaveLength(2);
    expect(named.map((ids) => ids.length)).toEqual([1, 1]);
    expect(named.flat().sort()).toEqual([mine.id, theirs.id].sort());
  });
});

describe("take down", () => {
  it("links are PAUSED (moderation), never revoked; the node is hidden; the uploader struck; the dmca entry listed; the owner mailed once", async () => {
    const who = await admin();
    const owner = await member();
    const sha256 = madeUpSha();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256 });
    const link = await makeLink(file.id, owner.id);
    const made = await notice(who, [file.id]);
    const answer = await act(who, made.id, "takedown", { note: "Complete notice." });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "actioned" });
    expect(answer.body.strikeId).not.toBeNull();
    expect(answer.body.ownerNotifiedAt).not.toBeNull();
    const row = await linkRowOf(link.id);
    expect(row.pauseReasons).toEqual(["moderation"]);
    expect(row.revokedAt).toBeNull();
    expect(await nodeRowOf(file.id)).toMatchObject({ takedownReason: "dmca", takedownBy: who.id });
    const strikes = await strikesOfUser(owner.id);
    expect(strikes.map((s) => [s.id, s.kind])).toEqual([[answer.body.strikeId, "dmca"]]);
    expect(await blocklistRow(sha256)).toMatchObject({ reason: "dmca", sourceNodeId: file.id });
    expect(mailTo(owner.row.email, "contentRemovedCopyright")).toHaveLength(1);
    expect(await auditOf("admin.dmca_takedown", made.id)).toHaveLength(1);
  });

  it("a notice that never allowed a takedown (rejected) → 409, nothing taken down", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await notice(who, [file.id]);
    expect((await act(who, made.id, "reject")).status).toBe(200);
    const answer = await act(who, made.id, "takedown");
    expect(answer.status).toBe(409);
    expect((await nodeRowOf(file.id))!.takedownAt).toBeNull();
    expect(await strikesOfUser(owner.id)).toEqual([]);
  });
});

describe("an open notice holds the node; a closed one releases it", () => {
  it("received and actioned hold it from purge; closed (taken down, no counter-notice) does not", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const purgeable = async () => {
      try {
        await assertPurgeable(testDb(), [file.id]);
        return true;
      } catch (error) {
        if (error instanceof LegalHoldError) return false;
        throw error;
      }
    };
    expect(await purgeable()).toBe(true);
    const made = await notice(who, [file.id]);
    expect(await purgeable()).toBe(false);
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    expect(await purgeable()).toBe(false);
    const closed = await act(who, made.id, "close");
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("closed");
    expect(await purgeable()).toBe(true);
    // Closed is no restore: the node stays down.
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
  });
});

describe("the counter-notice window: 10 and 14 business days after the forward", () => {
  it("forwarded on a Friday: both weekends skipped — not before Friday + 14 days, by Thursday + 20", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const forwardAt = nextFriday(new Date());
    const forwarded = await upToForward(who, [file.id], forwardAt);
    expect(forwarded.counterForwardedAt).toBe(forwardAt.toISOString());
    expect(forwarded.restoreNotBefore).toBe(new Date(forwardAt.getTime() + 14 * DAY).toISOString());
    expect(forwarded.restoreNotAfter).toBe(new Date(forwardAt.getTime() + 20 * DAY).toISOString());
    expect(new Date(forwarded.restoreNotBefore!).getUTCDay()).toBe(5);
    expect(new Date(forwarded.restoreNotAfter!).getUTCDay()).toBe(4);
  });

  it("restore is refused before restoreNotBefore (409 before_window, checked in the Worker) and allowed from it", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, owner.id);
    const forwardAt = nextFriday(new Date());
    const forwarded = await upToForward(who, [file.id], forwardAt);
    vi.setSystemTime(new Date(new Date(forwarded.restoreNotBefore!).getTime() - 60_000));
    const early = await act(who, forwarded.id, "restore");
    expect(early.status).toBe(409);
    expect(early.body.details.reason).toBe("before_window");
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
    expect((await linkRowOf(link.id)).pauseReasons).toEqual(["moderation"]);
    vi.setSystemTime(new Date(forwarded.restoreNotBefore!));
    const restored = await act(who, forwarded.id, "restore");
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("restored");
  });

  it("after a lawsuit notice the material stays down: restore 409 lawsuit, status upheld", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const forwardAt = nextFriday(new Date());
    const forwarded = await upToForward(who, [file.id], forwardAt);
    const lawsuit = await act(who, forwarded.id, "lawsuit_notice");
    expect(lawsuit.status).toBe(200);
    expect(lawsuit.body.status).toBe("upheld");
    expect(lawsuit.body.lawsuitNoticeAt).not.toBeNull();
    vi.setSystemTime(new Date(new Date(forwarded.restoreNotBefore!).getTime() + DAY));
    const refused = await act(who, forwarded.id, "restore");
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe("lawsuit");
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
  });
});

describe("a full DMCA cycle: notice → takedown → counter-notice → restore inside the window", () => {
  it("on T05's columns: the same links come back live, the strike is lifted, the dmca entry removed, the owner told", async () => {
    const who = await admin();
    const owner = await member();
    const sha256 = madeUpSha();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256 });
    const link = await makeLink(file.id, owner.id);
    const forwardAt = nextFriday(new Date());
    const forwarded = await upToForward(who, [file.id], forwardAt);
    expect(forwarded.status).toBe("counter_received");
    expect(forwarded.counterReceivedAt).not.toBeNull();
    vi.setSystemTime(new Date(new Date(forwarded.restoreNotBefore!).getTime() + DAY));
    const restored = await act(who, forwarded.id, "restore");
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ status: "restored", restoredBy: who.id });
    expect(await nodeRowOf(file.id)).toMatchObject({
      takedownAt: null,
      takedownReason: null,
      takedownBy: null,
    });
    const row = await linkRowOf(link.id);
    expect([row.pauseReasons, row.pausedAt, row.revokedAt]).toEqual([[], null, null]);
    const [strike] = await strikesOfUser(owner.id);
    expect(strike!.id).toBe(restored.body.strikeId);
    expect(strike!.liftedAt).not.toBeNull();
    expect(await blocklistRow(sha256)).toBeNull();
    expect(mailTo(owner.row.email, "contentRestored")).toHaveLength(1);
    expect(await auditOf("admin.dmca_restore", forwarded.id)).toHaveLength(1);
  });
});

describe("a FOLDER taken down and restored by subtree", () => {
  it("every link in the folder paused with moderation and back; the owner's own pause kept; a separately taken-down file keeps its pause; shares untouched", async () => {
    const who = await admin();
    const owner = await member();
    const grantee = await member();
    const folder = await makeFolder(owner.id);
    const sub = await makeFolder(owner.id, folder.id);
    const inFolder = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const inSub = await makeFile(owner.id, sub.id, { scanStatus: "clean" });
    const sibling = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const elsewhere = await makeFile(owner.id, null, { scanStatus: "clean" });
    const onFolder = await makeLink(folder.id, owner.id);
    const onFile = await makeLink(inFolder.id, owner.id);
    const onSub = await makeLink(inSub.id, owner.id);
    const ownerPaused = await makeLink(sibling.id, owner.id, ["owner"]);
    const outside = await makeLink(elsewhere.id, owner.id);
    await makeShare(folder.id, owner.id, grantee.id, { role: "viewer" });
    const sharesOf = () => testDb().select().from(shares).where(eq(shares.nodeId, folder.id));
    const sharesBefore = await sharesOf();
    const reasons = async () => ({
      onFolder: (await linkRowOf(onFolder.id)).pauseReasons,
      onFile: (await linkRowOf(onFile.id)).pauseReasons,
      onSub: (await linkRowOf(onSub.id)).pauseReasons,
      ownerPaused: (await linkRowOf(ownerPaused.id)).pauseReasons,
      outside: (await linkRowOf(outside.id)).pauseReasons,
    });

    const forwardAt = nextFriday(new Date());
    const first = await notice(who, [folder.id]);
    expect((await act(who, first.id, "takedown")).status).toBe(200);
    expect(await reasons()).toEqual({
      onFolder: ["moderation"],
      onFile: ["moderation"],
      onSub: ["moderation"],
      ownerPaused: ["owner", "moderation"],
      outside: [],
    });
    // The grantee: hidden is inherited — the folder is not found by id.
    expect((await nodesApi(grantee.as, "GET", `/nodes/${folder.id}`)).status).toBe(404);
    // A second notice takes the file in the subfolder down on its own.
    const second = await notice(who, [inSub.id]);
    expect((await act(who, second.id, "takedown")).status).toBe(200);

    expect((await counter(who, first.id)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(forwardAt);
    expect((await act(who, first.id, "forward_counter")).status).toBe(200);
    vi.setSystemTime(new Date(forwardAt.getTime() + 15 * DAY));
    expect((await act(who, first.id, "restore")).status).toBe(200);

    expect(await reasons()).toEqual({
      onFolder: [],
      onFile: [],
      onSub: ["moderation"],
      ownerPaused: ["owner"],
      outside: [],
    });
    expect(await sharesOf()).toEqual(sharesBefore);
    vi.useRealTimers();
    expect((await nodesApi(grantee.as, "GET", `/nodes/${folder.id}`)).status).toBe(200);
  });
});
