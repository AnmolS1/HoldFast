// Sign-up and sign-in with Google. Google itself is never called: the token exchange is the
// test-mode stand-in (src/worker/auth/test-outbound.ts), which answers an authorization code made
// by `testGoogleCode` with an id_token carrying that profile.
//
// The claims: a Google SIGN-UP needs the intent cookie from POST /api/auth-intent (invite, age,
// assent) — signed, ten minutes, single-use; without it, with a forged, altered, expired or
// replayed one, no account is created. A Google sign-in of an EXISTING account needs none.
import { describe, expect, it } from "vitest";
import { generateId } from "@better-auth/core/utils/id";
import { INTENT_COOKIE, mintIntent, sign } from "../../../src/worker/auth/signed-cookie";
import { testGoogleCode, type TestGoogleProfile } from "../../../src/worker/auth/test-outbound";
import { insertIntent } from "../../../src/worker/db/queries/auth-lifecycle";
import { createKeys } from "../../../src/worker/services/keys";
import { testVars } from "../../setup/test-vars";
import {
  accountsOf,
  auditRows,
  createInvite,
  freshEmail,
  getSession,
  inviteRow,
  makeFolder,
  makePendingShare,
  newClient,
  send,
  sessionsOf,
  shareById,
  signUp,
  testDb,
  userByEmail,
  verifiedUser,
  type Client,
} from "./helpers";

const keys = createKeys(testVars.FILES_TOKEN_SECRET);
const profileFor = (email: string, extra: Partial<TestGoogleProfile> = {}): TestGoogleProfile => ({
  sub: `g-${crypto.randomUUID()}`,
  email,
  name: "Gina Google",
  ...extra,
});

async function intent(client: Client, body: Record<string, unknown> = {}) {
  const inviteCode = "inviteCode" in body ? body.inviteCode : await createInvite();
  const sent = await send(client, "/api/auth-intent", {
    json: {
      birthYear: 1990,
      birthMonth: 5,
      acceptTerms: true,
      ...body,
      ...(inviteCode ? { inviteCode } : {}),
    },
  });
  return { sent, inviteCode: inviteCode as string | null };
}

/** The browser's part: start the flow, then come back from Google with a code for `profile`. */
async function googleRoundTrip(client: Client, profile: TestGoogleProfile, errorCallbackURL = "/signup") {
  const start = await send(client, "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "/", errorCallbackURL },
  });
  expect(start.status, start.text).toBe(200);
  const url = new URL((start.body as { url: string }).url);
  expect(url.origin).toBe("https://accounts.google.com");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/callback/google");
  const state = url.searchParams.get("state")!;
  const callback = await send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
  return { callback, location: callback.headers.get("location") ?? "" };
}

function expectRefusedAt(location: string, code: string, page = "/signup") {
  const url = new URL(location, "http://localhost");
  expect(url.pathname).toBe(page);
  expect(url.searchParams.get("error")).toBe(code);
}

describe("POST /api/auth-intent", () => {
  it("sets a signed, HttpOnly, SameSite=Lax, ten-minute cookie scoped to /api/auth", async () => {
    const client = newClient();
    const { sent } = await intent(client);
    expect(sent.status, sent.text).toBe(200);
    expect(sent.setCookies).toHaveLength(1);
    const cookie = sent.setCookies[0]!;
    expect(cookie).toMatch(
      /^hf_intent=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=600; Path=\/api\/auth; HttpOnly; SameSite=Lax$/,
    );
    // It carries the invite code and a nonce — and nothing about the birth date.
    const payload = JSON.parse(
      atob(cookie.split("=")[1]!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    expect(Object.keys(payload).sort()).toEqual(["e", "i", "n", "v"]);
    expect(JSON.stringify(payload)).not.toMatch(/1990|birth/);
  });

  it("on an https origin the cookie is Secure and carries the __Secure- prefix", async () => {
    const client = newClient({ origin: "https://holdfast.example" });
    const { sent } = await intent(client);
    expect(sent.status, sent.text).toBe(200);
    expect(sent.setCookies[0]).toMatch(/^__Secure-hf_intent=.*; HttpOnly; SameSite=Lax; Secure$/);
  });

  it("applies the kill switch, assent, age and the invite — and consumes nothing", async () => {
    const refuse = async (body: Record<string, unknown>, reason: string, client = newClient()) => {
      const { sent, inviteCode } = await intent(client, body);
      expect(sent.status, `${reason}: ${sent.text}`).toBe(400);
      expect(sent.body).toMatchObject({ error: "validation", details: { reason } });
      expect(sent.setCookies).toEqual([]);
      if (inviteCode) expect((await inviteRow(inviteCode))?.uses ?? 0).toBe(0);
    };
    await refuse({ acceptTerms: false }, "TERMS_NOT_ACCEPTED");
    await refuse({ birthYear: new Date().getUTCFullYear() - 10 }, "SIGNUP_NOT_AVAILABLE");
    await refuse({ inviteCode: null }, "INVITE_INVALID");
    await refuse({ inviteCode: "NOT-A-CODE" }, "INVITE_INVALID");
    await refuse({ inviteCode: await createInvite({ revokedAt: new Date() }) }, "INVITE_INVALID");
    // The kill switch is the pipeline's here (this route is not under /api/auth/): 503 read_only.
    const paused = await intent(newClient({ settings: { readOnly: true } }));
    expect(paused.sent.status).toBe(503);
    expect(paused.sent.body).toMatchObject({ error: "read_only" });
    expect(paused.sent.setCookies).toEqual([]);
    // A valid intent does not use the invite either: that happens when the account is created.
    const ok = await intent(newClient());
    expect(ok.sent.status).toBe(200);
    expect((await inviteRow(ok.inviteCode!))!.uses).toBe(0);
    // Open sign-up: no invite needed.
    expect(
      (await intent(newClient({ settings: { signupMode: "open" } }), { inviteCode: null })).sent.status,
    ).toBe(200);
  });

  it("is refused cross-site (CSRF)", async () => {
    const sent = await send(newClient(), "/api/auth-intent", {
      json: { birthYear: 1990, birthMonth: 5, acceptTerms: true },
      browser: false,
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ error: "forbidden", details: { reason: "csrf" } });
  });
});

describe("a Google sign-up", () => {
  it("with the intent: creates a verified account under the policy, uses the invite, signs in, and clears the cookie", async () => {
    const client = newClient();
    const email = freshEmail();
    const { inviteCode } = await intent(client);
    expect(client.cookies.has("hf_intent")).toBe(true);
    const { callback, location } = await googleRoundTrip(client, profileFor(email));
    expect(callback.status, callback.text).toBe(302);
    expect(location).toBe("/");

    const row = await userByEmail(email);
    expect(row).not.toBeNull();
    expect(row!.emailVerified).toBe(true);
    expect(row!.termsVersion).toBe("2026-10");
    expect(row!.termsAcceptedAt).toBeInstanceOf(Date);
    expect(row!.ageVerifiedAt).toBeInstanceOf(Date);
    expect(row!.role).toBe("user");
    expect((await inviteRow(inviteCode!))!.uses).toBe(1);
    expect((await getSession(client))?.user.email).toBe(email);
    expect(client.cookies.has("hf_intent"), "the used intent cookie is cleared").toBe(false);

    const accounts = await accountsOf(row!.id);
    expect(accounts.map((a) => a.providerId)).toEqual(["google"]);
    // Google's tokens are stored encrypted, not as received.
    expect(accounts[0]!.accessToken).not.toBeNull();
    expect(accounts[0]!.accessToken).not.toContain("test-google-access-token");
    expect(await auditRows({ action: "auth.sign_in", targetId: row!.id })).toMatchObject([
      { meta: { method: "google" } },
    ]);
  });

  it("without the intent: refused, no account, no session", async () => {
    const client = newClient();
    const email = freshEmail();
    const { location } = await googleRoundTrip(client, profileFor(email));
    expectRefusedAt(location, "SIGNUP_INTENT_REQUIRED");
    expect(new URL(location, "http://x").searchParams.get("error_description")).toBe(
      "Start sign-up from the Holdfast sign-up page.",
    );
    expect(await userByEmail(email)).toBeNull();
    expect(await getSession(client)).toBeNull();
  });

  it("without the intent it is refused in OPEN mode too (age and assent are still owed)", async () => {
    const client = newClient({ settings: { signupMode: "open" } });
    const email = freshEmail();
    const { location } = await googleRoundTrip(client, profileFor(email));
    expectRefusedAt(location, "SIGNUP_INTENT_REQUIRED");
    expect(await userByEmail(email)).toBeNull();
  });

  it("a tampered cookie is refused: payload changed, signature changed, signed for another purpose, unsigned", async () => {
    const forge = async (make: (genuine: string) => Promise<string> | string) => {
      const client = newClient();
      const { inviteCode } = await intent(client);
      const genuine = client.cookies.get("hf_intent")!;
      client.cookies.set("hf_intent", await make(genuine));
      const email = freshEmail();
      const { location } = await googleRoundTrip(client, profileFor(email));
      expectRefusedAt(location, "SIGNUP_INTENT_REQUIRED");
      expect(await userByEmail(email)).toBeNull();
      expect((await inviteRow(inviteCode!))!.uses).toBe(0);
    };
    const b64 = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    // The payload swapped for one naming another invite, under the old signature.
    const other = await createInvite({ maxUses: 100 });
    await forge((genuine) => {
      const [body, mac] = genuine.split(".");
      return `${b64({ ...decode(body!), i: other })}.${mac}`;
    });
    expect((await inviteRow(other))!.uses).toBe(0);
    // The expiry pushed out.
    await forge((genuine) => {
      const [body, mac] = genuine.split(".");
      return `${b64({ ...decode(body!), e: decode(body!).e + 86_400 })}.${mac}`;
    });
    // One character of the signature changed (the first: every bit of it counts).
    await forge((genuine) => {
      const [body, mac] = genuine.split(".");
      return `${body}.${mac!.startsWith("A") ? "B" : "A"}${mac!.slice(1)}`;
    });
    // The same signature bytes under another spelling: the last base64 character has two spare
    // bits, so one of its three siblings decodes to the same MAC. Refused all the same.
    await forge((genuine) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = alphabet.indexOf(genuine.at(-1)!);
      return genuine.slice(0, -1) + alphabet[(last & ~3) | ((last & 3) === 0 ? 1 : 0)];
    });
    // No signature; an empty signature.
    await forge((genuine) => genuine.split(".")[0]!);
    await forge((genuine) => `${genuine.split(".")[0]!}.`);
    // A valid signature — made with the key of ANOTHER purpose.
    await forge(async (genuine) => {
      const payload = decode(genuine.split(".")[0]!);
      return sign(keys, { ...INTENT_COOKIE, purpose: "account-action" }, payload);
    });
    // A valid signature under a different secret altogether.
    await forge(async (genuine) => {
      const payload = decode(genuine.split(".")[0]!);
      return sign(createKeys("another-secret-entirely-000000000000000000000"), INTENT_COOKIE, payload);
    });
  });

  it("an expired intent is refused — by the cookie's own expiry, and by the recorded marker's", async () => {
    const tenMinutes = 600_000;
    const cases = [
      // The cookie says it expired a minute ago; its marker in the database is still live.
      {
        mintedAt: new Date(Date.now() - tenMinutes - 60_000),
        markerExpiresAt: new Date(Date.now() + tenMinutes),
      },
      // The cookie is fresh; its marker expired a minute ago.
      { mintedAt: new Date(), markerExpiresAt: new Date(Date.now() - 3_600_000) },
    ];
    for (const { mintedAt, markerExpiresAt } of cases) {
      const client = newClient();
      const code = await createInvite();
      const minted = await mintIntent(keys, code, mintedAt);
      await insertIntent(testDb(), {
        id: generateId(),
        nonce: minted.nonce,
        expiresAt: markerExpiresAt,
        now: mintedAt,
      });
      client.cookies.set("hf_intent", minted.value);
      const email = freshEmail();
      const { location } = await googleRoundTrip(client, profileFor(email));
      expectRefusedAt(location, "SIGNUP_INTENT_REQUIRED");
      expect(await userByEmail(email)).toBeNull();
      expect((await inviteRow(code))!.uses).toBe(0);
    }
  });

  it("a genuine cookie whose nonce was never recorded is refused (the signature alone is not enough)", async () => {
    const client = newClient();
    const code = await createInvite();
    const minted = await mintIntent(keys, code, new Date());
    client.cookies.set("hf_intent", minted.value);
    const email = freshEmail();
    const { location } = await googleRoundTrip(client, profileFor(email));
    expectRefusedAt(location, "SIGNUP_INTENT_REQUIRED");
    expect(await userByEmail(email)).toBeNull();
    expect((await inviteRow(code))!.uses).toBe(0);
  });

  it("is single-use: the same cookie does not admit a second account", async () => {
    const first = newClient();
    const { inviteCode } = await intent(first, { inviteCode: await createInvite({ maxUses: 5 }) });
    const copied = first.cookies.get("hf_intent")!;
    const a = freshEmail();
    expect((await googleRoundTrip(first, profileFor(a))).location).toBe("/");
    expect(await userByEmail(a)).not.toBeNull();

    const second = newClient();
    second.cookies.set("hf_intent", copied);
    const b = freshEmail();
    const { location } = await googleRoundTrip(second, profileFor(b));
    expectRefusedAt(location, "SIGNUP_INTENT_REQUIRED");
    expect(await userByEmail(b)).toBeNull();
    expect((await inviteRow(inviteCode!))!.uses, "the invite was used once, not twice").toBe(1);
  });

  it("is single-use under concurrency: two accounts racing on one cookie, one is created", async () => {
    const seed = newClient();
    const { inviteCode } = await intent(seed, { inviteCode: await createInvite({ maxUses: 5 }) });
    const cookie = seed.cookies.get("hf_intent")!;
    const racers = [newClient(), newClient()];
    const emails = [freshEmail(), freshEmail()];
    // Each racer starts its own OAuth flow (its own state), then both come back at once.
    const states = await Promise.all(
      racers.map(async (client) => {
        client.cookies.set("hf_intent", cookie);
        const start = await send(client, "/api/auth/sign-in/social", {
          json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
        });
        return new URL((start.body as { url: string }).url).searchParams.get("state")!;
      }),
    );
    await Promise.all(
      racers.map((client, i) =>
        send(
          client,
          `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profileFor(emails[i]!)))}&state=${encodeURIComponent(states[i]!)}`,
          { browser: false },
        ),
      ),
    );
    const created = (await Promise.all(emails.map((email) => userByEmail(email)))).filter(Boolean);
    expect(created).toHaveLength(1);
    expect((await inviteRow(inviteCode!))!.uses).toBe(1);
  });

  it("an address Google has not verified is refused, and nothing is spent", async () => {
    const client = newClient();
    const { inviteCode } = await intent(client);
    const email = freshEmail();
    const { location } = await googleRoundTrip(client, profileFor(email, { email_verified: false }));
    expectRefusedAt(location, "PROVIDER_EMAIL_UNVERIFIED");
    expect(await userByEmail(email)).toBeNull();
    expect((await inviteRow(inviteCode!))!.uses).toBe(0);
  });

  it("the address checks apply to a Google address: a disposable domain is refused and the invite kept", async () => {
    const client = newClient();
    const { inviteCode } = await intent(client);
    const email = freshEmail("mailinator.com");
    const { location } = await googleRoundTrip(client, profileFor(email));
    expectRefusedAt(location, "EMAIL_NOT_ALLOWED");
    expect(await userByEmail(email)).toBeNull();
    expect((await inviteRow(inviteCode!))!.uses).toBe(0);
  });

  it("activates the pending shares addressed to the new, already verified, address", async () => {
    const owner = await verifiedUser();
    const folder = await makeFolder(owner.user.id);
    const email = freshEmail();
    const share = await makePendingShare(folder.id, owner.user.id, email.toUpperCase());
    const client = newClient();
    await intent(client);
    expect((await googleRoundTrip(client, profileFor(email))).location).toBe("/");
    const row = await userByEmail(email);
    const activated = await shareById(share.id);
    expect(activated!.granteeUserId).toBe(row!.id);
    expect(activated!.activatedAt).toBeInstanceOf(Date);
  });
});

describe("a Google sign-in of an existing account", () => {
  it("needs no intent, and creates no second account", async () => {
    const client = newClient();
    const email = freshEmail();
    const profile = profileFor(email);
    await intent(client);
    expect((await googleRoundTrip(client, profile)).location).toBe("/");
    const row = await userByEmail(email);
    await send(client, "/api/auth/sign-out", { json: {} });
    expect(await getSession(client)).toBeNull();

    const again = newClient();
    expect(again.cookies.has("hf_intent")).toBe(false);
    const { location } = await googleRoundTrip(again, profile, "/login");
    expect(location).toBe("/");
    expect((await getSession(again))?.user.id).toBe(row!.id);
    expect(await sessionsOf(row!.id)).toHaveLength(1);
  });

  it("links to a VERIFIED password account with the same address — and not to an unverified one", async () => {
    const verified = await verifiedUser();
    const client = newClient();
    expect((await googleRoundTrip(client, profileFor(verified.email), "/login")).location).toBe("/");
    expect((await getSession(client))?.user.id).toBe(verified.user.id);
    expect((await accountsOf(verified.user.id)).map((a) => a.providerId).sort()).toEqual([
      "credential",
      "google",
    ]);

    // An address someone signed up with but never proved: Google must not sign in to it as it is
    // (the account could be an attacker's, waiting for the real owner to arrive). From the
    // sign-in screen — no intent step — it is refused like any Google sign-up without one, and
    // nothing is linked or removed. With the intent step the account is emptied first:
    // tests/unit/auth/google-linking.test.ts.
    const unverified = await signUp(newClient());
    const victim = newClient();
    const { location } = await googleRoundTrip(victim, profileFor(unverified.email), "/login");
    expect(new URL(location, "http://x").searchParams.get("error")).toBe("SIGNUP_INTENT_REQUIRED");
    expect(await getSession(victim)).toBeNull();
    const row = await userByEmail(unverified.email);
    expect((await accountsOf(row!.id)).map((a) => a.providerId)).toEqual(["credential"]);
  });
});
