// ONE reading of the request line (src/worker/middleware/canonical.ts): a path that is not in
// canonical form never reaches a gate, a limiter, a router or the auth handler — on either host —
// and every layer reads the path and the method through one accessor.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AUTH_ENDPOINTS } from "../../../src/worker/auth/endpoint-policy";
import { createFilesHost } from "../../../src/worker/files-host";
import {
  canonicalMethod,
  canonicalPath,
  existsOnAppHost,
  MAX_PATH_CHARS,
  requestMethod,
  requestPath,
} from "../../../src/worker/middleware/canonical";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { appWith, call, fakeCore, sameOrigin, type CallOptions } from "./helpers";

const at = (path: string) => `http://localhost${path}`;

/** Spellings of `path` that are not canonical. (`new Request` folds `..` and `\`: see the string cases.) */
function variants(path: string): string[] {
  const last = path.lastIndexOf("/");
  const tail = path.slice(last + 1);
  const encodedLetter = `${path.slice(0, last + 1)}%${tail.charCodeAt(0).toString(16)}${tail.slice(1)}`;
  // (No `%2E` dot-segment spellings here: `new Request()` — like the runtime's own parser — folds
  // them away before any code sees the URL. `canonicalPath` is given them as text, below.)
  return [
    encodedLetter,
    path.replace("/api/", "/%61pi/"),
    path.replace("/api/", "/api%2F"),
    `${path.slice(0, last)}%2F${tail}`,
    `${path.slice(0, last)}%2f${tail}`,
    `${path.slice(0, last)}%5C${tail}`,
    `${path.slice(0, last)}//${tail}`,
    `/${path}`,
    `${path}/`,
    `${path}%2F`,
    `${path}%20`,
    `${path}%00`,
    `${path};x=1/`,
    `${path}%C3%A9`,
    `${path}é`,
  ].filter((variant) => variant !== path);
}

describe("the canonical form of a path", () => {
  it.each([
    "/",
    "/api/health",
    "/api/auth/sign-in/email",
    "/api/nodes/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e/trash",
    "/assets/index-B1a_2.js",
    "/.well-known/security.txt",
    "/s/AbC_d-9~x",
    "/a/b;c=d,e@f:g",
  ])("%s is canonical", (path) => {
    expect(canonicalPath(at(path))).toBe(path);
    expect(canonicalPath(`${at(path)}?q=%2F..%2F&_method=DELETE#frag`)).toBe(path);
  });

  it.each([
    ["an encoded letter", "/api/%61uth/sign-in/email"],
    ["an encoded letter, upper-case hex", "/api/auth/sign-in/%65mail"],
    ["an encoded slash", "/api/invites%2Fx"],
    ["an encoded slash, lower-case hex", "/api/invites%2fx"],
    ["an encoded slash at the end", "/api/auth-intent%2F"],
    ["an encoded backslash", "/api/auth%5Cok"],
    ["an encoded dot", "/api/auth/%2E%2E/admin"],
    ["an encoded dot, lower case", "/api/%2e/auth/ok"],
    ["a double-encoded slash", "/api/auth%252Fok"],
    ["an encoded space", "/api/auth/ok%20"],
    ["an encoded NUL", "/api/auth/ok%00"],
    ["encoded UTF-8", "/api/caf%C3%A9"],
    ["UTF-8 not in NFC", "/api/cafe%CC%81"],
    ["a bare percent", "/api/100%"],
    ["raw non-ASCII", "/api/café"],
    ["a backslash", "/api\\auth\\ok"],
    ["a dot segment", "/api/./auth/ok"],
    ["a double-dot segment", "/api/auth/ok/../admin/set-role"],
    ["an empty segment", "/api//auth/ok"],
    ["a leading empty segment", "//api/auth/ok"],
    ["a trailing slash", "/api/auth/ok/"],
    ["a space", "/api/auth/o k"],
    ["a tab", "/api/auth/o\tk"],
    ["a newline", "/api/auth/ok\n"],
    ["a control character", "/api/auth/ok\u0001"],
    ["a quote", '/api/auth/"ok"'],
    ["angle brackets", "/api/<x>"],
    ["a pipe", "/api/a|b"],
    ["no path at all", ""],
    ["too long", `/${"a".repeat(MAX_PATH_CHARS)}`],
  ])("%s is not: %s", (_what, path) => {
    expect(canonicalPath(at(path))).toBeNull();
  });

  it("a URL that is not one has no path; the control: the same checks pass a plain path", () => {
    expect(canonicalPath("not a url")).toBeNull();
    expect(canonicalPath("/api/health")).toBeNull();
    expect(canonicalPath("http://localhost\\api\\health")).toBeNull();
    expect(canonicalPath("http://localhost/api/health")).toBe("/api/health");
  });

  it("methods: the seven that exist, a HEAD read as a GET, anything else none", () => {
    expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map(canonicalMethod)).toEqual([
      "GET",
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]);
    expect(canonicalMethod("get")).toBe("GET");
    for (const method of ["TRACE", "CONNECT", "PROPFIND", "FOO", ""])
      expect(canonicalMethod(method)).toBeNull();
  });

  it("under /api/auth only the table's exact (method, path) pairs exist — and unknown /admin/ paths, for the audited refusal", () => {
    expect(existsOnAppHost("POST", "/api/auth/sign-in/email")).toBe(true);
    expect(existsOnAppHost("GET", "/api/auth/sign-in/email")).toBe(false);
    expect(existsOnAppHost("OPTIONS", "/api/auth/sign-in/email")).toBe(false);
    expect(existsOnAppHost("POST", "/api/auth/Sign-In/email")).toBe(false);
    expect(existsOnAppHost("POST", "/api/auth/nope")).toBe(false);
    expect(existsOnAppHost("GET", "/api/auth/admin/set-role")).toBe(false);
    expect(existsOnAppHost("POST", "/api/auth/admin/some-future-endpoint")).toBe(true);
    expect(existsOnAppHost("DELETE", "/api/nodes/x")).toBe(true);
  });
});

// ── the app host ────────────────────────────────────────────────────────────────────────────

type Reached = { reached?: string; method?: string; path?: string; error?: string };

function setup() {
  const fake = fakeCore();
  fake.state.settings = { termsVersion: "2026-10-01" };
  const handler = new Hono<AppEnv>();
  // Stands where the handlers do: answers every method on every path under /api.
  handler.all("/*", (c) =>
    c.json({ reached: c.req.path, method: requestMethod(c), path: requestPath(c) } satisfies Reached),
  );
  const app = appWith(fake, { extraRouters: [handler] });
  const seen: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (seen.push(key), { success: true }) };
  const send = async (path: string, options: CallOptions = {}) => {
    const { response, ctx } = await call(app, path, {
      ...options,
      env: { RL_AUTH: limiter, RL_API: limiter, ...options.env },
    });
    const text = await response.text();
    await ctx.settle();
    let body: Reached | null = null;
    try {
      body = JSON.parse(text) as Reached;
    } catch {
      body = null;
    }
    return { status: response.status, body, headers: response.headers };
  };
  return { fake, send, seen };
}

describe("app host: a spelling that is not canonical never reaches anything", () => {
  const TARGETS: Array<[string, string]> = [
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/admin/set-role"],
    ["GET", "/api/auth/verify-email"],
    ["POST", "/api/auth-intent"],
    ["GET", "/api/invites/abc"],
    ["POST", "/api/nodes/folder"],
    ["GET", "/api/public/config"],
  ];

  it("every variant of every target: 404 — no limiter, no session read, no database, no handler", async () => {
    const { fake, send, seen } = setup();
    let probed = 0;
    for (const [method, path] of TARGETS) {
      for (const variant of variants(path)) {
        // Cross-site on purpose: a CSRF refusal (403) would show that a later layer saw it.
        const answer = await send(variant, { method, headers: { origin: "https://evil.example" } });
        expect(answer.status, `${method} ${variant}`).toBe(404);
        expect(answer.body, `${method} ${variant}`).toMatchObject({ error: "not_found" });
        expect(answer.body?.reached, `${method} ${variant}`).toBeUndefined();
        // The API's own header set, although the header middleware never ran.
        expect(answer.headers.get("cache-control"), variant).toContain("no-store");
        expect(answer.headers.get("x-content-type-options"), variant).toBe("nosniff");
        probed += 1;
      }
    }
    expect(probed).toBeGreaterThan(90);
    expect(seen, "limiter keys").toEqual([]);
    expect(fake.calls, "session reads and database work").toEqual([]);
  });

  it("the control: the canonical spelling of each target IS seen by the layers behind", async () => {
    const { fake, send, seen } = setup();
    for (const [method, path] of TARGETS) {
      const answer = await send(path, { method, headers: sameOrigin });
      expect(answer.status, `${method} ${path}`).not.toBe(404);
    }
    // The auth budget was spent by exactly the requests it is for, under their own keys.
    expect(seen.filter((key) => !key.startsWith("ip:") || seen.indexOf(key) < 0)).toEqual(
      expect.arrayContaining(["intent:127.0.0.1", "inv:127.0.0.1"]),
    );
    expect(seen.filter((key) => key === "ip:127.0.0.1").length).toBeGreaterThanOrEqual(TARGETS.length);
    expect(fake.calls).toContain("getSession");
    // … and a cross-site write to the canonical path is what CSRF refuses.
    const crossSite = await send("/api/nodes/folder", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
  });

  it("what the handler is given: the raw path, Hono's path and the accessor are the same bytes", async () => {
    const { send } = setup();
    for (const path of ["/api/nodes/a.b_c~d-e", "/api/links/x;y=1,z@q:r", "/api/trash"]) {
      const answer = await send(path);
      expect(answer.body, path).toEqual({ reached: path, method: "GET", path });
    }
  });

  it("a method that does not exist is a 404 before anything; a HEAD is a GET for every gate", async () => {
    const { fake, send, seen } = setup();
    for (const method of ["TRACE", "PROPFIND", "FOO"]) {
      let status: number;
      try {
        status = (await send("/api/nodes/folder", { method, headers: sameOrigin })).status;
      } catch {
        // The runtime itself refuses to build a request with this method: it cannot arrive.
        continue;
      }
      expect(status, method).toBe(404);
    }
    expect(seen).toEqual([]);
    expect(fake.calls).toEqual([]);
    // HEAD: read as GET — not a write for CSRF (no Origin here), and the GET endpoint's own pair.
    expect((await send("/api/nodes/x", { method: "HEAD" })).status).toBe(200);
    expect((await send("/api/auth/get-session", { method: "HEAD" })).status).not.toBe(404);
    expect((await send("/api/auth/sign-in/email", { method: "HEAD" })).status).toBe(404);
  });

  it("no layer honours a method override: the header and the parameter are data", async () => {
    const { send, seen } = setup();
    const override = {
      "x-http-method-override": "POST",
      "x-method-override": "POST",
      "x-http-method": "POST",
    };
    // A GET stays a GET: it does not become the POST endpoint, and spends no auth budget.
    const asGet = await send("/api/auth/sign-in/email?_method=POST", { headers: override });
    expect(asGet.status).toBe(404);
    expect(seen).toEqual([]);
    const read = await send("/api/nodes/x?_method=DELETE", {
      headers: { ...override, origin: "https://evil.example" },
    });
    expect(read.body).toMatchObject({ method: "GET" });
    // A cross-site POST stays a POST: claiming to be a GET does not get it past CSRF.
    const asPost = await send("/api/nodes/folder?_method=GET", {
      method: "POST",
      headers: {
        "x-http-method-override": "GET",
        "x-method-override": "GET",
        origin: "https://evil.example",
      },
    });
    expect(asPost.status).toBe(403);
  });

  it("every endpoint of the auth handler: each variant is a 404, the canonical form is the policy's", async () => {
    const { send, seen } = setup();
    let probed = 0;
    for (const [methods, tablePath] of AUTH_ENDPOINTS) {
      const path = `/api/auth${tablePath.replace(/:[A-Za-z]+/g, "abc123")}`;
      const method = methods.split(",")[0]!;
      const more = [path.replace("/api/auth/", "/api/AUTH/"), path.toUpperCase(), `${path}/extra`];
      for (const variant of [...variants(path), ...more]) {
        const answer = await send(variant, { method, headers: sameOrigin });
        if (variant.startsWith("/api/auth/admin/") && answer.status === 403) {
          // An unknown path under /admin/ in canonical form: the audited refusal of routes/auth.ts.
          expect(variant, variant).toBe(`${path}/extra`);
          continue;
        }
        if (answer.status !== 404) {
          // `/api/AUTH/…` and `/API/…` are canonical TEXT, but another path: not under /api/auth
          // (an unknown API path, which this test's catch-all answers) or not under /api at all
          // (the SPA). Either way no auth endpoint was reached, and no auth budget spent.
          expect(variant.startsWith("/api/auth/"), variant).toBe(false);
          if (answer.body?.reached !== undefined) expect(answer.body.reached, variant).toBe(variant);
          continue;
        }
        expect(answer.body?.reached, variant).toBeUndefined();
        probed += 1;
      }
      const canonical = await send(path, { method, headers: sameOrigin });
      expect(canonical.status, `${method} ${path}`).not.toBe(404);
    }
    expect(probed).toBeGreaterThan(AUTH_ENDPOINTS.length * 12);
    // Only canonical requests were ever counted.
    for (const key of seen) expect(key).toMatch(/^(ip|u):/);
  });
});

// ── the files host ──────────────────────────────────────────────────────────────────────────

describe("files host: the same step, first", () => {
  const filesHost = () => {
    const fake = fakeCore();
    const seen: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (seen.push(key), { success: true }) };
    const app = createFilesHost(fake.core);
    const send = async (path: string, method = "GET") => {
      const { response, ctx } = await call(app, path, {
        method,
        origin: TEST_FILES_ORIGIN,
        env: { RL_FILES: limiter },
      });
      const text = await response.text();
      await ctx.settle();
      return { status: response.status, text, headers: response.headers };
    };
    return { fake, send, seen };
  };

  it("an encoded, doubled, dotted or slash-ended token path is a plain 404 and is not counted", async () => {
    const { fake, send, seen } = filesHost();
    for (const base of ["/d/abcDEF123", "/i/abcDEF123", "/t/abcDEF123"]) {
      for (const variant of variants(base)) {
        const answer = await send(variant);
        expect(answer.status, variant).toBe(404);
        expect(answer.text, variant).toBe("Not found\n");
        expect(answer.headers.get("content-type"), variant).toBe("text/plain; charset=utf-8");
        expect(answer.headers.get("set-cookie"), variant).toBeNull();
        // The files host's header set, although its header middleware never ran.
        expect(answer.headers.get("content-security-policy"), variant).toBe(
          "sandbox; default-src 'none'; frame-ancestors 'none'",
        );
        expect(answer.headers.get("cache-control"), variant).toBe("private, no-store");
      }
    }
    expect(seen).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("the control: the canonical token path reaches its route and is counted", async () => {
    const { send, seen } = filesHost();
    expect((await send("/d/abcDEF123")).status).toBe(501);
    expect((await send("/d/abcDEF123", "HEAD")).status).toBe(501);
    expect(seen).toHaveLength(2);
  });
});

// ── one accessor: the source scan ───────────────────────────────────────────────────────────

const SOURCES = {
  ...import.meta.glob("../../../src/worker/middleware/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../src/worker/auth/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../src/worker/routes/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../src/worker/files-host.ts", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

/** Another way to learn the request's path or method than the accessor. */
const SECOND_SOURCE =
  /\bc\.req\.(?:path|url|method|routePath)\b|\.req\.raw\.(?:url|method)\b|\brequest\.(?:url|method)\b|\breq\.(?:url|method)\b|\bgetPath\(|\broutePath\(/;

/**
 * The uses that are NOT a decision about the incoming request's path or method — each one named,
 * with why. A line matches when it is in that file and contains that text.
 */
const ALLOWED: Array<[file: string, text: string, why: string]> = [
  ["middleware/canonical.ts", "request.url", "the accessor itself: the one place the URL is read"],
  ["middleware/canonical.ts", "request.method", "the accessor itself"],
  [
    "middleware/request-context.ts",
    "routePath(c)",
    "the matched route PATTERN, for the request metric's tag",
  ],
  [
    "auth/mailbox-proof.ts",
    "new URL(ctx.request.url).searchParams",
    "reads a query parameter (the token, the callback), not the path",
  ],
  ["auth/test-outbound.ts", "request.url", "an OUTBOUND request the Worker makes (test mode only)"],
  ["auth/test-outbound.ts", "request.method", "an OUTBOUND request the Worker makes (test mode only)"],
  ["auth/test-outbound.ts", "request.clone()", "an OUTBOUND request"],
];

function secondSources(sources: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const short = file.replace(/^.*\/src\/worker\//, "");
    text.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (!SECOND_SOURCE.test(code)) return;
      if (ALLOWED.some(([allowedFile, allowedText]) => short === allowedFile && code.includes(allowedText)))
        return;
      found.push(`${short}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("one accessor for the path and the method", () => {
  it("nothing under middleware/, auth/, routes/ or files-host.ts reads the path or the method any other way", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(40);
    expect(secondSources(SOURCES)).toEqual([]);
  });

  it("the control: a second path source in any of those files is found", () => {
    const planted = {
      "/x/src/worker/middleware/new-gate.ts": "export const gate = (c) => c.req.path.startsWith('/api/');",
      "/x/src/worker/routes/new-route.ts": "const where = new URL(c.req.url).pathname;",
      "/x/src/worker/auth/new-hook.ts": "if (ctx.request.method === 'GET' && request.url.includes('x')) {}",
      "/x/src/worker/files-host.ts":
        "  if (c.req.method === 'GET') return;\n  // c.req.path in a comment is not code",
      "/x/src/worker/routes/raw.ts": "const u = c.req.raw.url;",
    };
    expect(secondSources(planted)).toHaveLength(5);
    // …and every exception is still needed: each names a line that exists.
    for (const [file, text] of ALLOWED) {
      const source =
        Object.entries(SOURCES).find(([name]) => name.endsWith(`/src/worker/${file}`))?.[1] ?? "";
      expect(source.includes(text), `${file}: ${text}`).toBe(true);
    }
  });
});
