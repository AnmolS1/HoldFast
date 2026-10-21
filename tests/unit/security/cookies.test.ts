// Cookies (T26 item 4, extending T06/T07's tests). Correction to the task file: the prefix is
// `__Host-`, not `__Secure-` (auth/create-auth.ts `cookiePrefix`, auth/signed-cookie.ts
// COOKIE_HOST_PREFIX — a deliberate T06 ruling: a sibling subdomain can plant a `__Secure-`
// cookie, never a `__Host-` one).
//   - https: every cookie the auth flows set is `__Host-`, Secure, Path=/, no Domain, HttpOnly,
//     SameSite=Lax;
//   - http (local): the bare `hf` prefix, the same attributes without Secure;
//   - nothing but the auth layer sets a cookie on the app host;
//   - the files host sets none, for every path class and every kind of answer.
import { describe, expect, it } from "vitest";
import {
  createInvite,
  enableTotp,
  httpsClient,
  linkIn,
  newClient,
  nextTotp,
  send,
  signIn,
  signUp,
  verifiedUser,
  waitForMail,
  type Client,
} from "../auth/helpers";
import { ask, imagesMock, linkOn, makeAccount, pattern, storedFile, urlFor } from "../files-host/harness";
import { appWith, call, fakeCore } from "../worker-core/helpers";

const nameOf = (cookie: string) => cookie.split("=")[0]!;

/** Every flow of the auth layer that sets a cookie, from one browser of `origin`. */
async function cookiesOfEveryFlow(client: Client, more: Client): Promise<string[]> {
  const seen: string[] = [];
  const { email, sent } = await signUp(client);
  seen.push(...sent.setCookies);
  const mail = await waitForMail(email, "verification");
  seen.push(...(await send(client, linkIn(mail))).setCookies);
  seen.push(
    ...(
      await send(more, "/api/auth-intent", {
        json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: await createInvite() },
      })
    ).setCookies,
  );
  seen.push(
    ...(
      await send(more, "/api/auth/sign-in/social", {
        json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
      })
    ).setCookies,
  );
  seen.push(...(await send(client, "/api/auth/passkey/generate-register-options")).setCookies);
  seen.push(...(await send(more, "/api/auth/passkey/generate-authenticate-options")).setCookies);
  const totp = await enableTotp(client);
  seen.push(...(await send(client, "/api/auth/sign-out", { json: {} })).setCookies);
  seen.push(...(await signIn(client, email)).setCookies);
  seen.push(
    ...(
      await send(client, "/api/auth/two-factor/verify-totp", {
        json: { code: await nextTotp(totp.totpURI), trustDevice: true },
      })
    ).setCookies,
  );
  return seen;
}

describe("auth cookies", () => {
  it("https: every one is __Host-, Secure, Path=/, no Domain, HttpOnly, SameSite=Lax", async () => {
    const origin = "https://holdfast.example";
    const { client } = httpsClient(origin);
    const seen = await cookiesOfEveryFlow(client, newClient({ origin, env: client.env }));
    const names = new Set(seen.map(nameOf));
    for (const expected of [
      "hf.session_token",
      "hf_pending",
      "hf_intent",
      "hf.two_factor",
      "hf.trust_device",
    ]) {
      expect([...names], expected).toContain(`__Host-${expected}`);
    }
    for (const cookie of seen) {
      const name = nameOf(cookie);
      expect(name.startsWith("__Host-hf"), name).toBe(true);
      expect(cookie, name).toMatch(/; Secure(;|$)/);
      expect(cookie, name).toMatch(/; Path=\/(;|$)/);
      expect(cookie, name).not.toMatch(/Domain=/i);
      expect(cookie, name).toMatch(/; HttpOnly(;|$)/);
      expect(cookie, name).toMatch(/; SameSite=Lax(;|$)/);
    }
  });

  it("http (local): the bare hf prefix, the same attributes, never Secure or __Host-", async () => {
    const seen = await cookiesOfEveryFlow(newClient(), newClient());
    expect(seen.length).toBeGreaterThanOrEqual(7);
    for (const cookie of seen) {
      const name = nameOf(cookie);
      expect(name, name).toMatch(/^hf[._]/);
      expect(cookie, name).not.toMatch(/; Secure/);
      expect(cookie, name).toMatch(/; Path=\/(;|$)/);
      expect(cookie, name).not.toMatch(/Domain=/i);
      expect(cookie, name).toMatch(/; HttpOnly(;|$)/);
      expect(cookie, name).toMatch(/; SameSite=Lax(;|$)/);
    }
  });

  it("nothing but the auth layer sets a cookie on the app host: the shell, assets, the API, the CSP report", async () => {
    const { client } = await verifiedUser();
    for (const [path, options] of [
      ["/api/account/usage", {}],
      ["/api/nodes/root", {}],
      ["/api/public/config", {}],
      ["/api/health", {}],
    ] as const) {
      const sent = await send(client, path, options);
      expect(sent.setCookies, path).toEqual([]);
    }
    const app = appWith(fakeCore());
    for (const path of ["/", "/files", "/s/abcdefghijklmnop", "/assets/missing.js", "/__meta", "/api/nope"]) {
      const { response, ctx } = await call(app, path, {
        headers: { cookie: "hf.session_token=made-up-test-value" },
      });
      expect(response.headers.getSetCookie(), path).toEqual([]);
      await response.arrayBuffer();
      await ctx.settle();
    }
    const report = await call(app, "/api/public/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }),
    });
    expect(report.response.headers.getSetCookie()).toEqual([]);
    await report.response.arrayBuffer();
    await report.ctx.settle();
  });
});

describe("the files host never sets a cookie", () => {
  it("for every path class, every subject and every kind of answer", async () => {
    const owner = await makeAccount();
    const { node } = await storedFile(owner.id, { mime: "image/png", name: "a.png", content: pattern(300) });
    const link = await linkOn(node.id, owner.id);
    const linkSubject = { link: { id: link.id, passwordHash: null } };
    const paths = [
      "/",
      "/index.html",
      "/nope",
      "/d/abc/def",
      await urlFor("download", node, { user: owner.id }),
      await urlFor("inline", node, { user: owner.id }),
      await urlFor("thumb", node, { user: owner.id }),
      await urlFor("download", node, linkSubject),
      await urlFor("inline", node, linkSubject),
    ];
    const statuses = new Set<number>();
    for (const path of paths) {
      for (const options of [
        { env: { IMAGES: imagesMock().binding } },
        { method: "HEAD", env: { IMAGES: imagesMock().binding } },
        { headers: { range: "bytes=0-9", cookie: "hf.session_token=made-up-test-value" } },
        { env: { RL_FILES: { limit: async () => ({ success: false }) } } },
      ]) {
        const answer = await ask(path, options);
        statuses.add(answer.status);
        expect(answer.headers.getSetCookie(), `${options.method ?? "GET"} ${path}`).toEqual([]);
      }
    }
    // 200, 206, 403, 404 and 429 were all among them.
    expect([...statuses].sort()).toEqual(expect.arrayContaining([200, 206, 403, 404, 429]));
  });
});
