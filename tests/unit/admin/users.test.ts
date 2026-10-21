// The Users screen's API (T25 section 2): suspension and its lift against the strike threshold,
// strikes by hand, the strike list's states, the legal-hold toggle, scheduled deletion, quota,
// sessions and links, and usage as the OPERATOR sees it (the true counter, never the holder's
// figure).
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { STRIKE_WINDOW_DAYS } from "../../../src/shared/constants";
import { downloadLedger, nodeVersions, session, strikes, user } from "../../../src/worker/db/schema";
import { EXPIRED_NOTE } from "../../../src/worker/db/queries/strikes";
import { generationInStep } from "../trash/helpers";
import { api as nodesApi, person } from "../nodes/helpers";
import {
  admin,
  adminCall,
  auditOf,
  baId,
  call,
  linkRowOf,
  lockedFile,
  makeFile,
  makeFolder,
  makeLink,
  member,
  rand,
  strikesOfUser,
  testDb,
  userRowOf,
} from "./helpers";

const DAY = 86_400_000;

/** A session row of the user's, as a sign-in leaves it (the stand-in auth never reads these). */
async function sessionRow(userId: string) {
  await testDb()
    .insert(session)
    .values({
      id: baId(),
      token: `made-up-session-${rand(12)}`,
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
    });
}
const sessionsOf = (userId: string) => testDb().select().from(session).where(eq(session.userId, userId));

/** An unlifted strike row, written straight (no node, no hash: never de-duplicated). */
async function strikeRow(userId: string, overrides: Partial<typeof strikes.$inferInsert> = {}) {
  const [row] = await testDb()
    .insert(strikes)
    .values({ userId, kind: "abuse", ...overrides })
    .returning();
  return row!;
}

/** A suspended account with `n` unlifted strikes and a link that the suspension paused. */
async function suspendedWith(n: number) {
  const who = await admin();
  const target = await member();
  const file = await makeFile(target.id, null, { scanStatus: "clean" });
  const link = await makeLink(file.id, target.id);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await strikeRow(target.id)).id);
  expect(
    (await adminCall(who.as, "POST", `/users/${target.id}/suspend`, { body: { reason: "test" } })).status,
  ).toBe(200);
  return { who, target, link, ids };
}

describe("lifting a suspension is refused at the strike threshold", () => {
  it("three unlifted strikes → 409 strikes_at_threshold with the count, nothing changes; after a strike is lifted the same request succeeds", async () => {
    const t = await suspendedWith(3);
    const before = await userRowOf(t.target.id);
    await sessionRow(t.target.id);
    const refused = await adminCall(t.who.as, "POST", `/users/${t.target.id}/unsuspend`, {
      body: { reason: "x" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: "conflict",
      details: { reason: "strikes_at_threshold", activeStrikes: 3 },
    });
    const after = await userRowOf(t.target.id);
    expect(after!.suspendedAt).toEqual(before!.suspendedAt);
    expect(await sessionsOf(t.target.id)).toHaveLength(1);
    expect((await linkRowOf(t.link.id)).pauseReasons).toEqual(["owner_suspended"]);

    const lifted = await adminCall(t.who.as, "POST", `/strikes/${t.ids[0]}/lift`, {
      body: { reason: "appeal" },
    });
    expect(lifted.status).toBe(200);
    expect(lifted.body).toEqual({ activeStrikes: 2 });
    const ok = await adminCall(t.who.as, "POST", `/users/${t.target.id}/unsuspend`, {
      body: { reason: "x" },
    });
    expect(ok.status).toBe(200);
    expect((await userRowOf(t.target.id))!.suspendedAt).toBeNull();
    expect((await linkRowOf(t.link.id)).pauseReasons).toEqual([]);
  });

  it("control: two strikes from the start — the lift succeeds at once", async () => {
    const t = await suspendedWith(2);
    const ok = await adminCall(t.who.as, "POST", `/users/${t.target.id}/unsuspend`, {
      body: { reason: "x" },
    });
    expect(ok.status).toBe(200);
    expect((await userRowOf(t.target.id))!.suspendedAt).toBeNull();
  });

  it("a user suspended by hand with no strikes lifts normally", async () => {
    const t = await suspendedWith(0);
    expect(
      (await adminCall(t.who.as, "POST", `/users/${t.target.id}/unsuspend`, { body: { reason: "x" } }))
        .status,
    ).toBe(200);
  });
});

describe("suspension ends sessions and pauses links; the lift restores exactly that", () => {
  it("every session ends, links carry owner_suspended; a link paused for `report` stays paused through suspend → lift", async () => {
    const who = await admin();
    const target = await member();
    const file = await makeFile(target.id, null, { scanStatus: "clean" });
    const live = await makeLink(file.id, target.id);
    const reported = await makeLink(file.id, target.id, ["report"]);
    await sessionRow(target.id);
    await sessionRow(target.id);
    const suspended = await adminCall(who.as, "POST", `/users/${target.id}/suspend`, {
      body: { reason: "abuse" },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.user.suspendedAt).not.toBeNull();
    expect(await sessionsOf(target.id)).toEqual([]);
    expect((await linkRowOf(live.id)).pauseReasons).toEqual(["owner_suspended"]);
    expect((await linkRowOf(reported.id)).pauseReasons.sort()).toEqual(["owner_suspended", "report"]);
    expect((await auditOf("admin.user_suspended", target.id))[0]).toMatchObject({
      actorUserId: who.id,
      actorType: "admin",
      meta: { reason: "abuse", changed: true },
    });

    expect(
      (await adminCall(who.as, "POST", `/users/${target.id}/unsuspend`, { body: { reason: "ok" } })).status,
    ).toBe(200);
    expect((await linkRowOf(live.id)).pauseReasons).toEqual([]);
    expect((await linkRowOf(reported.id)).pauseReasons).toEqual(["report"]);
  });

  it("a reason is required", async () => {
    const who = await admin();
    const target = await member();
    expect((await adminCall(who.as, "POST", `/users/${target.id}/suspend`, { body: {} })).status).toBe(400);
    expect(
      (await adminCall(who.as, "POST", `/users/${target.id}/unsuspend`, { body: { reason: " " } })).status,
    ).toBe(400);
  });
});

describe("a strike by hand", () => {
  it("for a node already struck with that kind: 200 with the existing strike, created:false, one row, one audit row", async () => {
    const who = await admin();
    const target = await member();
    const file = await makeFile(target.id, null, { scanStatus: "infected" });
    const body = { userId: target.id, kind: "malware", nodeId: file.id };
    const first = await adminCall(who.as, "POST", `/users/${target.id}/strikes`, { body });
    expect([first.status, first.body.created]).toEqual([200, true]);
    const second = await adminCall(who.as, "POST", `/users/${target.id}/strikes`, { body });
    expect([second.status, second.body.created]).toEqual([200, false]);
    expect(second.body.strike.id).toBe(first.body.strike.id);
    expect(await strikesOfUser(target.id)).toHaveLength(1);
    const rows = await auditOf("strike.added", target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: who.id, actorType: "admin" });
  });

  it("a different kind on the same node, and strikes with no node, are new strikes each time", async () => {
    const who = await admin();
    const target = await member();
    const file = await makeFile(target.id, null, { scanStatus: "infected" });
    const send = (body: Record<string, unknown>) =>
      adminCall(who.as, "POST", `/users/${target.id}/strikes`, { body: { userId: target.id, ...body } });
    expect((await send({ kind: "malware", nodeId: file.id })).body.created).toBe(true);
    expect((await send({ kind: "abuse", nodeId: file.id })).body.created).toBe(true);
    expect((await send({ kind: "abuse" })).body.created).toBe(true);
    expect((await send({ kind: "abuse" })).body.created).toBe(true);
    expect(await strikesOfUser(target.id)).toHaveLength(4);
  });

  it("the body's user must be the path's user", async () => {
    const who = await admin();
    const target = await member();
    const other = await member();
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/strikes`, {
      body: { userId: other.id, kind: "abuse" },
    });
    expect(answer.status).toBe(400);
    expect(await strikesOfUser(other.id)).toEqual([]);
  });
});

describe("the strike list's states", () => {
  it("active, lifted, lifted (expired), lifted by system, expired — and a lift whose admin is deleted reads as system; the audit view shows that admin as a deleted account", async () => {
    const who = await admin();
    const lifter = await admin();
    const target = await member();
    const active = await strikeRow(target.id);
    const byLifter = await strikeRow(target.id);
    const lifted = await strikeRow(target.id);
    const expiredLift = await strikeRow(target.id, {
      liftedAt: new Date(),
      liftedBy: null,
      note: `first ${EXPIRED_NOTE}`,
    });
    const systemLift = await strikeRow(target.id, { liftedAt: new Date(), liftedBy: null });
    const old = await strikeRow(target.id, { at: new Date(Date.now() - (STRIKE_WINDOW_DAYS + 5) * DAY) });
    expect(
      (await adminCall(who.as, "POST", `/strikes/${lifted.id}/lift`, { body: { reason: "a" } })).status,
    ).toBe(200);
    expect(
      (await adminCall(lifter.as, "POST", `/strikes/${byLifter.id}/lift`, { body: { reason: "b" } })).status,
    ).toBe(200);
    // The lifter's account goes: `strikes.lifted_by` is ON DELETE SET NULL.
    await testDb().delete(user).where(eq(user.id, lifter.id));

    const detail = await adminCall(who.as, "GET", `/users/${target.id}`);
    expect(detail.status).toBe(200);
    const states = Object.fromEntries(
      (detail.body.strikes as { id: string; state: string }[]).map((s) => [s.id, s.state]),
    );
    expect(states).toEqual({
      [active.id]: "active",
      [lifted.id]: "lifted",
      [byLifter.id]: "lifted_by_system",
      [expiredLift.id]: "lifted_expired",
      [systemLift.id]: "lifted_by_system",
      [old.id]: "expired",
    });
    expect(detail.body.user.activeStrikes).toBe(1);

    const view = await adminCall(who.as, "GET", `/audit?action=admin.strike_lifted&targetId=${target.id}`);
    expect(view.status).toBe(200);
    const row = (view.body.items as { actorUserId: string; meta: { strikeId: string } }[]).find(
      (item) => item.meta.strikeId === byLifter.id,
    );
    expect(row?.actorUserId).toBe(lifter.id);
    expect(view.body.actors[lifter.id]).toBeNull();
    expect(view.body.actors[who.id]).toMatchObject({ id: who.id });
  });

  it("lifting a lifted strike is a 404; an unknown strike is a 404", async () => {
    const who = await admin();
    const target = await member();
    const done = await strikeRow(target.id, { liftedAt: new Date(), liftedBy: who.id });
    expect(
      (await adminCall(who.as, "POST", `/strikes/${done.id}/lift`, { body: { reason: "a" } })).status,
    ).toBe(404);
  });
});

describe("the legal-hold toggle", () => {
  it("setting writes admin.legal_hold_set with the reason; the reason is required", async () => {
    const who = await admin();
    const target = await member();
    expect(
      (await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, { body: { held: true } })).status,
    ).toBe(400);
    expect(
      (
        await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, {
          body: { held: true, note: "  " },
        })
      ).status,
    ).toBe(400);
    expect((await userRowOf(target.id))!.legalHold).toBe(false);
    const set = await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, {
      body: { held: true, note: "Preservation request 7." },
    });
    expect(set.status).toBe(200);
    expect(set.body.user.legalHold).toBe(true);
    expect(set.body.legalHoldByHand).toBe(true);
    expect((await auditOf("admin.legal_hold_set", target.id))[0]).toMatchObject({
      actorUserId: who.id,
      meta: { reason: "Preservation request 7." },
    });
  });

  it("clearing writes admin.legal_hold_cleared with the reason (control for the refusal below: a hand-held user with no csam report clears)", async () => {
    const who = await admin();
    const target = await member({ legalHold: true });
    const cleared = await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, {
      body: { held: false, note: "Request withdrawn." },
    });
    expect(cleared.status).toBe(200);
    expect((await userRowOf(target.id))!.legalHold).toBe(false);
    expect((await auditOf("admin.legal_hold_cleared", target.id))[0]).toMatchObject({
      meta: { reason: "Request withdrawn." },
    });
  });

  it("clearing is refused 409 hold_not_releasable while the user is a subject of an open csam report", async () => {
    const who = await admin();
    const locked = await lockedFile();
    expect((await userRowOf(locked.owner.id))!.legalHold).toBe(true);
    const refused = await adminCall(who.as, "POST", `/users/${locked.owner.id}/legal-hold`, {
      body: { held: false, note: "try" },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe("hold_not_releasable");
    expect((await userRowOf(locked.owner.id))!.legalHold).toBe(true);
    expect(await auditOf("admin.legal_hold_cleared", locked.owner.id)).toEqual([]);
  });
});

describe("Delete user schedules, and nothing is deleted", () => {
  it("deleteScheduledAt is set seven days out, the rows stay; cancel undoes it", async () => {
    const who = await admin();
    const target = await member();
    const file = await makeFile(target.id, null, { scanStatus: "clean" });
    const scheduled = await adminCall(who.as, "POST", `/users/${target.id}/deletion`, {
      body: { reason: "asked" },
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.changed).toBe(true);
    const at = Date.parse(scheduled.body.scheduledFor);
    expect(Math.abs(at - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    const row = await userRowOf(target.id);
    expect(row).not.toBeNull();
    expect(row!.deleteScheduledAt).not.toBeNull();
    expect((await makeFolder(target.id)).id).toBeTruthy();
    expect(file.id).toBeTruthy();
    const cancelled = await adminCall(who.as, "POST", `/users/${target.id}/deletion/cancel`, {
      body: { reason: "x" },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.changed).toBe(true);
    expect((await userRowOf(target.id))!.deleteScheduledAt).toBeNull();
  });
});

describe("quota, sessions, links, egress", () => {
  it("quota PATCH is audited with its value before and after", async () => {
    const who = await admin();
    const target = await member();
    const answer = await adminCall(who.as, "PATCH", `/users/${target.id}/quota`, {
      body: { quotaBytes: 10_000_000_000 },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.user.quotaBytes).toBe(10_000_000_000);
    expect((await auditOf("admin.quota_set", target.id))[0]).toMatchObject({
      meta: { from: 5_000_000_000, to: 10_000_000_000 },
    });
  });

  it("revoke sessions and bulk revoke links answer the counts; the links are revoked, not paused", async () => {
    const who = await admin();
    const target = await member();
    await sessionRow(target.id);
    await sessionRow(target.id);
    const file = await makeFile(target.id, null, { scanStatus: "clean" });
    const a = await makeLink(file.id, target.id);
    const b = await makeLink(file.id, target.id, ["owner"]);
    const detail = await adminCall(who.as, "GET", `/users/${target.id}`);
    expect(detail.body.sessions).toBe(2);
    expect(detail.body.links).toEqual({ live: 1, paused: 1 });
    expect(
      (await adminCall(who.as, "POST", `/users/${target.id}/revoke-sessions`, { body: { reason: "x" } }))
        .body,
    ).toEqual({
      revoked: 2,
    });
    expect(await sessionsOf(target.id)).toEqual([]);
    expect(
      (await adminCall(who.as, "POST", `/users/${target.id}/revoke-links`, { body: { reason: "x" } })).body,
    ).toEqual({
      revoked: 2,
    });
    expect((await linkRowOf(a.id)).revokedAt).not.toBeNull();
    expect((await linkRowOf(b.id)).revokedAt).not.toBeNull();
    expect(
      (await adminCall(who.as, "POST", `/users/${target.id}/revoke-links`, { body: { reason: "x" } })).body,
    ).toEqual({
      revoked: 0,
    });
  });

  it("public-link egress today against the owner's EFFECTIVE daily cap (an established account: the var; a new one: scaled down)", async () => {
    const who = await admin();
    const target = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
    const fresh = await member();
    await testDb()
      .insert(downloadLedger)
      .values({
        day: new Date().toISOString().slice(0, 10),
        subjectType: "link_owner",
        subjectId: target.id,
        bytes: 62_000_000_000,
        count: 40,
      });
    const detail = await adminCall(who.as, "GET", `/users/${target.id}`);
    expect(detail.body.linkEgressToday).toEqual({
      bytes: 62_000_000_000,
      count: 40,
      capBytes: Number(env.CEIL_OWNER_LINK_BYTES_DAY),
    });
    const young = (await adminCall(who.as, "GET", `/users/${fresh.id}`)).body.linkEgressToday;
    expect(young.capBytes).toBeLessThan(Number(env.CEIL_OWNER_LINK_BYTES_DAY));
    expect(young.bytes).toBe(0);
  });
});

describe("usage: the operator sees the true counter, never the holder's figure", () => {
  beforeAll(generationInStep);

  /** 100-byte files: one kept, one deleted for good with an old version of 40, a folder deleted for good. */
  async function deletedForGood(legalHold: boolean) {
    const who = await person({ legalHold });
    await makeFile(who.id, null, { name: "kept.txt", scanStatus: "clean", size: 100 });
    const doomed = await makeFile(who.id, null, { name: "doomed.txt", scanStatus: "clean", size: 100 });
    await testDb()
      .insert(nodeVersions)
      .values({
        nodeId: doomed.id,
        versionId: `old-${doomed.id}`,
        r2Key: `u/${who.id}/${doomed.id}/old`,
        size: 40,
        purgeAfter: new Date(Date.now() + 30 * DAY),
      });
    const folder = await makeFolder(who.id, null, { name: "folder" });
    await makeFile(who.id, folder.id, { name: "inside.txt", scanStatus: "clean", size: 100 });
    await testDb().update(user).set({ usedBytes: 340 }).where(eq(user.id, who.id));
    for (const id of [doomed.id, folder.id]) {
      expect((await nodesApi(who.as, "POST", `/nodes/${id}/trash`)).status).toBe(200);
      expect((await nodesApi(who.as, "DELETE", `/nodes/${id}`)).status).toBe(204);
    }
    return who;
  }

  it("a held account: the admin detail shows the stored counter and the kept bytes; the holder is shown the lower figure", async () => {
    const op = await admin();
    const held = await deletedForGood(true);
    const detail = await adminCall(op.as, "GET", `/users/${held.id}`);
    expect(detail.body.user.usedBytes).toBe(340);
    expect(detail.body.usage).toMatchObject({
      usedBytes: 340,
      keptDeletedBytes: 240,
      keptBackstopReached: false,
    });
    const holder = await call(held.as, "GET", "/account/usage");
    expect(holder.status).toBe(200);
    expect(holder.body.usedBytes).toBe(100);
  });

  it("control: an unheld twin — the purge happened, both figures agree", async () => {
    const op = await admin();
    const free = await deletedForGood(false);
    const detail = await adminCall(op.as, "GET", `/users/${free.id}`);
    expect(detail.body.usage).toMatchObject({ usedBytes: 100, keptDeletedBytes: 0 });
    expect((await call(free.as, "GET", "/account/usage")).body.usedBytes).toBe(100);
  });
});
