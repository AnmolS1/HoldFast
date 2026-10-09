// How an account deletion is requested: Better Auth's own delete-user endpoints, vetoed. The
// account is never deleted by them — `beforeDelete` schedules the deletion and always throws —
// and the proof is that the user row, its sessions and its accounts are all still there after
// every path that reaches the hook.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { buildAuthOptions } from "../../../src/worker/auth/create-auth";
import { createScope } from "../../../src/worker/auth/scope";
import { testOutbound } from "../../../src/worker/auth/test-outbound";
import { pendingUserPurges, verification } from "../../../src/worker/db/schema";
import {
  accountsOf,
  auditRows,
  linkIn,
  mailTo,
  newClient,
  PASSWORD,
  send,
  sessionsOf,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
} from "./helpers";

const pendingRow = async (userId: string) =>
  (await testDb().select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId)))[0] ?? null;

async function requestDeletion(
  client: Parameters<typeof send>[0],
  email: string,
  body: Record<string, unknown> = {},
) {
  const before = mailTo(email, "deleteAccountVerification").length;
  const sent = await send(client, "/api/auth/delete-user", { json: body });
  const mail = sent.status === 200 ? await waitForMail(email, "deleteAccountVerification", before + 1) : null;
  return { sent, link: mail ? linkIn(mail) : null, mail };
}

/** Everything that would be gone if the account had been deleted. */
async function intact(userId: string) {
  return {
    user: (await userById(userId)) !== null,
    sessions: (await sessionsOf(userId)).length,
    accounts: (await accountsOf(userId)).length,
  };
}

describe("requesting deletion", () => {
  it("the request only mails a link: nothing is scheduled, nothing is deleted", async () => {
    const { client, user: row, email } = await verifiedUser();
    const { sent, link, mail } = await requestDeletion(client, email);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ success: true, message: "Verification email sent" });
    expect(link).toMatch(/^\/api\/auth\/delete-user\/callback\?token=[a-z0-9]{32}&callbackURL=/);
    expect(mail!.text).toContain("Open this link in the browser where you are signed in to Holdfast.");
    expect((await userById(row.id))!.deleteScheduledAt, "still not scheduled").toBeNull();
    expect(await pendingRow(row.id)).toBeNull();
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
    expect(sent.setCookies.filter((c) => /max-age=0/i.test(c) || /session_token=/.test(c))).toEqual([]);
  });

  it("the link, in the signed-in browser: 302 to the account page, deletion SCHEDULED, account and session intact", async () => {
    const { client, user: row, email } = await verifiedUser();
    const { link } = await requestDeletion(client, email);
    const followed = await send(client, link!);
    expect(followed.status).toBe(302);
    expect(followed.headers.get("location")).toBe("http://localhost/account?deletion=scheduled");
    // No cookie is cleared: the owner stays signed in to see the banner.
    expect(followed.setCookies.filter((c) => /max-age=0/i.test(c) || /session_token=;/.test(c))).toEqual([]);
    expect((await userById(row.id))!.deleteScheduledAt).toBeInstanceOf(Date);
    expect((await pendingRow(row.id))!.startedAt).toBeNull();
    // THE proof that beforeDelete never returned: everything a deletion removes is still here.
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
    const session = await send(client, "/api/auth/get-session?disableCookieCache=true");
    expect(session.body).toMatchObject({ user: { id: row.id } });
    expect(await auditRows({ action: "account.deletion_scheduled", targetId: row.id })).toHaveLength(1);
    expect(mailTo(email, "deletionScheduled")).toHaveLength(1);

    // The link is single-use: a second click is Better Auth's own 404, and changes nothing.
    const scheduledAt = (await userById(row.id))!.deleteScheduledAt!.getTime();
    const again = await send(client, link!);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ code: "INVALID_TOKEN" });
    expect((await userById(row.id))!.deleteScheduledAt!.getTime()).toBe(scheduledAt);
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
    expect(mailTo(email, "deletionScheduled")).toHaveLength(1);
  });

  it("the link without a session: 404, nothing happens, and the token is still usable afterwards", async () => {
    const { client, user: row, email } = await verifiedUser();
    const { link } = await requestDeletion(client, email);
    const anonymous = await send(newClient(), link!);
    expect(anonymous.status).toBe(404);
    expect(anonymous.body).toMatchObject({ code: "FAILED_TO_GET_USER_INFO" });
    expect((await userById(row.id))!.deleteScheduledAt).toBeNull();
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
    // The token was not consumed by the anonymous attempt.
    expect((await send(client, link!)).status).toBe(302);
    expect((await userById(row.id))!.deleteScheduledAt).toBeInstanceOf(Date);
  });

  it("someone else's link, in another account's session, schedules nobody's deletion", async () => {
    const victim = await verifiedUser();
    const other = await verifiedUser();
    const { link } = await requestDeletion(victim.client, victim.email);
    const tried = await send(other.client, link!);
    expect(tried.status).toBe(404);
    expect((await userById(victim.user.id))!.deleteScheduledAt).toBeNull();
    expect((await userById(other.user.id))!.deleteScheduledAt).toBeNull();
    expect(await intact(victim.user.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
    expect(await intact(other.user.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
  });

  it("the token in the body of POST /delete-user: 200 'Deletion scheduled', same rows, account intact", async () => {
    const { client, user: row, email } = await verifiedUser();
    const { link } = await requestDeletion(client, email);
    const token = new URL(link!, "http://localhost").searchParams.get("token")!;
    const sent = await send(client, "/api/auth/delete-user", { json: { token } });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body).toEqual({ success: true, message: "Deletion scheduled" });
    expect(sent.setCookies.filter((c) => /max-age=0/i.test(c))).toEqual([]);
    expect((await userById(row.id))!.deleteScheduledAt).toBeInstanceOf(Date);
    expect(await pendingRow(row.id)).not.toBeNull();
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
    // Used: the same token again is refused.
    const reuse = await send(client, "/api/auth/delete-user", { json: { token } });
    expect(reuse.status).toBe(404);
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
  });

  it("a password in the body does not delete either: right or wrong, the account stays", async () => {
    const { client, user: row, email } = await verifiedUser();
    const wrong = await send(client, "/api/auth/delete-user", {
      json: { password: "not the password at all" },
    });
    expect(wrong.status).toBe(400);
    const right = await requestDeletion(client, email, { password: PASSWORD });
    expect(right.sent.body).toEqual({ success: true, message: "Verification email sent" });
    expect((await userById(row.id))!.deleteScheduledAt).toBeNull();
    expect(await intact(row.id)).toEqual({ user: true, sessions: 1, accounts: 1 });
  });

  it("needs a session at all", async () => {
    const sent = await send(newClient(), "/api/auth/delete-user", { json: {} });
    expect(sent.status).toBe(401);
  });

  it("a forged or guessed token is refused and consumes nothing", async () => {
    const { client, user: row, email } = await verifiedUser();
    const { link } = await requestDeletion(client, email);
    const forged = await send(client, "/api/auth/delete-user/callback?token=" + "a".repeat(32));
    expect(forged.status).toBe(404);
    expect((await userById(row.id))!.deleteScheduledAt).toBeNull();
    expect((await send(client, link!)).status).toBe(302);
  });
});

describe("beforeDelete defers nothing (the hook awaits everything it starts)", () => {
  it("called directly: it has written the audit row and finished the email before it throws, and never touches ctx.waitUntil", async () => {
    const { user: row, email } = await verifiedUser();
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    // The Resend transport, answered late by a stand-in: the send takes 300 ms.
    const outbound = testOutbound()!;
    const sends: Array<{ at: number; to: unknown }> = [];
    outbound.answer("api.resend.com", async (request) => {
      const body = (await request.json()) as { to: unknown };
      await new Promise((resolve) => setTimeout(resolve, 300));
      sends.push({ at: Date.now(), to: body.to });
      return Response.json({ id: "late" });
    });
    try {
      const scope = createScope({ ...env, EMAIL_TRANSPORT: "resend" }, testDb(), ctx);
      const { beforeDelete } = buildAuthOptions(scope).user.deleteUser;
      // What `hooks.before` records for the link's request (the hook decides by it, not by a URL).
      scope.facts.endpointPath = "/delete-user/callback";
      const started = Date.now();
      const request = new Request("http://localhost/api/auth/delete-user/callback?token=x");
      const thrown: unknown = await beforeDelete({ id: row.id }, request).then(
        () => null,
        (error: unknown) => error,
      );
      const threwAt = Date.now();

      // It threw — it must NEVER return — and what it threw is the redirect.
      expect(thrown).not.toBeNull();
      expect(thrown).toMatchObject({ status: "FOUND", statusCode: 302 });
      expect((thrown as { headers: Headers | Record<string, string> }).headers).toBeDefined();
      // By the time it threw: the mail request had completed (300 ms), and the audit row exists.
      expect(sends).toEqual([{ at: expect.any(Number), to: email }]);
      expect(sends[0]!.at).toBeLessThanOrEqual(threwAt);
      expect(threwAt - started).toBeGreaterThanOrEqual(290);
      expect(await auditRows({ action: "account.deletion_scheduled", targetId: row.id })).toHaveLength(1);
      expect((await userById(row.id))!.deleteScheduledAt).toBeInstanceOf(Date);
      // Nothing was handed to the request's deferred work.
      expect(ctx.waitUntil).not.toHaveBeenCalled();

      // On the non-callback path it throws the 200 instead — and still throws.
      const other = await verifiedUser();
      scope.facts.endpointPath = "/delete-user";
      const viaPost: unknown = await beforeDelete(
        { id: other.user.id },
        new Request("http://localhost/api/auth/delete-user", { method: "POST" }),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(viaPost).toMatchObject({
        status: "OK",
        statusCode: 200,
        body: { success: true, message: "Deletion scheduled" },
      });
      const noRequest: unknown = await beforeDelete({ id: other.user.id }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(noRequest, "with no request at all it still throws").toMatchObject({ status: "OK" });
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    } finally {
      outbound.answer("api.resend.com", null);
    }
  });

  it("through the handler: the 302 is not produced until the late email has been sent", async () => {
    const outbound = testOutbound()!;
    let sentAt = 0;
    outbound.answer("api.resend.com", async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      sentAt = Date.now();
      return Response.json({ id: "late" });
    });
    try {
      const { client, user: row, email } = await verifiedUser();
      // The request for the link, on the memory transport (so the link can be read).
      const { link } = await requestDeletion(client, email);
      const slow = { ...client, env: { EMAIL_TRANSPORT: "resend" } };
      const followed = await send(slow, link!);
      const answeredAt = Date.now();
      expect(followed.status).toBe(302);
      expect(sentAt).toBeGreaterThan(0);
      expect(sentAt).toBeLessThanOrEqual(answeredAt);
      expect(await auditRows({ action: "account.deletion_scheduled", targetId: row.id })).toHaveLength(1);
    } finally {
      outbound.answer("api.resend.com", null);
    }
  });

  it("the delete token is single-use in the database: the verification row is gone after the click", async () => {
    const { client, email } = await verifiedUser();
    const { link } = await requestDeletion(client, email);
    const token = new URL(link!, "http://localhost").searchParams.get("token")!;
    const identifier = `delete-account-${token}`;
    const rowsBefore = await testDb()
      .select()
      .from(verification)
      .where(eq(verification.identifier, identifier));
    expect(rowsBefore).toHaveLength(1);
    await send(client, link!);
    expect(await testDb().select().from(verification).where(eq(verification.identifier, identifier))).toEqual(
      [],
    );
  });
});
