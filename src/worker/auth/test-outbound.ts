// TEST MODE ONLY: stand-ins for the third parties the auth layer calls from inside the Worker.
//
// Better Auth's breach check, its Google token exchange and its Turnstile check, and our own MX
// lookup, are `fetch` calls made by the Worker itself. A browser test cannot intercept those, and
// a test must never send a password hash prefix to the real breach API, or a real OAuth client
// secret to Google. So in TEST MODE — the same three-condition gate as the mail outbox and the
// clock override (services/clock.ts: the memory mail transport, not production, AND a plain-http
// APP_ORIGIN; a deploy is always https, so the gate is closed there whatever a var says) — the
// global `fetch` is wrapped once per isolate and answers these hosts itself:
//
//   api.pwnedpasswords.com/range/<5 hex>   the k-anonymity range answer; "breached" is exactly
//                                          the passwords in BREACHED_TEST_PASSWORDS
//   cloudflare-dns.com/dns-query?type=MX   an MX record for every domain, except
//                                          *.nxdomain.test (no such domain) and
//                                          *.nullmx.test (the null MX)
//   oauth2.googleapis.com/token            ONLY for an authorization `code` made by
//                                          `testGoogleCode`: a token response whose id_token
//                                          carries the profile the test put in the code (Better
//                                          Auth decodes, and does not verify, an id_token it
//                                          received from the token endpoint). A real code — a
//                                          developer signing in with Google locally — goes to
//                                          Google as usual.
//   challenges.cloudflare.com/…/siteverify ONLY for Cloudflare's published test secrets: the
//                                          always-pass secret passes, the always-fail one fails.
//                                          That holds under `vite dev` too — an end-to-end run
//                                          makes no call to Cloudflare. A request carrying any
//                                          other secret (a developer's real one) is not ours to
//                                          answer and goes to the real endpoint.
//
// Every other request goes to the network as usual — except under the unit-test environment
// (`SENTRY_ENVIRONMENT === "test"`), where an unexpected outbound request THROWS: no unit test
// makes a real network call, and one that tries fails loudly instead of flaking.
//
// Outside test mode `installTestOutbound` does nothing at all: `fetch` is not touched.

import {
  isListedAdmin,
  parseAdminList,
  RESERVED_TEST_DOMAIN,
  type AdminList,
} from "../../shared/admin-emails";
import { isTestMode } from "../services/clock";

/** Passwords the stand-in breach API reports as breached. Long enough to pass the length rule. */
export const BREACHED_TEST_PASSWORDS = ["breached-password-fixture-1", "password123456789"] as const;

export const TURNSTILE_TEST_SECRET_PASS = "1x0000000000000000000000000000000AA";
export const TURNSTILE_TEST_SECRET_FAIL = "2x0000000000000000000000000000000AA";

export type TestOutboundCall = { host: string; path: string; method: string };

type Handler = (request: Request, url: URL) => Promise<Response> | Response;

type State = {
  original: typeof fetch;
  strict: boolean;
  /** Addresses the stand-in Google must never vouch for (see `googleToken`). */
  realAdmins: AdminList;
  calls: TestOutboundCall[];
  /** Extra hosts a test answers itself (the Resend API, a failing DoH …). Checked first. */
  overrides: Map<string, Handler>;
};

const INSTALLED = Symbol.for("holdfast:test-outbound");
const holder = globalThis as unknown as Record<symbol, State | undefined>;

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function pwnedRange(url: URL): Promise<Response> {
  const prefix = url.pathname.split("/").pop()?.toUpperCase() ?? "";
  const lines: string[] = [];
  for (const password of BREACHED_TEST_PASSWORDS) {
    const hash = await sha1Hex(password);
    if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:1337`);
  }
  // Padding entries, as the real API sends with `Add-Padding: true` (count 0 = not a match).
  lines.push("0000000000000000000000000000000000A:0", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0");
  return new Response(lines.join("\r\n"), { headers: { "content-type": "text/plain" } });
}

function dnsAnswer(url: URL): Response {
  const name = (url.searchParams.get("name") ?? "").toLowerCase();
  if (name === "nxdomain.test" || name.endsWith(".nxdomain.test")) return json({ Status: 3 });
  if (name === "nullmx.test" || name.endsWith(".nullmx.test")) {
    return json({ Status: 0, Answer: [{ name, type: 15, TTL: 300, data: "0 ." }] });
  }
  return json({ Status: 0, Answer: [{ name, type: 15, TTL: 300, data: `10 mx.${name}.` }] });
}

const base64Url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type TestGoogleProfile = { sub: string; email: string; name?: string; email_verified?: boolean };

/** The authorization `code` that makes the stand-in token endpoint answer with this profile. */
export function testGoogleCode(profile: TestGoogleProfile): string {
  return `test.${base64Url(JSON.stringify(profile))}`;
}

/**
 * The ADMIN_EMAILS entries that are real mailboxes — everything not at a reserved test domain —
 * by the ONE parser of that list (shared/admin-emails.ts).
 */
export function realAdminAddresses(list: string | undefined): AdminList {
  const parsed = parseAdminList(list);
  return {
    addresses: new Set([...parsed.addresses].filter((entry) => !RESERVED_TEST_DOMAIN.test(entry))),
    invalid: parsed.invalid,
  };
}

/**
 * Null: not a test code — a real authorization code from a real Google sign-in in local dev.
 *
 * The stand-in vouches for whatever address the test code names. So it REFUSES an address on
 * ADMIN_EMAILS that is a real mailbox (T19): a local dev server reached through a tunnel would
 * otherwise hand the admin role, on the developer's database, to anyone who can type
 * `test.<base64>`. Test admins live at reserved domains (`.example`, `.test`) and are not affected.
 */
async function googleToken(request: Request, state: Pick<State, "realAdmins">): Promise<Response | null> {
  const form = new URLSearchParams(await request.clone().text());
  const code = form.get("code") ?? "";
  if (!code.startsWith("test.")) return null;
  let profile: TestGoogleProfile;
  try {
    const padded = code.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    profile = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
  } catch {
    return json({ error: "invalid_grant" }, 400);
  }
  // The same matcher that grants the role decides here whom the stand-in may not be — asked about
  // the address as given AND as the handler would store it (it lower-cases a provider's address
  // with `toLowerCase()`; auth/create-auth.ts refuses the non-ASCII ones, this is the belt).
  if (
    typeof profile?.email !== "string" ||
    isListedAdmin(state.realAdmins, profile.email) ||
    isListedAdmin(state.realAdmins, profile.email.toLowerCase())
  ) {
    return json({ error: "invalid_grant" }, 400);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com",
    aud: form.get("client_id") ?? "",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    email_verified: true,
    name: "Test Google User",
    ...profile,
  };
  const idToken = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }))}.${base64Url(JSON.stringify(claims))}.dGVzdA`;
  return json({
    access_token: "test-google-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid email profile",
    id_token: idToken,
  });
}

async function turnstile(request: Request, state: State): Promise<Response | null> {
  let secret = "";
  try {
    secret = ((await request.clone().json()) as { secret?: string }).secret ?? "";
  } catch {
    secret = "";
  }
  if (secret === TURNSTILE_TEST_SECRET_PASS)
    return json({ success: true, "error-codes": [], hostname: "localhost" });
  if (secret === TURNSTILE_TEST_SECRET_FAIL) {
    return json({ success: false, "error-codes": ["invalid-input-response"] });
  }
  // Any other secret is not ours to answer for.
  return state.strict ? null : state.original(request);
}

/**
 * What one outbound request gets in test mode. Exported for its tests, which pass a state of
 * their own (the isolate's installed state is fixed at the first `installTestOutbound`).
 */
export async function routeTestOutbound(
  request: Request,
  state: Pick<State, "original" | "strict"> & Partial<Pick<State, "calls" | "overrides" | "realAdmins">>,
): Promise<Response> {
  return route(request, {
    calls: [],
    overrides: new Map(),
    realAdmins: { addresses: new Set(), invalid: 0 },
    ...state,
  });
}

async function route(request: Request, state: State): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;
  state.calls.push({ host, path: url.pathname, method: request.method });
  if (state.calls.length > 500) state.calls.splice(0, state.calls.length - 500);

  const override = state.overrides.get(host);
  if (override) return override(request, url);

  if (host === "api.pwnedpasswords.com" && url.pathname.startsWith("/range/")) return pwnedRange(url);
  if (host === "cloudflare-dns.com" && url.pathname === "/dns-query") return dnsAnswer(url);
  if (host === "oauth2.googleapis.com" && url.pathname === "/token") {
    const answered = await googleToken(request, state);
    if (answered) return answered;
  }
  if (host === "challenges.cloudflare.com" && url.pathname.endsWith("/siteverify")) {
    const answered = await turnstile(request, state);
    if (answered) return answered;
  }

  if (state.strict) {
    throw new Error(`test mode: unexpected outbound request to ${host}${url.pathname}`);
  }
  return state.original(request);
}

type ModeEnv = {
  EMAIL_TRANSPORT?: string;
  SENTRY_ENVIRONMENT?: string;
  APP_ORIGIN?: string;
  ADMIN_EMAILS?: string;
};

/**
 * Wraps the global `fetch` — in test mode only, once per isolate. Returns whether the stand-ins
 * are active. Called by `createAuth`.
 */
export function installTestOutbound(env: ModeEnv): boolean {
  if (!isTestMode(env)) return false;
  if (holder[INSTALLED]) return true;
  const original = globalThis.fetch.bind(globalThis);
  const state: State = {
    original,
    strict: env.SENTRY_ENVIRONMENT === "test",
    realAdmins: realAdminAddresses(env.ADMIN_EMAILS),
    calls: [],
    overrides: new Map(),
  };
  holder[INSTALLED] = state;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const protocol = new URL(request.url).protocol;
    // Only real network requests: never a binding's or a test's own in-process fetch.
    if (protocol !== "https:" && protocol !== "http:") return original(request);
    return route(request, state);
  }) as typeof fetch;
  return true;
}

/** For tests: what the Worker tried to fetch, and a way to answer a host. Null when not installed. */
export function testOutbound(): {
  calls: TestOutboundCall[];
  answer(host: string, handler: Handler | null): void;
} | null {
  const state = holder[INSTALLED];
  if (!state) return null;
  return {
    calls: state.calls,
    answer(host, handler) {
      if (handler) state.overrides.set(host, handler);
      else state.overrides.delete(host);
    },
  };
}
