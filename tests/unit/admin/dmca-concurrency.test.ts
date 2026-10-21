// One notice, one takedown, one strike (T25 section 7, ruling 2026-10-12): the strike is inserted
// in the SAME transaction as the notice's conditional transition, so a double-click, a retried
// request and two concurrent requests all end with one strike, `strikeId` set once and one owner
// mail — and a transaction that fails after the strike insert leaves neither.
//
// Concurrency is real: two requests, each through its own app and database pool, at once.
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as adminQueries from "../../../src/worker/db/queries/admin";
import { dmcaNotices } from "../../../src/worker/db/schema";
import { mailTo } from "../auth/helpers";
import { admin, adminCall, makeFile, member, nodeRowOf, strikesOfUser, testDb, type Answer } from "./helpers";

// A seam for one failing statement AFTER the strike insert, inside the takedown's transaction.
vi.mock("../../../src/worker/db/queries/admin", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/admin")>();
  return { ...real, updateNotice: vi.fn(real.updateNotice) };
});

type Admin = Awaited<ReturnType<typeof admin>>;

async function receivedNotice(who: Admin) {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const answer = await adminCall(who.as, "POST", "/dmca", {
    body: {
      receivedVia: "email",
      complainantName: "A. Rights-Holder",
      infringingDescription: "The named file.",
      statementGoodFaith: true,
      statementAccuracy: true,
      nodeIds: [file.id],
    },
  });
  expect(answer.status).toBe(200);
  return { owner, file, noticeId: answer.body.notices[0].id as string };
}

const takedown = (who: Admin, id: string) =>
  adminCall(who.as, "POST", `/dmca/${id}/action`, { body: { action: "takedown", note: "Complete notice." } });

const noticeRow = async (id: string) =>
  (await testDb().select().from(dmcaNotices).where(eq(dmcaNotices.id, id)))[0]!;

function expectSameAnswer(a: Answer, b: Answer) {
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(a.body).toEqual(b.body);
}

describe("one notice, one takedown, one strike", () => {
  it("sent twice in sequence: one strike, strikeId set once, one owner mail, the same answer", async () => {
    const who = await admin();
    const t = await receivedNotice(who);
    const first = await takedown(who, t.noticeId);
    const second = await takedown(who, t.noticeId);
    expectSameAnswer(first, second);
    const strikes = await strikesOfUser(t.owner.id);
    expect(strikes).toHaveLength(1);
    expect((await noticeRow(t.noticeId)).strikeId).toBe(strikes[0]!.id);
    expect(mailTo(t.owner.row.email, "contentRemovedCopyright")).toHaveLength(1);
  });

  it("sent twice CONCURRENTLY (real transactions): one strike, strikeId set once, one owner mail, the same answer", async () => {
    const who = await admin();
    const t = await receivedNotice(who);
    const [a, b] = await Promise.all([takedown(who, t.noticeId), takedown(who, t.noticeId)]);
    const strikes = await strikesOfUser(t.owner.id);
    expect(strikes).toHaveLength(1);
    expectSameAnswer(a, b);
    expect((await noticeRow(t.noticeId)).strikeId).toBe(strikes[0]!.id);
    expect(mailTo(t.owner.row.email, "contentRemovedCopyright")).toHaveLength(1);
  });

  it("a takedown whose transaction fails after the strike insert leaves no strike and the notice un-actioned", async () => {
    const who = await admin();
    const t = await receivedNotice(who);
    vi.mocked(adminQueries.updateNotice).mockImplementationOnce(async () => {
      throw new Error("the connection was lost after the strike insert (made up for a test)");
    });
    const failed = await takedown(who, t.noticeId);
    expect(failed.status).toBe(500);
    expect(await strikesOfUser(t.owner.id)).toEqual([]);
    expect(await noticeRow(t.noticeId)).toMatchObject({
      status: "received",
      strikeId: null,
      ownerNotifiedAt: null,
    });
    expect((await nodeRowOf(t.file.id))!.takedownAt).toBeNull();
    expect(mailTo(t.owner.row.email, "contentRemovedCopyright")).toHaveLength(0);
    // And the retry goes through, once.
    expect((await takedown(who, t.noticeId)).status).toBe(200);
    expect(await strikesOfUser(t.owner.id)).toHaveLength(1);
  });
});
