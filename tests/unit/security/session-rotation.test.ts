// Session rotation (T26 item 14): the session token changes on sign-in, after a password change
// and after enabling two-factor; a ban and a suspension end every existing session. And the
// standing check (a): a request that carries the OLD cookie is answered for the session it
// carried — signed out once that session is gone, or that same account while it lives — never
// for the session that replaced it.
import { describe, expect, it } from "vitest";
import { suspendUser, SYSTEM_ACTOR } from "../../../src/worker/services/account-state";
import {
  enableTotp,
  newClient,
  PASSWORD,
  promoteToAdmin,
  send,
  serviceDeps,
  sessionsOf,
  signIn,
  verifiedUser,
  type Client,
} from "../auth/helpers";

const COOKIE = "hf.session_token";
const tokenOf = (client: Client) => client.cookies.get(COOKIE);
/** A browser that sends exactly this session cookie and nothing else. */
const holding = (token: string | undefined) => {
  const client = newClient();
  if (token) client.cookies.set(COOKIE, token);
  return client;
};
const sessionUserOf = async (client: Client) =>
  ((await send(client, "/api/auth/get-session")).body as { user?: { id: string } } | null)?.user?.id ?? null;
/** An app route: 401 when the cookie carries no live session. */
const usageStatus = async (client: Client) => (await send(client, "/api/account/usage")).status;

describe("the token changes", () => {
  it("on sign-in — a cookie the browser already held (a fixation attempt, or an earlier session) is never adopted", async () => {
    const { email, client: first } = await verifiedUser();
    const earlier = tokenOf(first);
    expect(earlier).toBeTruthy();

    // An attacker-chosen value planted before sign-in (made up for this test).
    const browser = holding("planted-session-value.made-up-signature");
    const signedIn = await signIn(browser, email);
    expect(signedIn.status).toBe(200);
    const issued = tokenOf(browser);
    expect(issued).toBeTruthy();
    expect(issued).not.toBe("planted-session-value.made-up-signature");
    expect(issued).not.toBe(earlier);

    // A second sign-in is a new session again.
    await signIn(browser, email);
    expect(tokenOf(browser)).not.toBe(issued);
  });

  it("after a password change — and every session the account had is gone, the one that asked included", async () => {
    const { email, user, client } = await verifiedUser();
    const other = newClient();
    await signIn(other, email);
    const before = tokenOf(client);
    const otherBefore = tokenOf(other);

    const changed = await send(client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword: "an entirely new passphrase 42!" },
    });
    expect(changed.status, changed.text).toBe(200);
    const after = tokenOf(client);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(await sessionsOf(user.id)).toHaveLength(1);

    // Standing check (a): the old cookies are answered as signed out, never as the new session.
    for (const old of [before, otherBefore]) {
      expect(await sessionUserOf(holding(old))).toBeNull();
      expect(await usageStatus(holding(old))).toBe(401);
    }
    expect(await sessionUserOf(client)).toBe(user.id);
  });

  it("after enabling two-factor — the session that enabled it is replaced", async () => {
    const { user, client } = await verifiedUser();
    const before = tokenOf(client);
    await enableTotp(client);
    const after = tokenOf(client);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(await sessionUserOf(holding(before))).toBeNull();
    expect(await usageStatus(holding(before))).toBe(401);
    expect(await sessionUserOf(client)).toBe(user.id);
  });
});

describe("a ban and a suspension end every existing session", () => {
  it("suspension (services/account-state.ts suspendUser): no session row left; the old cookie is signed out", async () => {
    const { email, user, client } = await verifiedUser();
    const second = newClient();
    await signIn(second, email);
    const tokens = [tokenOf(client), tokenOf(second)];
    expect(await sessionsOf(user.id)).toHaveLength(2);

    const s = serviceDeps();
    expect(await suspendUser(s.deps, user.id, "test", SYSTEM_ACTOR)).toBe(true);
    await s.settle();
    expect(await sessionsOf(user.id)).toEqual([]);
    for (const token of tokens) {
      expect(await sessionUserOf(holding(token))).toBeNull();
      expect(await usageStatus(holding(token))).toBe(401);
    }
  });

  it("a ban through the admin plugin: no session row left; the old cookie is signed out", async () => {
    const admin = await verifiedUser();
    await promoteToAdmin(admin.user.id);
    const target = await verifiedUser();
    const old = tokenOf(target.client);
    const banned = await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } });
    expect(banned.status, banned.text).toBe(200);
    expect(await sessionsOf(target.user.id)).toEqual([]);
    expect(await sessionUserOf(holding(old))).toBeNull();
    expect(await usageStatus(holding(old))).toBe(401);
  });
});

describe("standing check (a): an old cookie is answered for its own session", () => {
  it("after the browser signs in as ANOTHER account, a request still carrying the first cookie is the first account's", async () => {
    const a = await verifiedUser();
    const b = await verifiedUser();
    const aToken = tokenOf(a.client);
    // The same browser signs in as B: its cookie is now B's.
    await signIn(a.client, b.email);
    expect(await sessionUserOf(a.client)).toBe(b.user.id);
    // A request issued with A's cookie (sent before the switch, answered after) is A's — never B's.
    expect(await sessionUserOf(holding(aToken))).toBe(a.user.id);
    expect(await usageStatus(holding(aToken))).toBe(200);
  });
});
