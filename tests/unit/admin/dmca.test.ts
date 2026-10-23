// The DMCA workflow (T25 section 7) on T05's columns: intake (snapshotted, split per alleged
// infringer), take down (links PAUSED with `moderation`, the strike, the owner's mail once), the
// counter-notice and its window (10 / 14 business days after the counter-notice's RECEIPT,
// weekends and US federal holidays skipped, compared with the Worker's clock — both ends), the
// complainant's mails (the counter-notice forwarded, the restore), restore inside the window, the lawsuit notice, close — and a FOLDER taken down
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
  rand,
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

/** The next Friday at noon UTC after `from` (a window from a Friday crosses two weekends). */
function nextFriday(from: Date): Date {
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 12));
  while (at.getUTCDay() !== 5) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/**
 * Notice → take down → counter-notice RECEIVED at `receivedAt` → forwarded at `forwardAt` (by
 * default the same moment). The clock is set to each in turn.
 */
async function upToForward(who: Admin, nodeIds: string[], receivedAt: Date, forwardAt = receivedAt) {
  const made = await notice(who, nodeIds);
  expect((await act(who, made.id, "takedown", { note: "Complete notice." })).status).toBe(200);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(receivedAt);
  expect((await counter(who, made.id)).status).toBe(200);
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
    expect(snapshot).toEqual([
      { noticeId: made!.id, nodeId: file.id, nodeName: "photo.jpg", sha256, tookDown: false },
    ]);
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

describe("the counter-notice window: 10 and 14 business days after RECEIPT of the counter-notice", () => {
  // A fixed date inside the holiday table (business-days.ts ends 2028-12-31), not 2099: the
  // window is computed from the table, and a date past it is refused. Received Friday 3 November
  // 2028; Veterans Day is observed on Friday 10 November and Thanksgiving is Thursday 23 November.
  const RECEIVED = new Date("2028-11-03T12:00:00.000Z");

  it("counted from the receipt, not the forward click; weekends and US federal holidays skipped; the end is the whole 14th day", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    // Forwarded the next Monday: a window from the click would run 21 to 28 November.
    const forwardAt = new Date("2028-11-06T09:00:00.000Z");
    const forwarded = await upToForward(who, [file.id], RECEIVED, forwardAt);
    expect(forwarded.counterReceivedAt).toBe(RECEIVED.toISOString());
    expect(forwarded.counterForwardedAt).toBe(forwardAt.toISOString());
    // 10 business days after Fri 3 Nov: 6–9, (10 Veterans Day), 13–17, 20 → Mon 20 Nov.
    expect(forwarded.restoreNotBefore).toBe("2028-11-20T12:00:00.000Z");
    // 14: 21, 22, (23 Thanksgiving), 24, 27 → the whole of Mon 27 Nov.
    expect(forwarded.restoreNotAfter).toBe("2028-11-27T23:59:59.999Z");
  });

  it("a counter-notice recorded later with its real receipt date: the window is from that date", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await notice(who, [file.id]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-11-01T08:00:00.000Z"));
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    // Typed in on Wednesday 8 November; it arrived on Friday 3 November.
    vi.setSystemTime(new Date("2028-11-08T10:00:00.000Z"));
    const recorded = await adminCall(who.as, "POST", `/dmca/${made.id}/counter`, {
      body: {
        counterName: "The Uploader",
        counterAddress: "2 Example Road",
        counterEmail: "uploader@example.test",
        counterStatement: "I believe in good faith the file was removed by mistake.",
        counterConsentJurisdiction: true,
        counterSignature: "The Uploader",
        counterReceivedAt: RECEIVED.toISOString(),
      },
    });
    expect(recorded.status).toBe(200);
    const forwarded = await act(who, made.id, "forward_counter");
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.restoreNotBefore).toBe("2028-11-20T12:00:00.000Z");
    expect(forwarded.body.restoreNotAfter).toBe("2028-11-27T23:59:59.999Z");
  });

  it("a receipt date in the future, or before the takedown, is refused (it would move the window)", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await notice(who, [file.id]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-11-01T08:00:00.000Z"));
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    vi.setSystemTime(RECEIVED);
    const at = (counterReceivedAt: string) =>
      adminCall(who.as, "POST", `/dmca/${made.id}/counter`, {
        body: {
          counterName: "The Uploader",
          counterAddress: "2 Example Road",
          counterEmail: "uploader@example.test",
          counterStatement: "Removed by mistake.",
          counterConsentJurisdiction: true,
          counterSignature: "The Uploader",
          counterReceivedAt,
        },
      });
    const future = await at("2028-11-04T12:00:00.000Z");
    expect(future.status).toBe(400);
    expect(future.body.details.reason).toBe("counter_received_at");
    const beforeTakedown = await at("2028-10-31T12:00:00.000Z");
    expect(beforeTakedown.status).toBe(400);
    expect(beforeTakedown.body.details.reason).toBe("counter_received_at");
    expect((await act(who, made.id, "forward_counter")).status).toBe(409);
  });

  it("forwarded once: a second forward is refused and the window does not move", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const forwarded = await upToForward(who, [file.id], RECEIVED);
    vi.setSystemTime(new Date("2028-11-07T12:00:00.000Z"));
    const again = await act(who, forwarded.id, "forward_counter");
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe("already_forwarded");
  });

  it("the window is fixed when the counter-notice is recorded (shown before any forward)", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await notice(who, [file.id]);
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RECEIVED);
    const recorded = await counter(who, made.id);
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({
      counterForwardedAt: null,
      restoreNotBefore: "2028-11-20T12:00:00.000Z",
      restoreNotAfter: "2028-11-27T23:59:59.999Z",
    });
  });

  it("a window that would end past the holiday table is refused with its reason, nothing recorded", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await notice(who, [file.id]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-12-20T12:00:00.000Z"));
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    const refused = await counter(who, made.id);
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe("holiday_table");
    const row = (await adminCall(who.as, "GET", `/dmca/${made.id}`)).body as DmcaNoticeDto;
    expect(row.status).toBe("actioned");
    expect([row.counterReceivedAt, row.restoreNotBefore, row.restoreNotAfter]).toEqual([null, null, null]);
  });

  it("restore before restoreNotBefore stays refused (409 before_window) — even with acknowledgeLate; inside the window it is allowed", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, owner.id);
    const forwarded = await upToForward(who, [file.id], RECEIVED);
    vi.setSystemTime(new Date(new Date(forwarded.restoreNotBefore!).getTime() - 60_000));
    for (const extra of [{}, { acknowledgeLate: true }]) {
      const early = await act(who, forwarded.id, "restore", extra);
      expect(early.status).toBe(409);
      expect(early.body.details).toMatchObject({
        reason: "before_window",
        restoreNotBefore: forwarded.restoreNotBefore,
      });
    }
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
    expect((await linkRowOf(link.id)).pauseReasons).toEqual(["moderation"]);
    vi.setSystemTime(new Date(forwarded.restoreNotAfter!));
    const restored = await act(who, forwarded.id, "restore");
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("restored");
    expect(await auditOf("admin.dmca_restore_late", forwarded.id)).toHaveLength(0);
  });

  it("restore after restoreNotAfter: 409 window_closed without acknowledgeLate; with it, restored, audited late with the dates, the complainant told", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, owner.id);
    const complainant = `legal-${rand(8)}@example.test`;
    const made = (
      await adminCall(who.as, "POST", "/dmca", { body: intake([file.id], { complainantEmail: complainant }) })
    ).body.notices[0] as DmcaNoticeDto;
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RECEIVED);
    expect((await counter(who, made.id)).status).toBe(200);
    const forwarded = (await act(who, made.id, "forward_counter")).body as DmcaNoticeDto;
    const lateAt = new Date(new Date(forwarded.restoreNotAfter!).getTime() + 1);
    vi.setSystemTime(lateAt);
    for (const extra of [{}, { acknowledgeLate: false }]) {
      const refused = await act(who, made.id, "restore", extra);
      expect(refused.status).toBe(409);
      expect(refused.body.details).toMatchObject({
        reason: "window_closed",
        restoreNotAfter: forwarded.restoreNotAfter,
      });
    }
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
    const restored = await act(who, made.id, "restore", {
      acknowledgeLate: true,
      note: "Missed the window.",
    });
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("restored");
    expect((await nodeRowOf(file.id))!.takedownAt).toBeNull();
    expect((await linkRowOf(link.id)).pauseReasons).toEqual([]);
    expect((await auditOf("admin.dmca_restore_late", made.id)).map((row) => row.meta)).toEqual([
      {
        counterReceivedAt: RECEIVED.toISOString(),
        counterForwardedAt: forwarded.counterForwardedAt,
        restoreNotBefore: forwarded.restoreNotBefore,
        restoreNotAfter: forwarded.restoreNotAfter,
        restoredAt: lateAt.toISOString(),
      },
    ]);
    expect(await auditOf("admin.dmca_restore", made.id)).toHaveLength(1);
    expect(mailTo(complainant, "dmcaRestoredComplainant")).toHaveLength(1);
  });

  it("a forward after the window closed is refused (409 forward_window_closed); the late restore still works without it", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const complainant = `legal-${rand(8)}@example.test`;
    const made = (
      await adminCall(who.as, "POST", "/dmca", { body: intake([file.id], { complainantEmail: complainant }) })
    ).body.notices[0] as DmcaNoticeDto;
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RECEIVED);
    const recorded = (await counter(who, made.id)).body as DmcaNoticeDto;
    vi.setSystemTime(new Date(new Date(recorded.restoreNotAfter!).getTime() + 1));
    const forward = await act(who, made.id, "forward_counter");
    expect(forward.status).toBe(409);
    expect(forward.body.details).toMatchObject({
      reason: "forward_window_closed",
      restoreNotAfter: recorded.restoreNotAfter,
    });
    expect(mailTo(complainant, "dmcaCounterForwarded")).toEqual([]);
    expect((await act(who, made.id, "restore")).body.details.reason).toBe("window_closed");
    const restored = await act(who, made.id, "restore", { acknowledgeLate: true, note: "Late." });
    expect(restored.status).toBe(200);
    expect(restored.body.counterForwardedAt).toBeNull();
    expect(await auditOf("admin.dmca_restore_late", made.id)).toHaveLength(1);
    expect(mailTo(complainant, "dmcaRestoredComplainant")).toHaveLength(1);
  });

  it("inside the window a restore needs the forward first (409 not_forwarded)", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await notice(who, [file.id]);
    expect((await act(who, made.id, "takedown")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RECEIVED);
    const recorded = (await counter(who, made.id)).body as DmcaNoticeDto;
    vi.setSystemTime(new Date(recorded.restoreNotBefore!));
    const refused = await act(who, made.id, "restore", { acknowledgeLate: true });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe("not_forwarded");
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
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

describe("the complainant's mails (§512(g)(2)(B)): the counter-notice forwarded, and the restore", () => {
  const RECEIVED = new Date("2028-11-03T12:00:00.000Z");

  async function noticeFor(who: Admin, nodeIds: string[], complainantEmail: string | undefined) {
    const answer = await adminCall(who.as, "POST", "/dmca", {
      body: intake(nodeIds, { complainantEmail }),
    });
    expect(answer.status).toBe(200);
    return answer.body.notices[0] as DmcaNoticeDto;
  }

  async function forwardFor(who: Admin, id: string) {
    expect((await act(who, id, "takedown")).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(RECEIVED);
    const recorded = await adminCall(who.as, "POST", `/dmca/${id}/counter`, {
      body: {
        counterName: "Ada Uploader",
        counterAddress: "2 Example Road\nSpringfield",
        counterPhone: "555 0100",
        counterEmail: "uploader@example.test",
        counterStatement: "I swear under penalty of perjury the file was removed by mistake.",
        counterConsentJurisdiction: true,
        counterSignature: "/Ada Uploader/",
      },
    });
    expect(recorded.status).toBe(200);
    const forwarded = await act(who, id, "forward_counter");
    expect(forwarded.status).toBe(200);
    return forwarded.body as DmcaNoticeDto;
  }

  it("forward: the complainant gets a copy of the counter-notice and the window; restore: the outcome; each recorded in the audit", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", name: "secret-name.jpg" });
    // Made up for the test: one address per test, so the outbox is read for this notice only.
    const complainant = `legal-${rand(8)}@example.test`;
    const made = await noticeFor(who, [file.id], complainant);
    const forwarded = await forwardFor(who, made.id);
    const [copy, ...more] = mailTo(complainant, "dmcaCounterForwarded");
    expect(more).toEqual([]);
    expect(copy!.text).toContain("Ada Uploader");
    expect(copy!.text).toContain("Springfield");
    expect(copy!.text).toContain("555 0100");
    expect(copy!.text).toContain("removed by mistake");
    expect(copy!.text).toContain("Consents to the jurisdiction of the federal court: yes");
    expect(copy!.text).toContain("20 November 2028");
    expect(copy!.text).toContain("27 November 2028");
    expect(copy!.text).toContain(made.id);
    // The complainant is not told the owner's file name (only what their own notice said).
    expect(copy!.text).not.toContain("secret-name");
    expect(mailTo(complainant, "dmcaRestoredComplainant")).toEqual([]);
    expect((await auditOf("admin.dmca_complainant_mail", made.id)).map((row) => row.meta)).toEqual([
      { kind: "counter_forwarded", outcome: "sent" },
    ]);

    vi.setSystemTime(new Date(forwarded.restoreNotBefore!));
    expect((await act(who, made.id, "restore")).status).toBe(200);
    const [outcome, ...again] = mailTo(complainant, "dmcaRestoredComplainant");
    expect(again).toEqual([]);
    expect(outcome!.text).toContain(made.id);
    expect(outcome!.text).toContain("restored");
    expect((await auditOf("admin.dmca_complainant_mail", made.id)).map((row) => row.meta)).toEqual([
      { kind: "counter_forwarded", outcome: "sent" },
      { kind: "restored", outcome: "sent" },
    ]);
  });

  it("a notice with no complainant address (received by post): nothing mailed, and the audit says so", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await noticeFor(who, [file.id], undefined);
    expect(made.complainantEmail).toBeNull();
    await forwardFor(who, made.id);
    expect((await auditOf("admin.dmca_complainant_mail", made.id)).map((row) => row.meta)).toEqual([
      { kind: "counter_forwarded", outcome: "no_address" },
    ]);
  });

  it("a refused restore (before the window) mails nobody", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const complainant = `legal-${rand(8)}@example.test`;
    const made = await noticeFor(who, [file.id], complainant);
    await forwardFor(who, made.id);
    expect((await act(who, made.id, "restore")).status).toBe(409);
    expect(mailTo(complainant, "dmcaRestoredComplainant")).toEqual([]);
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

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(forwardAt);
    expect((await counter(who, first.id)).status).toBe(200);
    const forwarded = await act(who, first.id, "forward_counter");
    expect(forwarded.status).toBe(200);
    // At the window's opening as the forward recorded it — never "+N calendar days": a federal
    // holiday inside the window moves it (CI ec88714: Veterans Day, +15 days was a 409 before_window).
    vi.setSystemTime(new Date((forwarded.body as DmcaNoticeDto).restoreNotBefore!));
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
