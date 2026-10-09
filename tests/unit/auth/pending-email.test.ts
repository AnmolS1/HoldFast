// Fixing a mistyped address before it is verified. The right to do it is the `hf_pending` cookie
// the sign-up response set — and that cookie must not become a way to learn whether an address
// has an account, or to move an account one did not create.
import { describe, expect, it } from "vitest";
import { mintPending, PENDING_COOKIE, sign } from "../../../src/worker/auth/signed-cookie";
import { PENDING_EMAIL_MIN_MS } from "../../../src/worker/routes/pending-email";
import { createKeys } from "../../../src/worker/services/keys";
import { testVars } from "../../setup/test-vars";
import {
  auditRows,
  freshEmail,
  getSession,
  linkIn,
  mailTo,
  newClient,
  send,
  signUp,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

const keys = createKeys(testVars.FILES_TOKEN_SECRET);
const change = (client: Client, email: unknown, options: Parameters<typeof send>[2] = {}) =>
  send(client, "/api/account/pending-email", { method: "PATCH", json: { email }, ...options });

describe("the pending-sign-up cookie", () => {
  it("is set by a successful sign-up: signed, HttpOnly, SameSite=Lax, one hour, Path=/ (two routes read it)", async () => {
    const client = newClient();
    const { sent, email } = await signUp(client);
    const cookie = sent.setCookies.find((c) => c.startsWith("hf_pending="))!;
    expect(cookie).toMatch(/^hf_pending=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; /);
    expect(cookie).toContain("Max-Age=3600");
    // The pending-address route AND the verification link read it (auth/mailbox-proof.ts).
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/);
    const payload = JSON.parse(
      atob(client.cookies.get("hf_pending")!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    expect(payload).toMatchObject({ v: 1, m: email, c: 0 });
    expect(payload.u).toBe((await userByEmail(email))!.id);
    // A refused sign-up sets none.
    const refused = await signUp(newClient(), { acceptTerms: false });
    expect(refused.sent.setCookies).toEqual([]);
    // On https it is Secure and prefixed.
    const https = await signUp(newClient({ origin: "https://holdfast.example" }));
    expect(https.sent.setCookies.find((c) => c.includes("hf_pending"))).toMatch(
      /^__Secure-hf_pending=.*Secure/,
    );
  });
});

describe("PATCH /api/account/pending-email", () => {
  it("moves the unverified account to the new address, kills the old link, and mails a new one", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const row = await userByEmail(email);
    const oldLink = linkIn(await waitForMail(email, "verification"));
    const next = freshEmail();

    const started = Date.now();
    const sent = await change(client, ` ${next.toUpperCase()} `.trim());
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body).toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(PENDING_EMAIL_MIN_MS - 30);

    expect((await userById(row!.id))!.email).toBe(next);
    expect((await userById(row!.id))!.emailVerified).toBe(false);
    expect(await userByEmail(email)).toBeNull();
    expect(await auditRows({ action: "auth.pending_email_changed", targetId: row!.id })).toHaveLength(1);

    // The old link names an address no account has any more.
    const stale = await send(newClient(), oldLink);
    expect(stale.headers.get("location")).toMatch(/error=USER_NOT_FOUND/);
    expect((await userById(row!.id))!.emailVerified).toBe(false);

    // The new one verifies and signs in.
    const fresh = await waitForMail(next, "verification");
    expect((await send(client, linkIn(fresh))).status).toBe(302);
    expect((await userById(row!.id))!.emailVerified).toBe(true);
    expect((await getSession(client))?.user.email).toBe(next);

    // Once verified, the cookie changes nothing more.
    const late = await change(client, freshEmail());
    expect(late.status).toBe(200);
    expect((await userById(row!.id))!.email).toBe(next);
  });

  it("needs the cookie: none, altered, re-signed for another purpose or expired is refused", async () => {
    const victim = await signUp(newClient());
    const victimRow = await userByEmail(victim.email);
    const none = await change(newClient(), freshEmail());
    expect(none.status).toBe(403);
    expect(none.body).toMatchObject({ error: "forbidden", details: { reason: "no_pending_signup" } });

    const who = { email: victim.email, userId: victimRow!.id };
    const forgeries: string[] = [
      // An unsigned claim to be the victim's sign-up.
      btoa(JSON.stringify({ v: 1, e: 9_999_999_999, m: who.email, u: who.userId, c: 0 })).replace(/=+$/, ""),
      // Signed with the key of another purpose.
      await sign(
        keys,
        { ...PENDING_COOKIE, purpose: "intent-cookie" },
        { v: 1, e: 9_999_999_999, m: who.email, u: who.userId, c: 0 },
      ),
      // Signed with another secret.
      await mintPending(createKeys("another-secret-entirely-000000000000000000000"), who, 0, new Date()),
      // Genuine, but minted more than an hour ago.
      await mintPending(keys, who, 0, new Date(Date.now() - 3_700_000)),
    ];
    const genuine = await mintPending(keys, who, 0, new Date());
    forgeries.push(genuine.slice(0, -2) + (genuine.endsWith("AA") ? "BB" : "AA"));
    for (const forged of forgeries) {
      const client = newClient();
      client.cookies.set("hf_pending", forged);
      const sent = await change(client, freshEmail());
      expect(sent.status, forged.slice(0, 16)).toBe(403);
    }
    expect((await userById(victimRow!.id))!.email).toBe(victim.email);
  });

  it("is refused cross-site", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const sent = await change(client, freshEmail(), {
      browser: false,
      headers: { origin: "https://evil.example" },
    });
    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ details: { reason: "csrf" } });
    expect(await userByEmail(email)).not.toBeNull();
  });

  it("checks the new address itself: not an address, or a disposable domain, is a 400", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    expect((await change(client, "not an address")).status).toBe(400);
    expect((await change(client, 42)).status).toBe(400);
    const disposable = await change(client, freshEmail("mailinator.com"));
    expect(disposable.status).toBe(400);
    expect(disposable.body).toMatchObject({ error: "validation", details: { reason: "EMAIL_NOT_ALLOWED" } });
    expect(await userByEmail(email)).not.toBeNull();
  });

  it("no oracle: after a look-alike sign-up (the address has an account) the answer is the same and nothing moves", async () => {
    const existing = await verifiedUser();
    const impostor = newClient();
    const again = await signUp(impostor, { email: existing.email });
    expect(again.sent.status).toBe(200);
    expect(impostor.cookies.has("hf_pending")).toBe(true);
    const payload = JSON.parse(
      atob(impostor.cookies.get("hf_pending")!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    // The cookie names nobody — in the same shape as one that does.
    expect(payload.u).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(payload.u).not.toBe(existing.user.id);
    expect(await userById(payload.u)).toBeNull();

    const target = freshEmail();
    const real = newClient();
    await signUp(real);
    const honest = await change(real, freshEmail());
    const sent = await change(impostor, target);
    expect(sent.status).toBe(honest.status);
    expect(sent.body).toEqual(honest.body);
    expect(sent.setCookies.map((c) => c.split("=")[0])).toEqual(
      honest.setCookies.map((c) => c.split("=")[0]),
    );
    // The existing account did not move, and nobody was mailed.
    expect((await userById(existing.user.id))!.email).toBe(existing.email);
    expect(mailTo(target)).toEqual([]);
  });

  it("a second person signing up with an address someone else left unverified cannot move that account", async () => {
    const first = newClient();
    const { email } = await signUp(first);
    const row = await userByEmail(email);
    const second = newClient();
    await signUp(second, { email });
    const elsewhere = freshEmail();
    expect((await change(second, elsewhere)).status).toBe(200);
    expect((await userById(row!.id))!.email, "the first sign-up's account stays where it was").toBe(email);
    expect(mailTo(elsewhere)).toEqual([]);
    // The one who created it still can.
    const mine = freshEmail();
    expect((await change(first, mine)).status).toBe(200);
    expect((await userById(row!.id))!.email).toBe(mine);
  });

  it("to an address that belongs to another account: the same answer, nothing changes, nobody is mailed", async () => {
    const other = await verifiedUser();
    const before = mailTo(other.email).length;
    const client = newClient();
    const { email } = await signUp(client);
    const sent = await change(client, other.email);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
    expect((await userByEmail(email))!.email).toBe(email);
    expect((await userById(other.user.id))!.email).toBe(other.email);
    expect(mailTo(other.email)).toHaveLength(before);
  });

  it("one sign-up may change its address five times", async () => {
    // Each change also counts against the day's sign-up budget of the address (three by default —
    // tests/unit/auth/invite-gate.test.ts); raised here so that the cap under test is the cookie's.
    const client = newClient({ settings: { ceilings: { signupIpDay: 50 } } });
    await signUp(client);
    for (let i = 1; i <= 5; i++) expect((await change(client, freshEmail())).status, `change ${i}`).toBe(200);
    const sixth = await change(client, freshEmail());
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ error: "rate_limited" });
  });
});
