// One strict reading of the Cookie header (middleware/cookie-guard.ts), and what follows from it:
// nobody who can ADD a cookie to a request decides which value the server reads.
//
// Better Auth's parser (better-call/dist/cookies.mjs `parseCookies`): the name is trimmed and
// compared exactly, and of two cookies with one name the FIRST wins. So with no guard, a planted
// cookie placed first is the one that counts. Every case below is a request as such an attacker
// would shape it, through the real app.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  INTENT_COOKIE,
  mintPending,
  PENDING_COOKIE,
  readIntent,
  readPending,
  sign,
} from "../../../src/worker/auth/signed-cookie";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { cookieFamily, guardCookies } from "../../../src/worker/middleware/cookie-guard";
import { session, user } from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import { testVars } from "../../setup/test-vars";
import {
  auditRows,
  createInvite,
  enableTotp,
  freshEmail,
  getSession,
  linkIn,
  newClient,
  nextTotp,
  send,
  sessionsOf,
  signIn,
  signUp,
  testDb,
  userByEmail,
  verifiedUser,
  waitForMail,
  type Client,
  httpsClient,
} from "./helpers";

const SESSION = "hf.session_token";
const keys = createKeys(testVars.FILES_TOKEN_SECRET);

/** One request with exactly this Cookie header (no jar), from a fresh address. */
function raw(path: string, cookie: string, options: Parameters<typeof send>[2] = {}, origin?: string) {
  const client = newClient(origin ? { origin } : {});
  return send(client, path, { ...options, headers: { ...options.headers, cookie } });
}

const sessionOf = async (cookie: string, origin?: string) =>
  ((await raw("/api/auth/get-session", cookie, {}, origin)).body as { user: { id: string } } | null)?.user
    .id ?? null;

describe("the reading of the header (pure)", () => {
  it("a family is the name trimmed, decoded, lower-cased and without its prefix", () => {
    for (const name of [
      "hf.session_token",
      " hf.session_token",
      "HF.Session_Token",
      "hf%2Esession_token",
      "hf%252Esession_token",
      "__Host-hf.session_token",
      "__Secure-hf.session_token",
      "__secure-HF.session_token",
      "%5F%5FSecure-hf.session_token",
      "\thf.session_token ",
    ]) {
      expect(cookieFamily(name), JSON.stringify(name)).toBe("hf.session_token");
    }
    expect(cookieFamily("theme")).toBeNull();
    expect(cookieFamily("xhf.session_token")).toBeNull();
    expect(cookieFamily("hf_pending")).toBe("hf_pending");
  });

  it("keeps a header whose cookies of ours are each there once, under the exact name; touches nothing else", () => {
    expect(guardCookies("theme=dark; hf.session_token=a.b; hf_pending=c.d", false)).toEqual({
      ambiguous: [],
    });
    expect(guardCookies("__Host-hf.session_token=a.b; x=1", true)).toEqual({ ambiguous: [] });
    expect(guardCookies(null, true)).toEqual({ ambiguous: [] });
    // Somebody else's duplicate is not ours to judge.
    expect(guardCookies("theme=a; theme=b; hf.session_token=a.b", false)).toEqual({ ambiguous: [] });
  });

  it.each([
    ["a duplicate, the planted one first", "hf.session_token=evil; hf.session_token=real", false],
    ["a duplicate, the planted one last", "hf.session_token=real; hf.session_token=evil", false],
    ["a case variant", "HF.session_token=evil; hf.session_token=real", false],
    ["a percent-encoded name", "hf%2Esession_token=evil; hf.session_token=real", false],
    ["a padded name", "hf.session_token=real;   hf.session_token =evil", false],
    ["a tab-padded name alone", "\thf.session_token=evil", false],
    ["a prefix-less name on https", "hf.session_token=evil", true],
    ["a __Secure- name on https", "__Secure-hf.session_token=evil", true],
    [
      "a __Secure- shadow beside the real one",
      "__Secure-hf.session_token=evil; __Host-hf.session_token=real",
      true,
    ],
    ["a lower-cased prefix", "__host-hf.session_token=evil", true],
    ["a __Host- name on plain http", "__Host-hf.session_token=evil", false],
  ])("%s → the whole family is removed", (_what, header, secure) => {
    const guarded = guardCookies(`theme=dark; ${header}; other=1`, secure);
    expect(guarded.ambiguous).toEqual(["hf.session_token"]);
    expect(guarded.header).toBe("theme=dark; other=1");
  });
});

describe("a session cookie that is not alone under its exact name is no session", () => {
  it("two session cookies — in either order — are nobody; each alone is its own account", async () => {
    const victim = await verifiedUser();
    const attacker = await verifiedUser();
    const real = `${SESSION}=${victim.client.cookies.get(SESSION)}`;
    const planted = `${SESSION}=${attacker.client.cookies.get(SESSION)}`;
    // Control: each cookie alone is a session of its account.
    expect(await sessionOf(real)).toBe(victim.user.id);
    expect(await sessionOf(planted)).toBe(attacker.user.id);
    for (const header of [`${planted}; ${real}`, `${real}; ${planted}`, `x=1; ${planted}; y=2; ${real}`]) {
      expect(await sessionOf(header), header.slice(0, 20)).toBeNull();
      const app = await raw("/api/account/deletion-status", header);
      expect(app.status).toBe(401);
      const write = await raw("/api/auth/update-user", header, { json: { name: "Planted" } });
      expect(write.status).toBe(401);
    }
    expect((await userByEmail(victim.email))!.name).not.toBe("Planted");
    expect((await userByEmail(attacker.email))!.name).not.toBe("Planted");
    const audited = await auditRows({ action: "auth.cookie_ambiguous" });
    expect(audited.length).toBeGreaterThanOrEqual(9);
    const text = JSON.stringify(audited.slice(-9));
    expect(text).toContain("hf.session_token");
    // Names only: no cookie value is in the audit log.
    expect(text).not.toContain(victim.client.cookies.get(SESSION)!.slice(0, 16));
    expect(text).not.toContain(attacker.client.cookies.get(SESSION)!.slice(0, 16));
  });

  it("a shadow under another spelling beside the real cookie: nobody (not the shadow, not the real one)", async () => {
    const victim = await verifiedUser();
    const attacker = await verifiedUser();
    const realValue = victim.client.cookies.get(SESSION)!;
    const plantedValue = attacker.client.cookies.get(SESSION)!;
    for (const shadow of [
      "HF.session_token",
      "hf%2Esession_token",
      " hf.session_token ",
      "Hf.Session_Token",
    ]) {
      expect(await sessionOf(`${shadow}=${plantedValue}; ${SESSION}=${realValue}`), shadow).toBeNull();
      expect(await sessionOf(`${SESSION}=${realValue}; ${shadow}=${plantedValue}`), shadow).toBeNull();
    }
    // A shadow alone is not the cookie.
    expect(await sessionOf(`HF.session_token=${plantedValue}`)).toBeNull();
    expect(await sessionOf(`hf%2Esession_token=${plantedValue}`)).toBeNull();
  });

  it("on https only the __Host- name is the cookie: the prefix-less and the __Secure- name are ignored, alone or beside it", async () => {
    const https = "https://holdfast.example";
    // (an https origin has no memory outbox: its mail goes through the transport's stand-in)
    const { client } = httpsClient(https);
    const { email } = await signUp(client);
    await send(client, linkIn(await waitForMail(email, "verification")));
    const value = client.cookies.get(`__Host-${SESSION}`)!;
    const id = (await userByEmail(email))!.id;
    expect(await sessionOf(`__Host-${SESSION}=${value}`, https)).toBe(id);
    for (const header of [
      `${SESSION}=${value}`,
      `__Secure-${SESSION}=${value}`,
      `__host-${SESSION}=${value}`,
      `__Secure-${SESSION}=${value}; __Host-${SESSION}=${value}`,
      `__Host-${SESSION}=${value}; ${SESSION}=${value}`,
    ]) {
      expect(await sessionOf(header, https), header.split("=")[0]).toBeNull();
    }
  });
});

describe("the same for every other cookie the auth layer reads", () => {
  const twice = (client: Client, name: string, planted = "planted.value") =>
    [...client.cookies]
      .map(([key, value]) => `${key}=${value}`)
      .concat(`${name}=${planted}`)
      .join("; ");

  it("hf_pending sent twice: the pending-address route has no claim", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const header = twice(client, "hf_pending", client.cookies.get("hf_pending"));
    const sent = await raw("/api/account/pending-email", header, {
      method: "PATCH",
      json: { email: freshEmail() },
    });
    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ details: { reason: "no_pending_signup" } });
    expect(await userByEmail(email)).not.toBeNull();
  });

  it("hf_pending sent twice: the verification link treats the browser as a stranger's (no session, password removed)", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const link = linkIn(await waitForMail(email, "verification"));
    const clicked = await raw(link, twice(client, "hf_pending", client.cookies.get("hf_pending")));
    expect(clicked.headers.get("location")).toContain("/set-password#token=");
    expect(await sessionsOf((await userByEmail(email))!.id)).toEqual([]);
  });

  it("hf_intent sent twice: a Google sign-up has no intent", async () => {
    const client = newClient();
    const intent = await send(client, "/api/auth-intent", {
      json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: await createInvite() },
    });
    expect(intent.status).toBe(200);
    const start = await send(client, "/api/auth/sign-in/social", {
      json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
    });
    const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
    const email = freshEmail();
    const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email, name: "G" });
    const callback = await raw(
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      twice(client, "hf_intent", client.cookies.get("hf_intent")),
      { browser: false },
    );
    expect(callback.headers.get("location")).toContain("error=SIGNUP_INTENT_REQUIRED");
    expect(await userByEmail(email)).toBeNull();
  });

  it("the OAuth state cookie sent twice: the callback is refused, nobody is signed in", async () => {
    const owner = await verifiedUser();
    const client = newClient();
    const start = await send(client, "/api/auth/sign-in/social", {
      json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
    });
    const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
    const stateCookie = [...client.cookies.keys()].find((name) => /state/.test(name))!;
    expect(stateCookie).toBeDefined();
    const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email: owner.email, name: "G" });
    const before = (await sessionsOf(owner.user.id)).length;
    const callback = await raw(
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      twice(client, stateCookie, client.cookies.get(stateCookie)),
      { browser: false },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=");
    expect(callback.setCookies.join("\n")).not.toContain("session_token=ey");
    expect((await sessionsOf(owner.user.id)).length).toBe(before);
  });

  it("the two-factor challenge cookie sent twice: the code completes nothing", async () => {
    const made = await verifiedUser();
    const { totpURI } = await enableTotp(made.client);
    await send(made.client, "/api/auth/sign-out", { json: {} });
    const browser = newClient();
    await signIn(browser, made.email);
    const header = twice(browser, "hf.two_factor", browser.cookies.get("hf.two_factor"));
    const sent = await raw("/api/auth/two-factor/verify-totp", header, {
      json: { code: await nextTotp(totpURI) },
    });
    expect(sent.status).toBe(401);
    expect(await sessionsOf(made.user.id)).toEqual([]);
    // Control: the same challenge, sent once, completes.
    const once = await send(browser, "/api/auth/two-factor/verify-totp", {
      json: { code: await nextTotp(totpURI) },
    });
    expect(once.status, once.text).toBe(200);
  });

  it("the trusted-device cookie sent twice: the device is not trusted", async () => {
    const made = await verifiedUser();
    const { totpURI } = await enableTotp(made.client);
    await send(made.client, "/api/auth/sign-out", { json: {} });
    const browser = newClient();
    await signIn(browser, made.email);
    await send(browser, "/api/auth/two-factor/verify-totp", {
      json: { code: await nextTotp(totpURI), trustDevice: true },
    });
    await send(browser, "/api/auth/sign-out", { json: {} });
    const header = twice(browser, "hf.trust_device", browser.cookies.get("hf.trust_device"));
    const again = await raw("/api/auth/sign-in/email", header, {
      json: { email: made.email, password: "correct horse battery staple 9!" },
      headers: { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
    });
    expect(again.body).toMatchObject({ twoFactorRedirect: true });
    // Control: sent once, it is trusted.
    expect((await signIn(browser, made.email)).body).not.toMatchObject({ twoFactorRedirect: true });
  });
});

describe("a signed cookie is the cookie it was signed as", () => {
  const at = new Date();
  const e = Math.floor(at.getTime() / 1000) + 300;

  it("what is signed names its cookie and its version; a value signed as one is not read as the other — even under one key", async () => {
    const pending = await mintPending(keys, { email: "a@b.example", userId: "u".repeat(32) }, 0, at);
    const payload = JSON.parse(atob(pending.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload).toMatchObject({ v: 2, p: "hf_pending", m: "a@b.example", u: "u".repeat(32), c: 0 });
    expect(typeof payload.e).toBe("number");
    expect(await readPending(env, keys, `hf_pending=${pending}`, at)).not.toBeNull();
    // The same VALUE presented as the intent cookie (its own key differs anyway)…
    expect(await readIntent(env, keys, `hf_intent=${pending}`, at)).toBeNull();
    // …and a value shaped like a pending claim but SIGNED as the intent cookie, under the very key
    // the pending cookie is verified with: the MAC checks out, the purpose does not.
    const crossed = await sign(
      keys,
      { ...INTENT_COOKIE, purpose: PENDING_COOKIE.purpose },
      {
        e,
        m: "a@b.example",
        u: "u".repeat(32),
        c: 0,
      },
    );
    expect(await readPending(env, keys, `hf_pending=${crossed}`, at)).toBeNull();
    const crossedBack = await sign(
      keys,
      { ...PENDING_COOKIE, purpose: INTENT_COOKIE.purpose },
      {
        e,
        n: "nonce-nonce-nonce-nonce",
        i: null,
      },
    );
    expect(await readIntent(env, keys, `hf_intent=${crossedBack}`, at)).toBeNull();
    // An older version of the payload is not read at all.
    const body = btoa(JSON.stringify({ v: 1, e, m: "a@b.example", u: "u".repeat(32), c: 0 })).replace(
      /=+$/,
      "",
    );
    expect(await readPending(env, keys, `hf_pending=${body}.${pending.split(".")[1]}`, at)).toBeNull();
  });
});

describe("session fixation: a session id present BEFORE authentication is never the one in use AFTER it", () => {
  /** A browser into which an attacker has planted a valid session cookie of the ATTACKER's account. */
  async function plantedBrowser() {
    const attacker = await verifiedUser();
    const browser = newClient();
    const planted = attacker.client.cookies.get(SESSION)!;
    browser.cookies.set(SESSION, planted);
    return { attacker, browser, planted };
  }
  const tokenOf = (value: string) => decodeURIComponent(value).split(".")[0]!;

  async function expectFresh(browser: Client, planted: string, victimId: string, attackerId: string) {
    const now = browser.cookies.get(SESSION)!;
    expect(now).not.toBe(planted);
    expect((await getSession(browser))?.user.id).toBe(victimId);
    // The victim's session row is a new one; the attacker's own row was not handed over.
    const rows = await testDb()
      .select()
      .from(session)
      .where(eq(session.token, tokenOf(now)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(victimId);
    const old = await testDb()
      .select()
      .from(session)
      .where(eq(session.token, tokenOf(planted)));
    for (const row of old) expect(row.userId).toBe(attackerId);
  }

  it("password sign-in", async () => {
    const { attacker, browser, planted } = await plantedBrowser();
    const victim = await verifiedUser();
    expect((await signIn(browser, victim.email)).status).toBe(200);
    await expectFresh(browser, planted, victim.user.id, attacker.user.id);
  });

  it("password + two-factor code", async () => {
    const { attacker, browser, planted } = await plantedBrowser();
    const victim = await verifiedUser();
    const { totpURI } = await enableTotp(victim.client);
    await signIn(browser, victim.email);
    const done = await send(browser, "/api/auth/two-factor/verify-totp", {
      json: { code: await nextTotp(totpURI) },
    });
    // With a session cookie present the plugin treats the code as one for THAT session (the
    // attacker's account, which has no two-factor): it completes nothing for the victim…
    if (done.status !== 200) {
      expect((await getSession(browser))?.user.id ?? attacker.user.id).toBe(attacker.user.id);
      // …and without the planted cookie, the challenge completes into a session of its own.
      browser.cookies.delete(SESSION);
      await signIn(browser, victim.email);
      const again = await send(browser, "/api/auth/two-factor/verify-totp", {
        json: { code: await nextTotp(totpURI) },
      });
      expect(again.status, again.text).toBe(200);
    }
    await expectFresh(browser, planted, victim.user.id, attacker.user.id);
  });

  it("Google", async () => {
    const { attacker, browser, planted } = await plantedBrowser();
    const victim = await verifiedUser();
    const start = await send(browser, "/api/auth/sign-in/social", {
      json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
    });
    const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
    const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email: victim.email, name: "G" });
    await send(
      browser,
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { browser: false },
    );
    await expectFresh(browser, planted, victim.user.id, attacker.user.id);
  });

  it("the verification link (same browser)", async () => {
    const { attacker, browser, planted } = await plantedBrowser();
    const { email } = await signUp(browser);
    await send(browser, linkIn(await waitForMail(email, "verification")));
    await expectFresh(browser, planted, (await userByEmail(email))!.id, attacker.user.id);
  });

  it("a privilege change ends the sessions that existed before it", async () => {
    const admin = await verifiedUser();
    const { totpURI } = await enableTotp(admin.client);
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, admin.user.id));
    await send(admin.client, "/api/auth/sign-out", { json: {} });
    await signIn(admin.client, admin.email);
    await send(admin.client, "/api/auth/two-factor/verify-totp", { json: { code: await nextTotp(totpURI) } });
    const target = await verifiedUser();
    const second = newClient();
    await signIn(second, target.email);
    expect(await sessionsOf(target.user.id)).toHaveLength(2);
    const changed = await send(admin.client, "/api/auth/admin/set-role", {
      json: { userId: target.user.id, role: "admin" },
    });
    expect(changed.status, changed.text).toBe(200);
    expect(await sessionsOf(target.user.id)).toEqual([]);
    expect(await getSession(target.client)).toBeNull();
    expect(await getSession(second)).toBeNull();
    // Enabling two-factor replaces the session it was enabled in (a new token, the old row gone).
    const fresh = await verifiedUser();
    const before = fresh.client.cookies.get(SESSION)!;
    await enableTotp(fresh.client);
    expect(fresh.client.cookies.get(SESSION)).not.toBe(before);
    expect(
      await testDb()
        .select()
        .from(session)
        .where(eq(session.token, tokenOf(before))),
    ).toEqual([]);
  });
});
