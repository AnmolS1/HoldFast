// Drives each rate-limited endpoint class past its limit and asserts the refusal: `429` with a
// `Retry-After` (T26 item 10). One class at a time, one request at a time; a class STOPS at its
// first `429` and sends nothing more until its Retry-After has passed (`--recheck` waits it out
// and sends exactly one more request, which must not be refused).
//
//   npx tsx scripts/security/ratelimit-probe.ts --base http://localhost:5190 --local
//   npx tsx scripts/security/ratelimit-probe.ts --base https://holdfast-dev.ponderance.dev \
//       --files https://dev.holdfastusercontent.com --session "$DIR/session.json" [--only api-anon,files]
//
// --base       the app origin;  --files the files origin (default: http://files.<base host> locally)
// --session    a session file from scripts/create-session.ts (`header` is sent as the Cookie);
//              the signed-in classes and the link-password class are skipped without one
// --search-session  a second session (another user): search needs a budget of its own
// --admin-session   a session of an admin whose session passed a second factor (create-session.ts
//              --role admin --two-factor): the admin class. Locally, with none, a throwaway user's
//              session — `RL_API` is spent before the admin guard, so its answers are 403 until the 429
// --local      `vite dev` only: each class gets an address of its own through CF-Connecting-IP (the
//              Worker trusts it locally; on a deploy Cloudflare sets it), and with no --session a
//              throwaway account is signed up through the test Turnstile token and the test outbox
// --only       a comma-separated list of class names
// --recheck    after a class's 429, wait Retry-After seconds and check one request passes again
//
// A class is `ok` only when refused AT its limit (within two requests). Classes that share a bucket —
// links and report (RL_LINKS ip:), api-anon, report and auth-admin (RL_API ip:) — must not run in
// the same minute from one address: without --local, run them one `--only` at a time, a minute apart.
//
// NEVER solves a captcha: the auth class is probed on the invite lookup (RL_AUTH, key inv:<ip>),
// which needs none; the report class sends a made-up link token, which is refused (404) before
// Turnstile is looked at, so nothing is ever filed. Nothing secret is printed: not the cookie, not
// a token, not an address.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { parseArgs } from "node:util";
import { localSession } from "./local-session";

type Klass = {
  name: string;
  limiter: string;
  key: string;
  limit: number;
  needsSession?: boolean;
  /** One request of the class (the n-th). */
  send: (n: number) => Promise<Response>;
  /** The refusal is our JSON envelope (app host) or plain text (files host). */
  plain?: boolean;
};

type Outcome = {
  name: string;
  limiter: string;
  key: string;
  limit: number;
  sent: number;
  refusedAt: number | null;
  retryAfter: string | null;
  body: string;
  recheck?: number;
  ok: boolean;
  note?: string;
};

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    files: { type: "string" },
    session: { type: "string" },
    "search-session": { type: "string" },
    "admin-session": { type: "string" },
    local: { type: "boolean", default: false },
    only: { type: "string" },
    recheck: { type: "boolean", default: false },
  },
});

if (!values.base) {
  console.error(
    "usage: ratelimit-probe.ts --base <app origin> [--files <files origin>] [--session <file>] [--search-session <file>] [--admin-session <file>] [--local] [--only a,b] [--recheck]",
  );
  process.exit(2);
}
const base = new URL(values.base).origin;
const files = values.files
  ? new URL(values.files).origin
  : `${new URL(base).protocol}//files.${new URL(base).host}`;
const local = values.local === true;
if (local && !/^(localhost|127\.0\.0\.1)$/.test(new URL(base).hostname)) {
  console.error("ratelimit-probe: --local is for a local `vite dev` only");
  process.exit(2);
}

const rand = (n: number) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(n)),
    (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
  ).join("");
/** A TEST-NET-2 address of its own per class (local only). */
const addressFor = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return `198.51.${100 + (bytes[0]! % 100)}.${1 + (bytes[1]! % 254)}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(ip: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(local && ip ? { "cf-connecting-ip": ip } : {}), ...extra };
}

/**
 * GET on the files origin. Locally `files.localhost` resolves to ::1 while `vite dev` listens on
 * 127.0.0.1 only, and fetch() will not send a Host header of its own: so a plain HTTP request to
 * 127.0.0.1 naming the files host.
 */
function filesGet(path: string, extra: Record<string, string>): Promise<Response> {
  if (!local) return fetch(`${files}${path}`, { headers: extra });
  const target = new URL(files);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: target.port, path, method: "GET", headers: { ...extra, host: target.host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── a session (local throwaway, or the file) ───────────────────────────────────────────────────
async function localCookie(ip: string): Promise<string> {
  return (await localSession(base, headers(ip))).header;
}

function sessionFromFile(path: string): string {
  const file = JSON.parse(readFileSync(path, "utf8")) as { header?: string };
  if (!file.header) throw new Error("the session file has no `header`");
  return file.header;
}

// ── the classes ────────────────────────────────────────────────────────────────────────────────
function classes(
  cookie: string | null,
  searchCookie: string | null,
  passwordLink: string | null,
  adminCookie: string | null,
): Klass[] {
  const ip = () => addressFor();
  const ipAuth = ip();
  const ipApi = ip();
  const ipFiles = ip();
  const ipLinks = ip();
  const ipUser = ip();
  const ipPassword = ip();
  const ipSearch = ip();
  const ipReport = ip();
  const ipAdmin = ip();
  const ipAuthAdmin = ip();
  const json = (extra: Record<string, string> = {}) => ({
    origin: base,
    "sec-fetch-site": "same-origin",
    ...extra,
  });
  return [
    {
      name: "auth",
      limiter: "RL_AUTH (20/60 s)",
      key: "inv:<address>",
      limit: 20,
      send: () => fetch(`${base}/api/invites/PROBE${rand(12)}`, { headers: headers(ipAuth) }),
    },
    {
      name: "api-anon",
      limiter: "RL_API (600/60 s)",
      key: "ip:<address>",
      limit: 600,
      send: () => fetch(`${base}/api/public/config`, { headers: headers(ipApi) }),
    },
    {
      name: "api-user",
      limiter: "RL_API (600/60 s)",
      key: "u:<user id>",
      limit: 600,
      needsSession: true,
      send: () =>
        fetch(`${base}/api/account/usage`, { headers: headers(ipUser, json({ cookie: cookie ?? "" })) }),
    },
    {
      name: "search",
      limiter: "RL_API (600/60 s); one search.query audit row per request",
      key: "u:<user id>",
      limit: 600,
      needsSession: true,
      send: (n) =>
        fetch(`${base}/api/search?q=probe${n % 7}&scope=all`, {
          headers: headers(ipSearch, json({ cookie: searchCookie ?? "" })),
        }),
    },
    {
      name: "files",
      limiter: "RL_FILES (300/60 s)",
      key: "ip:<address>",
      limit: 300,
      plain: true,
      send: () => filesGet(`/d/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e/${rand(40)}`, headers(ipFiles)),
    },
    {
      name: "links",
      limiter: "RL_LINKS (30/60 s)",
      key: "ip:<address>",
      limit: 30,
      send: () => fetch(`${base}/api/public/links/${rand(22)}`, { headers: headers(ipLinks) }),
    },
    {
      name: "link-password",
      limiter: "link password throttle (D7): per link + ipHashStable, 3 free, then 2^n s up to 900 s",
      key: "link id + ipHashStable",
      limit: 3,
      needsSession: true,
      send: () =>
        fetch(`${base}/api/public/links/${passwordLink ?? "x"}/unlock`, {
          method: "POST",
          headers: headers(ipPassword, json({ "content-type": "application/json" })),
          body: JSON.stringify({ password: `wrong-${rand(8)}` }),
        }),
    },
    {
      // T22: the visitor's report shares RL_LINKS' `ip:` bucket with the public link API (a
      // visitor browsing a folder link and reporting spends one budget). Behind it: Turnstile and
      // 5 reports a day per stable address hash (in Postgres; tests/unit/abuse/reports.test.ts).
      name: "report",
      limiter: "RL_LINKS (30/60 s), shared with /api/public/links/*",
      key: "ip:<address>",
      limit: 30,
      send: () =>
        fetch(`${base}/api/public/report`, {
          method: "POST",
          headers: headers(ipReport, json({ "content-type": "application/json" })),
          body: JSON.stringify({
            nodeId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e",
            linkToken: rand(22), // matches no link: refused 404 before Turnstile, nothing filed
            category: "spam",
            details: "",
            turnstileToken: "ratelimit-probe-not-a-token",
          }),
        }),
    },
    {
      // T25: the console's API has no limiter of its own — RL_API by user, spent before the guard.
      name: "admin",
      limiter: "RL_API (600/60 s), before requireAdmin",
      key: "u:<user id>",
      limit: 600,
      needsSession: true,
      send: () =>
        fetch(`${base}/api/admin/dashboard`, {
          headers: headers(ipAdmin, json({ cookie: adminCookie ?? "" })),
        }),
    },
    {
      // Better Auth's admin plugin (ban, unban, set role, impersonate): a bucket of its own,
      // RL_ADMIN, by the signed-in admin (by address when signed out, as here: refused by the
      // plugin's gate, counted all the same) — never the address's sign-in budget (T26B Q-B1).
      name: "auth-admin",
      limiter: "RL_ADMIN (60/60 s), not the sign-in budget",
      key: "u:<user id>; ip:<address> signed out",
      limit: 60,
      // Three of the plugin's paths in turn: Better Auth's own limiter counts 30 a minute per
      // address AND PATH, and would answer first on one path.
      send: (n) =>
        fetch(`${base}/api/auth/admin/${["unban-user", "set-role", "list-user-sessions"][n % 3]}`, {
          method: "POST",
          headers: headers(ipAuthAdmin, json({ "content-type": "application/json" })),
          body: JSON.stringify({ userId: "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL", role: "user" }),
        }),
    },
  ];
}

/** A password link on a fresh folder of the signed-in account (its token, never printed). */
async function makePasswordLink(cookie: string): Promise<string> {
  const ip = addressFor();
  const h = headers(ip, {
    cookie,
    origin: base,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  });
  const folder = await fetch(`${base}/api/nodes/folder`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ parentId: null, name: `ratelimit-probe ${rand(6)}` }),
  });
  if (!folder.ok) throw new Error(`folder: ${folder.status}`);
  const { id } = (await folder.json()) as { id: string };
  const link = await fetch(`${base}/api/nodes/${id}/links`, {
    method: "POST",
    headers: h,
    // Made up: the probe only ever sends wrong ones.
    body: JSON.stringify({ password: `probe-link-${rand(12)}`, allowPreview: true }),
  });
  if (!link.ok) throw new Error(`link: ${link.status}`);
  const { url } = (await link.json()) as { url: string | null };
  const token = url ? new URL(url).pathname.split("/")[2] : undefined;
  if (!token) throw new Error("link: no token in its url");
  return token;
}

async function probe(klass: Klass): Promise<Outcome> {
  const ceiling = Math.ceil(klass.limit * 1.5) + 10;
  let refusedAt: number | null = null;
  let retryAfter: string | null = null;
  let body = "";
  let sent = 0;
  for (let n = 1; n <= ceiling; n++) {
    const response = await klass.send(n);
    sent = n;
    if (response.status === 429) {
      refusedAt = n;
      retryAfter = response.headers.get("retry-after");
      body = (await response.text()).slice(0, 200);
      break;
    }
    await response.arrayBuffer();
  }
  const envelope = klass.plain ? !body.includes("{") : /"error":"rate_limited"/.test(body);
  const outcome: Outcome = {
    name: klass.name,
    limiter: klass.limiter,
    key: klass.key,
    limit: klass.limit,
    sent,
    refusedAt,
    retryAfter,
    body: refusedAt ? (klass.plain ? "text/plain" : (/"error":"[a-z_]+"/.exec(body)?.[0] ?? "?")) : "",
    // Refused AT its limit, not before: a 429 at request 1 means another class (or anyone at this
    // address) had already spent the bucket — that proves nothing about this class. Two requests of
    // slack: a signed-in class's setup requests share its `u:` budget.
    ok:
      refusedAt !== null &&
      refusedAt >= klass.limit - 2 &&
      retryAfter !== null &&
      Number(retryAfter) > 0 &&
      envelope,
  };
  if (values.recheck && refusedAt !== null && retryAfter) {
    // Honour it: nothing is sent to this class before the wait is over.
    await sleep(Number(retryAfter) * 1000 + 1000);
    const again = await klass.send(sent + 1);
    outcome.recheck = again.status;
    await again.arrayBuffer();
    if (again.status === 429) outcome.ok = false;
  }
  return outcome;
}

async function main() {
  const only = values.only ? new Set(values.only.split(",")) : null;
  let cookie: string | null = null;
  if (values.session) cookie = sessionFromFile(values.session);
  else if (local && (!only || ["api-user", "search", "link-password"].some((name) => only.has(name)))) {
    cookie = await localCookie(addressFor());
  }
  const wanted = (name: string) => !only || only.has(name);
  // Search spends the same `u:<id>` budget as every other request of its user: it needs an
  // account of its own, or it would find the budget api-user has just used up.
  let searchCookie: string | null = null;
  if (values["search-session"]) searchCookie = sessionFromFile(values["search-session"]);
  else if (local && wanted("search")) searchCookie = await localCookie(addressFor());
  const passwordLink = cookie && wanted("link-password") ? await makePasswordLink(cookie) : null;
  // The admin class spends `u:<id>` too: an account of its own, like search.
  let adminCookie: string | null = null;
  if (values["admin-session"]) adminCookie = sessionFromFile(values["admin-session"]);
  else if (local && wanted("admin")) adminCookie = await localCookie(addressFor());
  const results: Outcome[] = [];
  for (const klass of classes(cookie, searchCookie, passwordLink, adminCookie)) {
    if (!wanted(klass.name)) continue;
    if (klass.name === "admin" && !adminCookie) {
      results.push({
        ...klass,
        sent: 0,
        refusedAt: null,
        retryAfter: null,
        body: "",
        ok: true,
        note: "skipped: no --admin-session",
      });
      continue;
    }
    if (klass.name === "search" && !searchCookie) {
      results.push({
        ...klass,
        sent: 0,
        refusedAt: null,
        retryAfter: null,
        body: "",
        ok: true,
        note: "skipped: no --search-session",
      });
      continue;
    }
    if (klass.needsSession && klass.name !== "admin" && !cookie) {
      results.push({
        ...klass,
        sent: 0,
        refusedAt: null,
        retryAfter: null,
        body: "",
        ok: true,
        note: "skipped: no --session",
      });
      continue;
    }
    const started = Date.now();
    const outcome = await probe(klass);
    outcome.note = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    results.push(outcome);
  }
  console.log(
    "class          limiter                                                   key                     limit  sent  429 at  Retry-After  answer                     ok",
  );
  for (const r of results) {
    console.log(
      [
        r.name.padEnd(14),
        r.limiter.slice(0, 57).padEnd(57),
        r.key.padEnd(23),
        String(r.limit).padStart(5),
        String(r.sent).padStart(5),
        String(r.refusedAt ?? "-").padStart(7),
        String(r.retryAfter ?? "-").padStart(12),
        ` ${r.body}`.padEnd(26),
        r.ok ? "ok" : "FAIL",
        r.recheck !== undefined ? `recheck ${r.recheck}` : "",
        r.note ?? "",
      ].join(" "),
    );
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(
      `ratelimit-probe: ${failed.length} class(es) not refused as expected: ${failed.map((r) => r.name).join(", ")}`,
    );
    process.exit(1);
  }
  console.log(
    `ratelimit-probe: every class refused with 429 + Retry-After (${results.filter((r) => r.refusedAt).length} probed)`,
  );
}

main().catch((error: unknown) => {
  console.error(`ratelimit-probe: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
