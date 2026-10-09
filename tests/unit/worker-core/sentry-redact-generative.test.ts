// A generative proof of src/shared/sentry-redact.ts: thousands of events built by a seeded
// generator (deterministic — the seed is in the test name and in every failure message), each
// with recognisable secrets planted in every string position, under hostile keys, in encoded
// forms, beside values that are not data. For each event:
//
//   total        redaction does not throw, and its output can be serialised
//   clean        no planted secret is in the output — as written, or after decoding it again
//   idempotent   redacting the output changes nothing
//   fail-closed  an event past the bounds becomes the fixed marker, and the failure is counted;
//                an event within them never does
//
// Every secret carries the marker S3NT1NEL inside a part of it that HAS a shape or a name (a
// long random run, an address, a URL's query or userinfo, a token-bearing path, a cookie, a
// value under a sensitive name). A shapeless, nameless word is outside what any scan can do and
// is not planted (see the module's header).
import { describe, expect, it } from "vitest";
import {
  REDACTION_FAILED,
  redactBreadcrumb,
  redactEvent,
  redactText,
  redactValue,
  UNSCANNABLE,
} from "../../../src/shared/sentry-redact";

const MARK = "S3NT1NEL";

// ── a seeded generator ──────────────────────────────────────────────────────────────────────
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const chance = (p: number) => next() < p;
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const chars = (length: number, alphabet = ALNUM) =>
    Array.from({ length }, () => alphabet[int(alphabet.length)]).join("");
  return { next, int, pick, chance, chars };
}
type Rng = ReturnType<typeof prng>;

// ── secrets ─────────────────────────────────────────────────────────────────────────────────
type Secret = { text: string; url: boolean };

const SECRETS: Array<(r: Rng) => Secret> = [
  // Token-shaped strings.
  (r) => ({ text: `${MARK}${r.chars(20 + r.int(20))}7q`, url: false }),
  (r) => ({ text: `eyJ${r.chars(12)}.${MARK}${r.chars(16)}.${r.chars(10)}`, url: false }),
  (r) => ({ text: `${r.chars(8)}_${MARK}-${r.chars(12)}=`, url: false }),
  // Addresses.
  (r) => ({
    text: `${MARK.toLowerCase()}.${r.chars(5).toLowerCase()}@mail-${r.int(99)}.example`,
    url: false,
  }),
  // Links: the secret is in the query, the fragment, the userinfo or after a token-bearing prefix.
  (r) => ({
    text: `https://app.example/api/auth/verify-email?token=${MARK}${r.chars(6)}&callbackURL=%2F`,
    url: true,
  }),
  (r) => ({
    text: `https://app.example/api/auth/callback/google?code=${MARK}c${r.chars(3)}&state=${MARK}s${r.chars(3)}&scope=email`,
    url: true,
  }),
  (r) => ({
    text: `https://app.example/api/auth/reset-password/${MARK}${r.chars(4)}?callbackURL=/x`,
    url: true,
  }),
  (r) => ({ text: `https://files.example/d/0199c6f0/${MARK}${r.chars(3)}`, url: true }),
  (r) => ({ text: `https://someone:${MARK}pw${r.chars(2)}@app.example/account`, url: true }),
  (r) => ({ text: `https://app.example/login#access_token=${MARK}${r.chars(5)}`, url: true }),
  (r) => ({ text: `//cdn.example/x?sig=${MARK}${r.chars(4)}`, url: true }),
  (r) => ({ text: `app.example/cb?name=${MARK}${r.chars(3)}&x=1`, url: true }),
  (r) => ({ text: `localhost:5173/api/auth/verify-email?t=${MARK}${r.chars(3)}`, url: true }),
  () => ({ text: `/login?error=denied&error_description=${MARK}+is+not+allowed&state=${MARK}x`, url: true }),
  (r) => ({ text: `/s/${MARK}${r.chars(3)}`, url: true }),
  (r) => ({ text: `/invite/${MARK}-${r.chars(4)}`, url: true }),
  // Cookies and credentials.
  (r) => ({ text: `Cookie: sid=${MARK}${r.chars(4)}; theme=dark`, url: false }),
  () => ({ text: `set-cookie: a=${MARK}; Path=/; HttpOnly`, url: false }),
  (r) => ({ text: `hf.session_token=${MARK}${r.chars(6)}.${MARK}sig`, url: false }),
  (r) => ({ text: `__Secure-hf.session_token=${r.chars(6)}.${MARK}`, url: false }),
  (r) => ({ text: `Authorization: Bearer ${MARK}${r.chars(4)}`, url: false }),
  (r) => ({ text: `Bearer ${MARK}${r.chars(4)}`, url: false }),
  // Passwords: a value has no shape, so it is planted under a name.
  (r) => ({ text: `password=${MARK}pw${r.chars(2)}!`, url: false }),
  (r) => ({ text: `"password":"${MARK} with spaces ${r.chars(3)}"`, url: false }),
  (r) => ({ text: `new_password='${MARK} ${r.chars(3)}'`, url: false }),
  (r) => ({ text: `Pass-Word: ${MARK}${r.chars(3)}`, url: false }),
  (r) => ({ text: `client_secret=${MARK}${r.chars(3)}`, url: false }),
  () => ({ text: `ACCESS_TOKEN=${MARK}`, url: false }),
  (r) => ({ text: `x-api-key: ${MARK}${r.chars(2)}`, url: false }),
  (r) => ({ text: `code=${MARK.toLowerCase()}${r.chars(3)}`, url: false }),
];

// ── encodings ───────────────────────────────────────────────────────────────────────────────
const percent = (text: string) => encodeURIComponent(text);
const percentAll = (text: string) =>
  Array.from(new TextEncoder().encode(text), (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
const entities = (text: string) =>
  text.replace(/[&/:?=@#]/g, (char) =>
    char === "&" ? "&amp;" : char === "/" ? "&#x2F;" : char === ":" ? "&colon;" : `&#${char.charCodeAt(0)};`,
  );
const jsonEscaped = (text: string) =>
  text.replace(/\//g, "\\/").replace(/[=?@]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
const unicodeAll = (text: string) =>
  Array.from(text, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const mixedScheme = (text: string) => text.replace(/^https:/, "HtTpS:");

const ENCODINGS: Array<{ name: string; apply: (s: Secret, r: Rng) => string }> = [
  { name: "plain", apply: (s) => s.text },
  { name: "plain", apply: (s) => s.text },
  { name: "percent", apply: (s) => percent(s.text) },
  { name: "percent twice", apply: (s) => percent(percent(s.text)) },
  { name: "percent every byte", apply: (s) => percentAll(s.text) },
  { name: "entities", apply: (s) => entities(s.text) },
  { name: "entities over percent", apply: (s) => entities(percent(s.text)) },
  { name: "json escapes", apply: (s) => jsonEscaped(s.text) },
  { name: "unicode escapes", apply: (s) => unicodeAll(s.text) },
  { name: "mixed-case scheme", apply: (s) => mixedScheme(s.text) },
];

// ── where a secret sits inside a string ─────────────────────────────────────────────────────
const EMBEDDINGS: Array<(planted: string, s: Secret, r: Rng) => string> = [
  (p) => p,
  (p) => p,
  (p) => `could not finish: ${p} (try again)`,
  (p) => `${p}.`,
  (p) => `see <${p}>, then retry`,
  (p) => `[auth] refused "${p}"`,
  (p) => `{"note":"x","value":"${p}","n":1}`,
  (p) =>
    `Error: request failed — ${p}\n    at handler (file:///worker/index.js:10:5)\n    at run (file:///worker/index.js:20:9)`,
  // A URL inside another URL's query, and a secret as a query value.
  (p) => `/somewhere?next=${encodeURIComponent(p)}&x=1`,
  (p) => `https://app.example/redirect?to=${encodeURIComponent(p)}#top`,
  // Line-oriented secrets (a header) keep their own line.
  (p, _s, r) => `${r.pick(["GET", "POST"])} /api/nodes 500\n${p}\nrequest id 7`,
];

function plant(r: Rng): string {
  const secret = r.pick(SECRETS)(r);
  const encoded = r.pick(ENCODINGS).apply(secret, r);
  return r.pick(EMBEDDINGS)(encoded, secret, r);
}

const BENIGN = [
  "ok",
  "INVALID_EMAIL_OR_PASSWORD",
  "Something went wrong.",
  "/api/nodes/folder",
  "GET /api/health 200",
  "select 1",
  "",
  "unhandled",
  "https://holdfast.example/login",
];

// ── hostile structure ───────────────────────────────────────────────────────────────────────
const HOSTILE_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "toJSON",
  "0",
  "42",
  "-1",
  "length",
  "then",
];
const SENSITIVE_KEYS = [
  "password",
  "Pass-Word",
  "NEW_PASSWORD",
  "access_token",
  "ACCESS-TOKEN",
  "x-api-key",
  "clientSecret",
  "Set-Cookie",
  "AUTHORIZATION",
  "cookies",
  "id.token",
  "signature",
];
const PLAIN_KEYS = [
  "message",
  "note",
  "detail",
  "url",
  "value",
  "data",
  "items",
  "meta",
  "where",
  "kind",
  "to",
  "from",
];

/** Sets an OWN property — also for `__proto__`, which assignment would turn into the prototype. */
function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

type Shape = { hostileValues: boolean };

function leaf(r: Rng, shape: Shape): unknown {
  const roll = r.next();
  if (roll < 0.55) return plant(r);
  if (roll < 0.75) return r.pick(BENIGN);
  if (roll < 0.8) return r.int(100000);
  if (roll < 0.83) return r.chance(0.5);
  if (roll < 0.85) return null;
  if (!shape.hostileValues) return plant(r);
  // Things that are not data. Each holds a secret that must not come out.
  const secret = plant(r);
  return r.pick<() => unknown>([
    () => Object.assign(new Error(secret), { detail: secret, cause: new Error(secret) }),
    () => new Map([[secret, secret]]),
    () => new Set([secret]),
    () => new Date(0),
    () => new Uint8Array(new TextEncoder().encode(secret)),
    () => new URL(`https://app.example/x?t=${MARK}`),
    () => new Headers({ cookie: `a=${MARK}` }),
    () =>
      new (class Custom {
        secret = secret;
        toJSON() {
          return secret;
        }
        toString() {
          return secret;
        }
      })(),
    () => () => secret,
    () => Symbol(secret),
    () => 12345678901234567890n,
    () => Number.NaN,
    () => undefined,
  ])();
}

function node(r: Rng, depth: number, shape: Shape): unknown {
  if (depth <= 0 || r.chance(0.3)) return leaf(r, shape);
  if (r.chance(0.3)) return Array.from({ length: 1 + r.int(4) }, () => node(r, depth - 1, shape));
  const out: Record<string, unknown> = {};
  const count = 1 + r.int(5);
  for (let i = 0; i < count; i++) {
    const roll = r.next();
    if (roll < 0.5)
      setOwn(out, r.pick(PLAIN_KEYS) + (r.chance(0.3) ? String(i) : ""), node(r, depth - 1, shape));
    else if (roll < 0.68) setOwn(out, r.pick(HOSTILE_KEYS), node(r, depth - 1, shape));
    else if (roll < 0.8) setOwn(out, r.pick(SENSITIVE_KEYS), node(r, depth - 1, shape));
    // A key that is itself a secret, and a very long key with one inside.
    else if (roll < 0.9) setOwn(out, plant(r), node(r, depth - 1, shape));
    else setOwn(out, `${"k".repeat(200 + r.int(200))}${plant(r)}`, node(r, depth - 1, shape));
  }
  if (shape.hostileValues) {
    if (r.chance(0.15)) {
      Object.defineProperty(out, "trap", {
        enumerable: true,
        get() {
          throw new Error(`getter ran: ${MARK}`);
        },
      });
    }
    if (r.chance(0.15)) setOwn(out, "toJSON", () => `toJSON ran: ${MARK}`);
    if (r.chance(0.1)) setOwn(out, "self", out);
    if (r.chance(0.05)) Object.defineProperty(out, Symbol(MARK), { value: MARK, enumerable: true });
  }
  return out;
}

/** An event with generated content in every string-bearing field the SDK has. */
function event(r: Rng, shape: Shape): Record<string, unknown> {
  const deep = () => node(r, 4, shape);
  const out: Record<string, unknown> = eventFields(r, deep);
  // Hostile keys at the ROOT too, where a key is the whole of a lookup path.
  for (const key of HOSTILE_KEYS) if (r.chance(0.25)) setOwn(out, key, r.chance(0.7) ? plant(r) : deep());
  return out;
}

function eventFields(r: Rng, deep: () => unknown): Record<string, unknown> {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
    environment: "dev",
    message: plant(r),
    logentry: { message: plant(r), params: [plant(r), deep()] },
    transaction: `GET ${plant(r)}`,
    fingerprint: ["{{ default }}", plant(r)],
    exception: {
      values: [
        {
          type: "Error",
          value: plant(r),
          stacktrace: {
            frames: [
              {
                filename: plant(r),
                abs_path: plant(r),
                function: plant(r),
                module: plant(r),
                context_line: plant(r),
                pre_context: [plant(r)],
                vars: deep(),
              },
            ],
          },
        },
      ],
    },
    request: {
      url: plant(r),
      method: "POST",
      query_string: plant(r),
      headers: {
        cookie: plant(r),
        referer: plant(r),
        "x-forwarded-for": plant(r),
        "user-agent": plant(r),
        other: plant(r),
      },
      cookies: deep(),
      data: deep(),
    },
    breadcrumbs: [
      { category: "fetch", data: { url: plant(r), "url.query": plant(r), method: "GET" } },
      { category: "console", message: plant(r), data: { arguments: [plant(r), deep()] } },
    ],
    tags: { route: plant(r), requestId: plant(r), kind: plant(r) },
    extra: deep(),
    contexts: { trace: { trace_id: plant(r), span_id: plant(r) }, app: deep() },
    user: { id: plant(r), email: plant(r), username: plant(r), ip_address: plant(r) },
  };
}

// ── an independent decoder for the check (not the module's own) ─────────────────────────────
function decodeForCheck(text: string): string {
  let current = text;
  for (let round = 0; round < 8; round++) {
    const next = current
      .replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, (_, hex: string) =>
        String.fromCodePoint(parseInt(hex, 16) % 0x110000),
      )
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16) % 0x110000))
      .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec) % 0x110000))
      .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\(.)/g, "$1");
    if (next === current) break;
    current = next;
  }
  return current;
}

function leak(output: unknown): string | null {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  for (const candidate of [text, decodeForCheck(text)]) {
    const at = candidate.toLowerCase().indexOf(MARK.toLowerCase());
    if (at !== -1) return candidate.slice(Math.max(0, at - 260), at + 80);
  }
  return null;
}

const SEED = 20261009;

describe(`generated events (seed ${SEED})`, () => {
  it("6,000 events with secrets in every string position, under hostile keys, in encoded forms: total, clean, idempotent, never the marker", () => {
    const r = prng(SEED);
    let strings = 0;
    for (let index = 0; index < 6000; index++) {
      const shape: Shape = { hostileValues: index % 3 === 0 };
      const input = event(r, shape);
      const counted: string[] = [];
      let out: unknown;
      expect(() => {
        out = redactEvent(input, (kind) => counted.push(kind));
      }, `event ${index}: threw`).not.toThrow();
      let serialised = "";
      expect(() => {
        serialised = JSON.stringify(out);
      }, `event ${index}: output cannot be serialised`).not.toThrow();
      strings += serialised.length;
      expect(leak(out), `event ${index}: a secret survived`).toBeNull();
      // Within the bounds: redacted, not replaced by the marker — a hostile KEY must not be able
      // to make redaction fail (and with it, make the event's content disappear).
      expect(counted, `event ${index}: counted as a failure`).toEqual([]);
      expect((out as { message?: unknown }).message, `event ${index}`).not.toBe(REDACTION_FAILED);
      expect(redactEvent(out), `event ${index}: not idempotent`).toEqual(out);
    }
    expect(strings).toBeGreaterThan(1_000_000);
  }, 180_000);

  it("20,000 strings: no secret survives, and redacting twice equals redacting once", () => {
    const r = prng(SEED + 1);
    const failures: string[] = [];
    for (let index = 0; index < 20_000 && failures.length < 12; index++) {
      const input = r.chance(0.7) ? plant(r) : `${plant(r)} ${r.pick(BENIGN)} ${plant(r)}`;
      const once = redactText(input);
      const found = leak(once);
      if (found !== null)
        failures.push(
          `string ${index} LEAK\n  in : ${JSON.stringify(input)}\n  out: ${JSON.stringify(once)}`,
        );
      else if (redactText(once) !== once)
        failures.push(
          `string ${index} NOT IDEMPOTENT\n  in : ${JSON.stringify(input)}\n  1st: ${JSON.stringify(once)}\n  2nd: ${JSON.stringify(redactText(once))}`,
        );
    }
    expect(failures.join("\n"), "see the list").toBe("");
  }, 120_000);

  it("1,000 events past a bound: every one is the marker event, counted once, with nothing of the payload", () => {
    const r = prng(SEED + 2);
    const marker = {
      message: REDACTION_FAILED,
      level: "error",
      release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
      environment: "dev",
    };
    const oversize: Array<(base: Record<string, unknown>) => void> = [
      (base) => {
        let deep: unknown = plant(r);
        for (let i = 0; i < 20 + r.int(30); i++) deep = { next: deep };
        setOwn(base, "extra", { deep });
      },
      (base) =>
        setOwn(
          base,
          "extra",
          Object.fromEntries(Array.from({ length: 501 + r.int(500) }, (_, i) => [`k${i}`, plant(r)])),
        ),
      (base) =>
        setOwn(
          base,
          "breadcrumbs",
          Array.from({ length: 501 + r.int(500) }, () => ({ message: plant(r) })),
        ),
      (base) =>
        setOwn(base, "extra", {
          grid: Array.from({ length: 300 }, () => Array.from({ length: 100 }, () => MARK)),
        }),
    ];
    for (let index = 0; index < 1000; index++) {
      const input = event(r, { hostileValues: index % 2 === 0 });
      r.pick(oversize)(input);
      const counted: string[] = [];
      const out = redactEvent(input, (kind) => counted.push(kind));
      // `tags.requestId` in these events is a planted secret, not a UUID: the marker leaves it out.
      expect(out, `event ${index}`).toEqual(marker);
      expect(counted, `event ${index}`).toEqual(["event"]);
      // The same payload as a breadcrumb: dropped, and counted.
      const crumbCounted: string[] = [];
      expect(
        redactBreadcrumb(input, (kind) => crumbCounted.push(kind)),
        `breadcrumb ${index}`,
      ).toBeNull();
      expect(crumbCounted).toEqual(["breadcrumb"]);
      // And the function underneath says why: it throws rather than returning a part.
      expect(() => redactValue(input)).toThrow();
    }
  }, 120_000);

  it("oversize and hostile strings: bounded, total, and a string nested too deep in encodings is not guessed at", () => {
    const r = prng(SEED + 3);
    const started = Date.now();
    const hostile = [
      "a".repeat(200_000),
      `${"/".repeat(50_000)}${MARK}`,
      "x@".repeat(50_000),
      `${"a.b%c+d-".repeat(20_000)}`,
      "%".repeat(100_000),
      "&".repeat(100_000),
      "\\".repeat(100_000),
      `${"%25".repeat(2000)}41`,
      `password=${"=".repeat(50_000)}${MARK}`,
      `https://${"a.".repeat(30_000)}example/x?t=${MARK}`,
      `${"(".repeat(50_000)}${plant(r)}${")".repeat(50_000)}`,
      "\u0000￿\ud800 lone surrogates \udfff",
      `${plant(r)}\u0000${plant(r)}`,
    ];
    for (const input of hostile) {
      let once = "";
      expect(() => {
        once = redactText(input);
      }).not.toThrow();
      expect(once.length).toBeLessThanOrEqual(1001);
      expect(leak(once), JSON.stringify(input.slice(0, 60))).toBeNull();
      expect(redactText(once)).toBe(once);
    }
    // Seven layers of percent-encoding around a link: past the decoding bound, so no part of it is kept.
    let nested = `https://app.example/cb?code=${MARK}`;
    for (let i = 0; i < 7; i++) nested = encodeURIComponent(nested);
    expect(redactText(nested)).toBe(UNSCANNABLE);
    expect(redactText(UNSCANNABLE)).toBe(UNSCANNABLE);
    // Five layers are within it.
    let five = `https://app.example/cb?code=${MARK}`;
    for (let i = 0; i < 4; i++) five = encodeURIComponent(five);
    expect(redactText(five)).toBe("https://app.example/cb");
    expect(Date.now() - started, "the scan is not quadratic in a hostile string").toBeLessThan(5000);
  });
});

// ── the findings so far, each as its own case ───────────────────────────────────────────────
describe("regressions: one case per finding", () => {
  const TOKEN = `${MARK}tok3nAbCdEfGhIjKlMnOpQrStUvWx`;

  it("redaction order: the same secret in every copy the SDK makes is gone from all of them", () => {
    const message = `fetch https://app.example/api/auth/callback/google?code=${MARK}&state=${MARK} failed`;
    const out = redactEvent({
      message,
      transaction: `GET https://app.example/api/auth/callback/google?code=${MARK}`,
      exception: { values: [{ type: "Error", value: message }] },
      request: {
        url: `https://app.example/api/auth/callback/google?code=${MARK}`,
        query_string: `code=${MARK}`,
      },
      breadcrumbs: [
        { category: "fetch", data: { url: `https://app.example/api/auth/callback/google?code=${MARK}` } },
      ],
      tags: { where: message },
      extra: { copy: message },
    });
    expect(leak(out)).toBeNull();
  });

  it("a URL inside a URL's query — once and twice encoded — goes with the query", () => {
    const inner = `https://app.example/api/auth/verify-email?token=${TOKEN}`;
    for (const outer of [
      `/login?next=${encodeURIComponent(inner)}`,
      `/login?next=${encodeURIComponent(encodeURIComponent(inner))}`,
      `https://app.example/redirect?to=${encodeURIComponent(inner)}&x=1`,
    ]) {
      expect(leak(redactText(outer)), outer).toBeNull();
      expect(leak(redactEvent({ request: { url: outer }, message: `went to ${outer}` }))).toBeNull();
    }
    expect(redactText(`/login?next=${encodeURIComponent(inner)}`)).toBe("/login");
  });

  it("the route and request-id tags are scanned like any string: only a real request id is kept as it is", () => {
    const out = redactEvent({
      tags: {
        route: `/api/auth/reset-password/${TOKEN}`,
        requestId: TOKEN,
        kind: `https://app.example/x?token=${TOKEN}`,
      },
    }) as { tags: Record<string, string> };
    expect(leak(out)).toBeNull();
    expect(out.tags.route).toBe("/api/auth/reset-password/[redacted]");
    const kept = redactEvent({
      tags: { requestId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e", route: "/api/nodes/:id" },
    });
    expect(kept).toEqual({
      tags: { requestId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e", route: "/api/nodes/:id" },
    });
    // The same name anywhere else is not a request id.
    expect(
      leak(redactEvent({ extra: { requestId: TOKEN }, request: { data: { requestId: TOKEN } } })),
    ).toBeNull();
  });

  it("prototype keys: an event with `constructor`, `__proto__`, `toString`… as keys is redacted, not failed", () => {
    for (const key of [
      "constructor",
      "__proto__",
      "prototype",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "release",
    ]) {
      // At the root (where a key IS a lookup path), nested, and as the only key.
      const root: Record<string, unknown> = {};
      setOwn(root, key, `secret ${TOKEN}`);
      setOwn(root, "tags", {});
      setOwn(root.tags as object, key, TOKEN);
      const nested: Record<string, unknown> = {};
      setOwn(nested, key, { deeper: TOKEN });
      setOwn(root, "contexts", { trace: nested });
      const counted: string[] = [];
      const out = redactEvent(root, (kind) => counted.push(kind)) as Record<string, unknown>;
      expect(counted, key).toEqual([]);
      expect(out.message, key).not.toBe(REDACTION_FAILED);
      expect(Object.keys(out).sort(), key).toEqual([key, "contexts", "tags"].sort());
      expect(Object.getPrototypeOf(out), `${key}: the output's prototype is untouched`).toBe(
        Object.prototype,
      );
      expect(leak(out), key).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("one parser: a link reads the same in a URL field, in a sentence, in a tag and under any key", () => {
    for (const link of [
      `https://User:${MARK}@App.Example:8443/a/b/${TOKEN}/c?x=1#frag`,
      `/api/auth/reset-password/${MARK}abc?callbackURL=/x`,
      `//cdn.example/assets/app.js?v=${MARK}`,
      `https://app.example/s/${MARK}`,
    ]) {
      const reduced = redactText(link);
      const out = redactEvent({
        request: { url: link },
        breadcrumbs: [{ data: { url: link, to: link, from: link } }],
        exception: { values: [{ stacktrace: { frames: [{ filename: link, abs_path: link }] } }] },
        tags: { where: link },
        extra: { anything: link },
        message: link,
      }) as unknown as Record<string, unknown>;
      const seen = [
        (out.request as { url: string }).url,
        ...Object.values((out.breadcrumbs as Array<{ data: Record<string, string> }>)[0]!.data),
        ...Object.values(
          (out.exception as { values: Array<{ stacktrace: { frames: Array<Record<string, string>> } }> })
            .values[0]!.stacktrace.frames[0]!,
        ),
        (out.tags as { where: string }).where,
        (out.extra as { anything: string }).anything,
        out.message as string,
      ];
      expect(new Set(seen), link).toEqual(new Set([reduced]));
      // And in a sentence the link is reduced to the same thing, with the sentence around it.
      expect(redactText(`failed at ${link} today`)).toBe(`failed at ${reduced} today`);
      expect(leak(reduced)).toBeNull();
    }
    expect(redactText(`https://User:pw@App.Example:8443/a/b?x=1#frag`)).toBe("https://app.example:8443/a/b");
  });

  it("nothing of a value that is not data is run or read: getters, toJSON, toString, constructor.name", () => {
    const ran: string[] = [];
    const sly = {};
    Object.defineProperty(sly, "trap", {
      enumerable: true,
      get() {
        ran.push("getter");
        throw new Error(MARK);
      },
    });
    setOwn(sly, "toJSON", () => {
      ran.push("toJSON");
      return MARK;
    });
    class Named {
      get [Symbol.toStringTag]() {
        ran.push("toStringTag");
        return MARK;
      }
      toString() {
        ran.push("toString");
        return MARK;
      }
      toJSON() {
        ran.push("toJSON");
        return MARK;
      }
    }
    Object.defineProperty(Named, "name", { get: () => (ran.push("constructor.name"), MARK) });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          ran.push("proxy");
          throw new Error(MARK);
        },
      },
    );
    const counted: string[] = [];
    const out = redactEvent({ extra: { sly, named: new Named(), list: [new Named()] } }, (kind) =>
      counted.push(kind),
    );
    expect(ran).toEqual([]);
    expect(counted).toEqual([]);
    expect(out).toEqual({ extra: { sly: { trap: "[getter]" }, named: "[object]", list: ["[object]"] } });
    // A proxy whose traps throw makes the walk throw: that is a failure, and it fails closed.
    const failed = redactEvent({ extra: { proxy, note: MARK } }, (kind) => counted.push(kind));
    expect(failed).toEqual({ message: REDACTION_FAILED, level: "error" });
    expect(counted).toEqual(["event"]);
  });
});
