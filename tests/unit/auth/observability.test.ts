// The auth layer's exits to anything that is kept — Sentry, the metrics dataset, the audit log,
// the console — and what goes through them.
//
// Part 1 is a scan of the sources: no file of the layer reaches a sink directly; they all go
// through src/worker/auth/observe.ts (and the console only through auth/logger.ts). It stands in
// for the ESLint rule requested from the owner of eslint.config.js, and is seen to fail on a
// file that does what it forbids.
//
// Part 2 drives the real router with requests whose URL, headers and body are full of sentinel
// secrets, and with a handler that throws an error made of them, against FAKE sinks — and looks
// for the sentinels in everything the sinks were given.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/worker/app";
import { createAuth } from "../../../src/worker/auth/create-auth";
import {
  count,
  countFor,
  guard,
  record,
  reportError,
  safeMeta,
  safeTag,
  sinkPath,
} from "../../../src/worker/auth/observe";
import * as sentry from "../../../src/worker/sentry";
import * as auditLog from "../../../src/worker/services/audit";
import { AppError } from "../../../src/worker/services/errors";
import * as metrics from "../../../src/worker/services/metrics";
import { CAPTCHA, newClient, ORIGIN, realCore, send, serviceDeps } from "./helpers";

vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn() };
});
vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn(real.metric), writeMetric: vi.fn(real.writeMetric) };
});
vi.mock("../../../src/worker/services/audit", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/audit")>();
  return { ...real, audit: vi.fn(real.audit) };
});

// ── part 1: the source scan ─────────────────────────────────────────────────────────────────

const SOURCES = {
  ...import.meta.glob("../../../src/worker/auth/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob(
    "../../../src/worker/routes/{auth,signup-intent,invites,pending-email,account-lifecycle}.ts",
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  ),
  ...import.meta.glob("../../../src/worker/services/{email,signup-policy,account-state}.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

/** The one file that may name the sinks' modules, and the one that may name `console`. */
const MAY_IMPORT_SINKS = /\/auth\/observe\.ts$/;
const MAY_USE_CONSOLE = /\/auth\/logger\.ts$/;

const DIRECT_SINKS: Array<[what: string, pattern: RegExp]> = [
  ["an import of the Sentry module", /from\s+"(?:[^"]*\/)?sentry"|from\s+"@sentry\//],
  ["an import of the metrics module", /from\s+"(?:\.\.\/services\/|\.\/)metrics"/],
  ["an import of the audit service", /from\s+"(?:\.\.\/services\/audit|\.\/audit)"/],
  [
    "a Sentry call",
    /\b(?:captureError|captureException|captureMessage|addBreadcrumb|setContext|setTag|setTags|setExtra|setExtras|setUser)\s*\(|\bSentry\s*\./,
  ],
  ["a metrics call", /\b(?:writeMetric|writeDataPoint)\s*\(|(?<![A-Za-z.])metric\s*\(/],
  ["an audit-log write", /(?<![A-Za-z.])(?:audit|insertAudit)\s*\(/],
];
const CONSOLE: [string, RegExp] = ["a console call", /\bconsole\s*(?:\.|\[)/];

/** Code only: comment lines and trailing comments say what they like. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s\/\/ .*$/, ""))
    .join("\n");
}

function directSinkUses(path: string, source: string): string[] {
  const code = codeOf(source);
  const found: string[] = [];
  // auth/audit.ts lives beside the files that would import the audit SERVICE as "./audit" only
  // from src/worker/services; inside src/worker/auth "./audit" is this layer's own file.
  const inServices = /\/services\//.test(path);
  if (!MAY_IMPORT_SINKS.test(path)) {
    for (const [what, pattern] of DIRECT_SINKS) {
      if (what === "an import of the audit service" && !inServices) {
        if (/from\s+"\.\.\/services\/audit"/.test(code)) found.push(what);
        continue;
      }
      if (pattern.test(code)) found.push(what);
    }
  }
  if (!MAY_USE_CONSOLE.test(path) && CONSOLE[1].test(code)) found.push(CONSOLE[0]);
  return found;
}

describe("one exit to each sink", () => {
  it("no file of the auth layer reaches Sentry, the metrics, the audit log or the console directly", () => {
    const paths = Object.keys(SOURCES);
    // The scan is looking at the files it is meant to: the layer, not an empty glob.
    expect(paths.length).toBeGreaterThanOrEqual(22);
    for (const name of [
      "auth/hooks.ts",
      "auth/audit.ts",
      "routes/auth.ts",
      "services/email.ts",
      "routes/invites.ts",
    ]) {
      expect(
        paths.some((path) => path.endsWith(name)),
        name,
      ).toBe(true);
    }
    const problems = paths.flatMap((path) =>
      directSinkUses(path, SOURCES[path]!).map((what) => `${path.replace(/^.*\/src\//, "src/")}: ${what}`),
    );
    expect(problems).toEqual([]);
    // The two exempt files do what they are exempt for — the exemption is not dead.
    const observe = paths.find((path) => MAY_IMPORT_SINKS.test(path))!;
    const logger = paths.find((path) => MAY_USE_CONSOLE.test(path))!;
    expect(directSinkUses(observe.replace("observe", "other"), SOURCES[observe]!).length).toBeGreaterThan(0);
    expect(directSinkUses(logger.replace("logger", "other"), SOURCES[logger]!)).toEqual(["a console call"]);
  });

  it("control: a file that calls a sink directly is seen — each kind of call, and not a comment that mentions one", () => {
    const control = (code: string, path = "/src/worker/auth/control.ts") => directSinkUses(path, code);
    expect(control('import { captureError } from "../sentry";\ncaptureError(error, { kind: "x" });')).toEqual(
      ["an import of the Sentry module", "a Sentry call"],
    );
    expect(control('import * as Sentry from "@sentry/cloudflare";\nSentry.captureException(error);')).toEqual(
      ["an import of the Sentry module", "a Sentry call"],
    );
    expect(control("scope.setExtra('body', body);\nSentry.addBreadcrumb({ message: url });")).toEqual([
      "a Sentry call",
    ]);
    expect(
      control('import { metric } from "../services/metrics";\nmetric("auth", { reason: url });'),
    ).toEqual(["an import of the metrics module", "a metrics call"]);
    expect(control('writeMetric(env, "auth", {});')).toEqual(["a metrics call"]);
    expect(control('import { audit } from "../services/audit";\naudit(c, "x", null, { url });')).toEqual([
      "an import of the audit service",
      "an audit-log write",
    ]);
    expect(
      control('import { audit } from "./audit";\naudit(deps, "x", null);', "/src/worker/services/email.ts"),
    ).toEqual(["an import of the audit service", "an audit-log write"]);
    expect(control("console.error(error);")).toEqual(["a console call"]);
    expect(control('console["log"](request.url);')).toEqual(["a console call"]);
    // Not flagged: prose, and the wrapper's own names.
    expect(
      control('// metric("auth", …) and console.error are described here\n/* audit(c) */\nconst x = 1;'),
    ).toEqual([]);
    expect(
      control(
        'import { count, record, reportError } from "./observe";\ncount("auth");\nrecord(c, "x", null);',
      ),
    ).toEqual([]);
  });
});

// ── part 2: sentinels against fake sinks ────────────────────────────────────────────────────

const S = {
  token: "SENTINEL-TOKEN-9f8e7d6c5b4a39281706f5e4",
  state: "SENTINEL-STATE-0a1b2c3d4e5f60718293a4b5",
  code: "SENTINEL-CODE-4/0AX4XfWhN8sQ2mVb7LpR4sW8",
  email: "sentinel.person@mail-example.org",
  password: "SENTINEL-PASSWORD-correct-horse-77",
  cookie: "SENTINEL-COOKIE-kT9xQ2mVb7LpR4sW8yZc3NdF",
  userAgent: "SentinelBrowser/9.9 (X11; SENTINEL-UA-Linux)",
  resetUrl:
    "https://holdfast.example/reset-password/SENTINEL-RESET-Rz4Kq8Wm2Xv6Bn0Lp3Tj7Yc?callbackURL=%2Flogin",
  name: "Sentinel Zebediah Quillfeather",
} as const;

const NEEDLES = [
  "SENTINEL",
  "sentinel.person",
  "mail-example.org",
  "holdfast.example",
  "Zebediah",
  "Quillfeather",
  "SentinelBrowser",
  // Short values, in the query of a relative URL: nothing about their shape gives them away.
  "qZ7x",
  "Zeb9",
];

function serialise(value: unknown, depth = 0): string {
  if (value instanceof Error) {
    const own = Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [key, (value as never)[key]]),
    );
    return `Error(${value.name}: ${value.message} | ${value.stack} | ${depth < 3 ? serialise(own, depth + 1) : ""} | cause=${
      depth < 3 ? serialise(value.cause, depth + 1) : ""
    })`;
  }
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  if (depth > 4) return "";
  try {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}=${serialise(item, depth + 1)}`)
      .join(";");
  } catch {
    return "";
  }
}

/** Everything the four sinks have been given since the last reset, as text. */
function sinks(written: string[]) {
  return {
    sentry: vi.mocked(sentry.captureError).mock.calls.map((args) => serialise(args)),
    // `writeMetric`'s first argument is the env, `audit`'s the request context (which holds the
    // whole request): neither is what was SENT to the sink.
    metrics: [
      ...vi.mocked(metrics.metric).mock.calls.map((args) => serialise(args)),
      ...vi.mocked(metrics.writeMetric).mock.calls.map((args) => serialise(args.slice(1))),
    ],
    audit: vi.mocked(auditLog.audit).mock.calls.map((args) => serialise(args.slice(1))),
    console: written,
  };
}

const leaksIn = (texts: string[]) => NEEDLES.filter((needle) => texts.some((text) => text.includes(needle)));

function captureConsole(): string[] {
  const written: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      written.push(parts.map((part) => serialise(part)).join(" "));
    });
  }
  return written;
}

/** An error made of everything an error can carry. */
function hostileError(): Error {
  const pg = Object.assign(new Error(`duplicate key: Key (email)=(${S.email}) already exists`), {
    code: "23505",
    detail: `Key (email)=(${S.email}) already exists.`,
    parameters: [S.email, S.name, S.password],
  });
  return Object.assign(
    new Error(
      `Failed query for ${S.email} at ${S.resetUrl} with ${S.token} via /api/auth/callback/google?state=qZ7x&n=Zeb9\nparams: ${S.name},${S.password}`,
      {
        cause: pg,
      },
    ),
    {
      response: { url: S.resetUrl, headers: { "set-cookie": S.cookie }, body: { token: S.token } },
      request: {
        url: `${S.resetUrl}&token=${S.token}`,
        headers: { cookie: S.cookie, "user-agent": S.userAgent },
      },
      config: { url: S.resetUrl, auth: S.password },
    },
  );
}

const hostileHeaders = {
  "user-agent": S.userAgent,
  cookie: `hf.session_token=${S.cookie}; hf_intent=${S.cookie}`,
  authorization: `Bearer ${S.token}`,
  referer: S.resetUrl,
  "x-forwarded-for": "203.0.113.77",
};

describe("sentinel secrets in a request never reach a sink", () => {
  let written: string[] = [];
  beforeEach(() => {
    vi.mocked(sentry.captureError).mockClear();
    vi.mocked(metrics.metric).mockClear();
    vi.mocked(metrics.writeMetric).mockClear();
    vi.mocked(auditLog.audit).mockClear();
    written = captureConsole();
  });
  afterEach(() => vi.restoreAllMocks());

  const expectClean = () => {
    const seen = sinks(written);
    for (const [sink, texts] of Object.entries(seen))
      expect(leaksIn(texts), `${sink}: ${texts.join(" ¦ ")}`).toEqual([]);
    return seen;
  };

  it("in the URL: verification, reset, delete-callback and OAuth-callback links with their tokens, code and state", async () => {
    const paths = [
      `/api/auth/verify-email?token=${S.token}&callbackURL=${encodeURIComponent(S.resetUrl)}`,
      `/api/auth/reset-password/${S.token}?callbackURL=%2Freset-password`,
      `/api/auth/delete-user/callback?token=${S.token}&callbackURL=%2F`,
      `/api/auth/callback/google?code=${encodeURIComponent(S.code)}&state=${S.state}`,
      `/api/auth/callback/google?error=access_denied&error_description=${encodeURIComponent(`${S.email} ${S.name}`)}&state=${S.state}`,
      `/api/auth/get-session?${S.token}=${S.email}`,
    ];
    for (const path of paths) {
      const sent = await send(newClient({ headers: hostileHeaders }), path);
      expect(sent.status, path).toBeLessThan(500);
    }
    const seen = expectClean();
    // The sinks were really written to (an empty capture would pass for the wrong reason).
    expect(seen.metrics.length).toBeGreaterThan(0);
  });

  it("in the body and the headers: sign-in, sign-up, reset, and a refused admin-plugin path", async () => {
    const hostile = () => newClient({ headers: hostileHeaders });
    // Refused by Better Auth's origin check (a callback URL on another origin) …
    await send(hostile(), "/api/auth/sign-in/email", {
      json: { email: S.email, password: S.password, callbackURL: S.resetUrl },
      headers: CAPTCHA,
    });
    // … and one that reaches the password check.
    const wrong = await send(hostile(), "/api/auth/sign-in/email", {
      json: { email: S.email, password: S.password },
      headers: CAPTCHA,
    });
    expect(wrong.status).toBe(401);
    await send(hostile(), "/api/auth/sign-up/email", {
      json: {
        email: S.email,
        password: S.password,
        name: S.name,
        inviteCode: S.token,
        birthYear: 1990,
        birthMonth: 5,
        acceptTerms: true,
      },
      headers: CAPTCHA,
    });
    await send(hostile(), "/api/auth/request-password-reset", {
      json: { email: S.email, redirectTo: S.resetUrl },
      headers: CAPTCHA,
    });
    await send(hostile(), "/api/auth/reset-password", { json: { token: S.token, newPassword: S.password } });
    await send(hostile(), "/api/auth/two-factor/verify-totp", {
      json: { code: "492817", trustDevice: true },
    });
    const denied = await send(
      hostile(),
      `/api/auth/admin/${S.token}/${S.email}?token=${S.token}&state=${S.state}`,
      {
        json: { password: S.password },
      },
    );
    expect(denied.status).toBe(403);
    await send(hostile(), "/api/auth-intent", {
      json: { inviteCode: S.token, birthYear: 1990, birthMonth: 5, acceptTerms: true },
    });
    await send(hostile(), "/api/account/pending-email", { method: "PATCH", json: { email: S.email } });
    const seen = expectClean();
    // The audit sink saw the failed sign-in and the refused admin call — as codes and a scanned path.
    expect(
      seen.audit.some((row) => row.includes("auth.failed") && row.includes("INVALID_EMAIL_OR_PASSWORD")),
    ).toBe(true);
    const adminRow = seen.audit.find((row) => row.includes("auth.admin_endpoint_denied"))!;
    expect(adminRow).toContain("/admin/[token]/[email]");
    expect(adminRow).not.toMatch(/\?|state=|token=/);
  });

  it("in an error thrown inside the handler — its message, cause, response, request and config", async () => {
    const app = createApp({
      ...realCore,
      createAuth: (authEnv, db, authCtx) => {
        const real = createAuth(authEnv, db, authCtx);
        return {
          api: real.api,
          handler: async () => {
            throw hostileError();
          },
        };
      },
    });
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/auth/verify-email?token=${S.token}&state=${S.state}`, {
        headers: { ...hostileHeaders, "cf-connecting-ip": "198.51.100.23" },
      }),
      { ...env, APP_ORIGIN: ORIGIN } as unknown as Env,
      {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException() {},
        props: {},
      } as never,
    );
    while (pending.length) await Promise.allSettled(pending.splice(0));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(leaksIn([body])).toEqual([]);
    expect(JSON.parse(body)).toMatchObject({ error: "internal" });
    const seen = expectClean();
    // Reported once, by the router, as class + code-less message cut at the parameter list.
    expect(vi.mocked(sentry.captureError).mock.calls).toHaveLength(1);
    const [reported, tags] = vi.mocked(sentry.captureError).mock.calls[0]!;
    expect(tags).toEqual({ kind: "auth_handler" });
    expect((reported as Error).message).toBe(
      "Failed query for [email] at [url] with [token] via /api/auth/callback/google?[query]\nparams: [dropped]",
    );
    expect(Object.keys(reported as Error)).toEqual([]);
    expect((reported as Error).cause).toBeUndefined();
    expect(seen.metrics.some((row) => row.includes("outcome=error"))).toBe(true);
  });

  it("in an error thrown by one of our own routes: guard reports a copy and answers; an AppError passes untouched", async () => {
    const context = {
      get: () => "req_1",
      json: (body: unknown, status: number) => Response.json(body, { status }),
    };
    const failing = guard("control", () => {
      throw hostileError();
    });
    const answered = await failing(context as never);
    expect(answered.status).toBe(500);
    expect(leaksIn([await answered.text()])).toEqual([]);
    expect(vi.mocked(sentry.captureError).mock.calls).toHaveLength(1);
    expectClean();
    const refusing = guard("control", () => {
      throw new AppError("forbidden");
    });
    await expect(refusing(context as never)).rejects.toBeInstanceOf(AppError);
    expect(vi.mocked(sentry.captureError).mock.calls).toHaveLength(1);
  });

  it("the wrapper itself: tags, audit meta and paths are reduced whatever a caller passes", () => {
    reportError(hostileError(), { kind: S.email, route: `/x?token=${S.token}`, ok: "auth_hook_ban" });
    const { deps } = serviceDeps();
    record(
      deps,
      "test.observe",
      { type: "user", id: "u".repeat(32) },
      {
        reason: `banned ${S.email} via ${S.resetUrl}`,
        nested: { email: S.email },
        list: [S.token],
        count: 3,
        ok: true,
      },
    );
    count("auth", { outcome: "failed", kind: S.token, reason: `${S.email} ${S.resetUrl}` });
    countFor(env, "email", { outcome: S.name, kind: "verification" });
    const seen = expectClean();
    expect(seen.metrics).toEqual(
      expect.arrayContaining([
        "0=auth;1=outcome=failed;kind=other;reason=other",
        "0=email;1=outcome=other;kind=verification",
      ]),
    );
    expect(vi.mocked(sentry.captureError).mock.calls[0]![1]).toEqual({
      kind: "other",
      route: "other",
      ok: "auth_hook_ban",
    });
    expect(safeMeta({ reason: `x ${S.email}`, nested: { a: 1 }, n: 2, b: false, z: null })).toEqual({
      reason: "x [email]",
      n: 2,
      b: false,
      z: null,
    });
    expect(safeTag("INVALID_EMAIL_OR_PASSWORD")).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(safeTag("/callback/:id")).toBe("other");
    expect(safeTag(429)).toBe("429");
    expect(safeTag(S.token)).toBe("other");
    // A path for a sink: no query at all, token segments and addresses replaced.
    expect(
      sinkPath(
        `https://h.example/api/auth/reset-password/${S.token}?token=${S.token}&state=${S.state}#${S.email}`,
      ),
    ).toBe("/api/auth/reset-password/[redacted]");
    expect(sinkPath(`/api/auth/admin/${S.email}/x?code=${S.code}`)).toBe("/api/auth/admin/[email]/x");
  });
});
