// Account state: suspension, bans, scheduled deletion and its cancellation, terms, and what a
// session is worth once an account is suspended, banned or past its deletion date.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccount } from "../../../src/worker/db/queries/auth-lifecycle";
import { markStarted, schedule } from "../../../src/worker/db/queries/user-purge";
import { pendingUserPurges, twoFactor, user } from "../../../src/worker/db/schema";
import {
  acceptTerms,
  cancelDeletion,
  purgeAuthRows,
  revokeSessions,
  scheduleDeletion,
  suspendUser,
  SYSTEM_ACTOR,
  unsuspendUser,
} from "../../../src/worker/services/account-state";
import { coreFor, resolveSettings } from "../../../src/worker/services/request-context";
import {
  accountsOf,
  auditRows,
  CAPTCHA,
  enableTotp,
  freshEmail,
  linkById,
  linkIn,
  mailTo,
  makeFolder,
  makeLink,
  newClient,
  PASSWORD,
  promoteToAdmin,
  send,
  serviceDeps,
  sessionsOf,
  signIn,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
} from "./helpers";

const freshSession = async (client: Parameters<typeof send>[0]) =>
  (await send(client, "/api/auth/get-session?disableCookieCache=true")).body;

const pendingRow = async (userId: string) =>
  (await testDb().select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId)))[0] ?? null;

describe("suspension", () => {
  it("ends every session, pauses the links with owner_suspended, refuses sign-in, mails once — and is idempotent", async () => {
    const { client, user: row, email } = await verifiedUser();
    const second = newClient();
    expect((await signIn(second, email)).status).toBe(200);
    const folder = await makeFolder(row.id);
    const live = await makeLink(folder.id, row.id);
    const reported = await makeLink(folder.id, row.id, ["report"]);
    expect(await sessionsOf(row.id)).toHaveLength(2);

    const { deps, settle } = serviceDeps();
    expect(await suspendUser(deps, row.id, "third strike", SYSTEM_ACTOR)).toBe(true);
    await settle();

    const after = await userById(row.id);
    expect(after!.suspendedAt).toBeInstanceOf(Date);
    expect(after!.suspendedReason).toBe("third strike");
    expect(await sessionsOf(row.id), "the session rows are gone").toEqual([]);
    expect((await linkById(live.id)).pauseReasons).toEqual(["owner_suspended"]);
    expect((await linkById(live.id)).pausedAt).toBeInstanceOf(Date);
    expect((await linkById(live.id)).revokedAt, "paused, not revoked").toBeNull();
    expect((await linkById(reported.id)).pauseReasons).toEqual(["report", "owner_suspended"]);
    expect(await auditRows({ action: "account.suspended", targetId: row.id })).toMatchObject([
      { actorType: "system", meta: { reason: "third strike", sessions: 2, links: 2 } },
    ]);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);

    // Both browsers are signed out as far as the database goes, and cannot sign back in.
    expect(await freshSession(client)).toBeNull();
    expect(await freshSession(second)).toBeNull();
    const refused = await signIn(newClient(), email);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: "ACCOUNT_SUSPENDED",
      message: "This account is suspended. Contact support.",
    });
    expect(await sessionsOf(row.id)).toEqual([]);

    // Idempotent: a redelivered queue message changes nothing and sends no second email.
    const again = serviceDeps();
    expect(await suspendUser(again.deps, row.id, "third strike, again", SYSTEM_ACTOR)).toBe(false);
    await again.settle();
    expect((await userById(row.id))!.suspendedReason).toBe("third strike");
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
    expect(await auditRows({ action: "account.suspended", targetId: row.id })).toHaveLength(1);

    // Lifting it restores only the suspension pause.
    const lift = serviceDeps();
    expect(await unsuspendUser(lift.deps, row.id, { userId: "a".repeat(32), type: "admin" })).toBe(true);
    await lift.settle();
    expect((await userById(row.id))!.suspendedAt).toBeNull();
    expect((await linkById(live.id)).pauseReasons).toEqual([]);
    expect((await linkById(live.id)).pausedAt).toBeNull();
    expect((await linkById(reported.id)).pauseReasons).toEqual(["report"]);
    expect((await signIn(newClient(), email)).status).toBe(200);
    expect(await unsuspendUser(serviceDeps().deps, row.id, SYSTEM_ACTOR)).toBe(false);
    expect(await auditRows({ action: "account.unsuspended", targetId: row.id })).toHaveLength(1);
  });

  it("suspending an account that does not exist changes nothing", async () => {
    const { deps, settle } = serviceDeps();
    expect(await suspendUser(deps, "n".repeat(32), "x", SYSTEM_ACTOR)).toBe(false);
    await settle();
  });

  it("revokeSessions deletes the rows and says how many", async () => {
    const { user: row, email } = await verifiedUser();
    await signIn(newClient(), email);
    expect(await revokeSessions(serviceDeps().deps, row.id)).toBe(2);
    expect(await revokeSessions(serviceDeps().deps, row.id)).toBe(0);
  });
});

describe("a ban made through the admin plugin", () => {
  async function adminAndTarget() {
    const admin = await verifiedUser();
    await promoteToAdmin(admin.user.id);
    const target = await verifiedUser();
    const folder = await makeFolder(target.user.id);
    const link = await makeLink(folder.id, target.user.id);
    return { admin, target, link };
  }

  it("has the same side effects as a suspension, and unbanning restores them", async () => {
    const { admin, target, link } = await adminAndTarget();
    const banned = await send(admin.client, "/api/auth/admin/ban-user", {
      json: { userId: target.user.id, banReason: "spam" },
    });
    expect(banned.status, banned.text).toBe(200);
    expect((await userById(target.user.id))!.banned).toBe(true);
    expect(await sessionsOf(target.user.id)).toEqual([]);
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_suspended"]);
    expect(await auditRows({ action: "account.banned", targetId: target.user.id })).toMatchObject([
      { actorUserId: admin.user.id, actorType: "admin" },
    ]);
    const refused = await signIn(newClient(), target.email);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "BANNED_USER" });

    const unbanned = await send(admin.client, "/api/auth/admin/unban-user", {
      json: { userId: target.user.id },
    });
    expect(unbanned.status, unbanned.text).toBe(200);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
    expect((await signIn(newClient(), target.email)).status).toBe(200);
    expect(await auditRows({ action: "account.unbanned", targetId: target.user.id })).toHaveLength(1);
  });

  it("the pause survives while either a ban or a suspension remains", async () => {
    const { admin, target, link } = await adminAndTarget();
    const s = serviceDeps();
    await suspendUser(s.deps, target.user.id, "abuse", SYSTEM_ACTOR);
    await s.settle();
    await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } });
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_suspended"]);

    // Unban while still suspended: stays paused.
    await send(admin.client, "/api/auth/admin/unban-user", { json: { userId: target.user.id } });
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_suspended"]);
    // Ban again, then lift the suspension while still banned: stays paused.
    await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } });
    const u = serviceDeps();
    expect(await unsuspendUser(u.deps, target.user.id, SYSTEM_ACTOR)).toBe(true);
    await u.settle();
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_suspended"]);
    // Only when neither remains does it go.
    await send(admin.client, "/api/auth/admin/unban-user", { json: { userId: target.user.id } });
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
  });

  it("a ban that has expired is lifted at the next sign-in, links included", async () => {
    const { admin, target, link } = await adminAndTarget();
    await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } });
    await testDb()
      .update(user)
      .set({ banExpires: new Date(Date.now() - 3_600_000) })
      .where(eq(user.id, target.user.id));
    expect((await signIn(newClient(), target.email)).status).toBe(200);
    expect((await userById(target.user.id))!.banned).toBe(false);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
  });
});

describe("scheduled deletion", () => {
  it("writes the pending row, pauses (never revokes) the links, keeps the session, mails once — and is idempotent", async () => {
    const { client, user: row, email } = await verifiedUser();
    const folder = await makeFolder(row.id);
    const link = await makeLink(folder.id, row.id);
    const kept = await makeLink(folder.id, row.id, ["ceiling"]);

    const s = serviceDeps();
    const before = Date.now();
    const outcome = await scheduleDeletion(s.deps, row.id);
    await s.settle();
    expect(outcome.changed).toBe(true);
    const sevenDays = 7 * 86_400_000;
    expect(outcome.scheduledFor!.getTime()).toBeGreaterThanOrEqual(before + sevenDays - 1000);
    expect(outcome.scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now() + sevenDays + 1000);

    expect((await userById(row.id))!.deleteScheduledAt!.getTime()).toBe(outcome.scheduledFor!.getTime());
    const pending = await pendingRow(row.id);
    expect(pending!.scheduledFor.getTime()).toBe(outcome.scheduledFor!.getTime());
    expect(pending!.startedAt).toBeNull();
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_deletion"]);
    expect((await linkById(link.id)).revokedAt).toBeNull();
    expect((await linkById(kept.id)).pauseReasons).toEqual(["ceiling", "owner_deletion"]);
    expect(await sessionsOf(row.id), "the session is kept: the owner must see the banner").toHaveLength(1);
    expect(await freshSession(client)).toMatchObject({ user: { id: row.id } });
    expect(await auditRows({ action: "account.deletion_scheduled", targetId: row.id })).toHaveLength(1);
    const mail = mailTo(email, "deletionScheduled");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain("Cancel deletion");

    // A second request keeps the first date and sends nothing.
    const again = serviceDeps();
    const repeat = await scheduleDeletion(again.deps, row.id);
    await again.settle();
    expect(repeat).toEqual({ scheduledFor: outcome.scheduledFor, changed: false });
    expect(mailTo(email, "deletionScheduled")).toHaveLength(1);
    expect(await auditRows({ action: "account.deletion_scheduled", targetId: row.id })).toHaveLength(1);

    // Signing in during the window cancels NOTHING.
    await send(client, "/api/auth/sign-out", { json: {} });
    expect((await signIn(client, email)).status).toBe(200);
    expect((await userById(row.id))!.deleteScheduledAt!.getTime()).toBe(outcome.scheduledFor!.getTime());
    expect(await pendingRow(row.id)).not.toBeNull();
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_deletion"]);

    // The status route says when; the explicit cancel is the only way out.
    const status = await send(client, "/api/account/deletion-status");
    expect(status.body).toEqual({ scheduledFor: outcome.scheduledFor!.toISOString() });
    const cancelled = await send(client, "/api/account/deletion/cancel", { json: {} });
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.body).toEqual({ scheduledFor: null });
    expect((await userById(row.id))!.deleteScheduledAt).toBeNull();
    expect(await pendingRow(row.id)).toBeNull();
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
    expect((await linkById(kept.id)).pauseReasons, "another pause is not lifted by the cancel").toEqual([
      "ceiling",
    ]);
    expect((await send(client, "/api/account/deletion-status")).body).toEqual({ scheduledFor: null });
    expect(await auditRows({ action: "account.deletion_cancelled", targetId: row.id })).toHaveLength(1);
    expect(mailTo(email, "deletionCancelled")).toHaveLength(1);

    // Cancelling when nothing is scheduled is a quiet no-op.
    expect((await send(client, "/api/account/deletion/cancel", { json: {} })).status).toBe(200);
    expect(mailTo(email, "deletionCancelled")).toHaveLength(1);
  });

  it("cannot be cancelled once the purge has begun: 409, and nothing changes", async () => {
    const { client, user: row } = await verifiedUser();
    const folder = await makeFolder(row.id);
    const link = await makeLink(folder.id, row.id);
    const s = serviceDeps();
    await scheduleDeletion(s.deps, row.id);
    await s.settle();
    await markStarted(testDb(), row.id);

    const refused = await send(client, "/api/account/deletion/cancel", { json: {} });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "conflict" });
    expect((await userById(row.id))!.deleteScheduledAt).not.toBeNull();
    expect((await pendingRow(row.id))!.startedAt).not.toBeNull();
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_deletion"]);
    await expect(cancelDeletion(serviceDeps().deps, row.id)).rejects.toMatchObject({ code: "conflict" });
    // …and a new session is refused from the moment the purge began, like a wrong password.
    const tried = await signIn(newClient(), row.email);
    expect(tried.status).toBe(401);
    expect(tried.body).toEqual({ message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" });
    // A second schedule request neither moves the date nor mails.
    const again = serviceDeps();
    expect((await scheduleDeletion(again.deps, row.id)).changed).toBe(false);
  });

  it("the lifecycle routes need a session", async () => {
    const anonymous = newClient();
    expect((await send(anonymous, "/api/account/deletion-status")).status).toBe(401);
    expect((await send(anonymous, "/api/account/deletion/cancel", { json: {} })).status).toBe(401);
    expect(
      (await send(anonymous, "/api/account/accept-terms", { json: { version: "2026-10" } })).status,
    ).toBe(401);
  });

  it("a held account's request, status and cancel answer exactly like any other account's", async () => {
    const run = async (held: boolean) => {
      const { client, user: row, email } = await verifiedUser();
      if (held) await testDb().update(user).set({ legalHold: true }).where(eq(user.id, row.id));
      const s = serviceDeps();
      const outcome = await scheduleDeletion(s.deps, row.id);
      await s.settle();
      const status = await send(client, "/api/account/deletion-status");
      const mail = mailTo(email, "deletionScheduled")[0]!;
      const scrub = (text: string) =>
        text
          .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<when>")
          .replace(/\d+ \w+ \d{4}, \d\d:\d\d UTC/g, "<when>");
      const cancel = await send(client, "/api/account/deletion/cancel", { json: {} });
      return {
        changed: outcome.changed,
        pending: (await pendingRow(row.id)) === null,
        status: [status.status, scrub(status.text)],
        mail: [mail.subject, scrub(mail.text ?? "").replace(/Hello [^,]+,/, "Hello,")],
        cancel: [cancel.status, cancel.text],
      };
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

describe("an account whose deletion date has passed", () => {
  it.each([
    ["not held", false],
    ["held", true],
  ])(
    "%s: sign-in is the wrong-credentials answer, the old session resolves to nobody, and its rows are revoked",
    async (_label, held) => {
      const { client, user: row, email } = await verifiedUser();
      if (held) await testDb().update(user).set({ legalHold: true }).where(eq(user.id, row.id));
      // What a real wrong password looks like, for comparison.
      const wrong = await signIn(newClient(), email, "definitely the wrong password");
      expect(wrong.status).toBe(401);

      expect(await schedule(testDb(), row.id, new Date(Date.now() - 3_600_000))).toBe(true);
      const refused = await signIn(newClient(), email);
      expect(refused.status).toBe(wrong.status);
      expect(refused.text).toBe(wrong.text);
      expect(refused.setCookies.some((c) => /session_token=[^;]/.test(c) && !/Max-Age=0/i.test(c))).toBe(
        false,
      );

      // The session that existed before. Its browser also holds the 60-second cookie cache, a
      // snapshot of the user from before the date was written; in real time that snapshot has
      // carried the date for seven days. Here the date was written a moment ago, so the cache
      // is dropped — which is what its expiry does.
      expect(await sessionsOf(row.id)).toHaveLength(1);
      client.cookies.delete("hf.session_data");
      // Nobody, on the session read and on our own routes …
      const read = await send(client, "/api/auth/get-session");
      expect(read.status).toBe(200);
      expect(read.body).toBeNull();
      expect((await send(client, "/api/account/deletion-status")).status).toBe(401);
      // … and it has now been revoked: seeing it once was enough.
      expect(await sessionsOf(row.id), "the session rows are gone after first sight").toEqual([]);
      // It cannot cancel the deletion any more either.
      expect((await send(client, "/api/account/deletion/cancel", { json: {} })).status).toBe(401);
      expect((await userById(row.id))!.deleteScheduledAt).not.toBeNull();
      // Nor does a verification-free route such as password reset give a way back in.
      await send(newClient(), "/api/auth/request-password-reset", {
        json: { email, redirectTo: "/reset-password" },
        headers: CAPTCHA,
      });
      const reset = mailTo(email, "passwordReset").at(-1);
      if (reset) {
        const follow = await send(newClient(), linkIn(reset));
        const token = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
        await send(newClient(), "/api/auth/reset-password", {
          json: { newPassword: "a brand new password 2026!", token },
        });
        expect((await signIn(newClient(), email, "a brand new password 2026!")).status).toBe(401);
      }
    },
  );
});

describe("terms", () => {
  it("a stale version refuses mutations until the CURRENT version is accepted, and then at once", async () => {
    const { client, user: row } = await verifiedUser();
    expect(row.termsVersion).toBe("2026-10");
    const bumped = { ...client, settings: { termsVersion: "2027-01" } };

    // Any state-changing route outside the exemptions.
    const mutate = () =>
      send(bumped, "/api/auth-intent", { json: { birthYear: 1990, birthMonth: 5, acceptTerms: true } });
    const blocked = await mutate();
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "terms_required" });
    // Reading is not blocked.
    expect((await send(bumped, "/api/account/deletion-status")).status).toBe(200);

    const wrong = await send(bumped, "/api/account/accept-terms", { json: { version: "2026-10" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: "validation", details: { reason: "terms_version" } });
    expect((await userById(row.id))!.termsVersion).toBe("2026-10");
    expect((await send(bumped, "/api/account/accept-terms", { json: {} })).status).toBe(400);
    expect((await mutate()).status).toBe(403);

    const before = (await userById(row.id))!.termsAcceptedAt!.getTime();
    const accepted = await send(bumped, "/api/account/accept-terms", { json: { version: "2027-01" } });
    expect(accepted.status, accepted.text).toBe(200);
    const after = await userById(row.id);
    expect(after!.termsVersion).toBe("2027-01");
    expect(after!.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(await auditRows({ action: "account.terms_accepted", targetId: row.id })).toMatchObject([
      { actorUserId: row.id, meta: { version: "2027-01" } },
    ]);
    // No wait: the very next mutation is not a terms refusal, although the cookie cache still
    // carries the old version.
    const next = await mutate();
    expect(next.status).not.toBe(403);
  });

  it("acceptTerms refuses a version that is not the current one, whoever calls it", async () => {
    const { user: row } = await verifiedUser();
    const { deps } = serviceDeps();
    // Whatever the injected settings reader says is current (hand-built deps use the registered one).
    const current = resolveSettings(
      deps.env,
      await coreFor(deps).getSettings(deps.db, { fresh: true }),
    ).termsVersion;
    await expect(acceptTerms(deps, row.id, `${current}-not`)).rejects.toMatchObject({ code: "validation" });
    await expect(acceptTerms(deps, "n".repeat(32), current)).rejects.toMatchObject({ code: "not_found" });
    await acceptTerms(deps, row.id, current);
    expect((await userById(row.id))!.termsVersion).toBe(current);
  });
});

describe("the end of an account", () => {
  it("purgeAuthRows removes sessions, accounts, two-factor and verification rows, then the user", async () => {
    const { client, user: row, email } = await verifiedUser();
    await enableTotp(client);
    await send(client, "/api/auth/delete-user", { json: {} });
    await waitForMail(email, "deleteAccountVerification");
    expect((await sessionsOf(row.id)).length).toBeGreaterThan(0);
    expect(await accountsOf(row.id)).toHaveLength(1);
    expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, row.id))).toHaveLength(1);

    expect(await purgeAuthRows(testDb(), row.id)).toBe(true);
    expect(await userById(row.id)).toBeNull();
    expect(await sessionsOf(row.id)).toEqual([]);
    expect(await accountsOf(row.id)).toEqual([]);
    expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, row.id))).toEqual([]);
    expect(await getAccount(testDb(), row.id)).toBeNull();
    expect(await purgeAuthRows(testDb(), row.id)).toBe(false);
    expect(await freshSession(client)).toBeNull();
  });
});

describe("a password reset", () => {
  it("ends every session of the account, is audited, and tells the owner", async () => {
    const { client, user: row, email } = await verifiedUser();
    await signIn(newClient(), email);
    expect(await sessionsOf(row.id)).toHaveLength(2);
    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const follow = await send(newClient(), linkIn(await waitForMail(email, "passwordReset")));
    const landing = new URL(follow.headers.get("location")!, "http://localhost");
    expect(landing.pathname).toBe("/reset-password");
    const token = landing.searchParams.get("token")!;
    const done = await send(newClient(), "/api/auth/reset-password", {
      json: { newPassword: "a brand new password 2026!", token },
    });
    expect(done.status, done.text).toBe(200);

    expect(await sessionsOf(row.id), "every session is revoked by the reset").toEqual([]);
    expect(await freshSession(client)).toBeNull();
    expect(await auditRows({ action: "auth.password_changed", targetId: row.id })).toMatchObject([
      { meta: { via: "reset" } },
    ]);
    expect(mailTo(email, "passwordChanged")).toHaveLength(1);
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
    expect((await signIn(newClient(), email, "a brand new password 2026!")).status).toBe(200);
    // The token is single-use.
    const reuse = await send(newClient(), "/api/auth/reset-password", {
      json: { newPassword: "yet another password 2026!", token },
    });
    expect(reuse.status).toBe(400);
    // A reset request for an address with no account answers the same and sends nothing.
    const unknown = freshEmail();
    const quiet = await send(newClient(), "/api/auth/request-password-reset", {
      json: { email: unknown, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    expect(quiet.status).toBe(200);
    expect(mailTo(unknown)).toEqual([]);
  });
});
