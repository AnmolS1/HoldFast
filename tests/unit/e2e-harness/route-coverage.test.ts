// The route-coverage pieces (scripts/route-coverage/routes.ts) on made-up route sets and hits —
// above all the diff's own control: a route whose hits are taken out of the hit file is reported.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  answeredByWorker,
  diffReport,
  hitLine,
  matcher,
  parseHits,
  readHitFiles,
  routesOf,
  uncovered,
  type Hit,
  type HitFile,
  type Route,
} from "../../../scripts/route-coverage/routes";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SAMPLE_UUID = "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e";

const ROUTES: Route[] = [
  { host: "app", method: "GET", path: "/api/nodes/root" },
  { host: "app", method: "GET", path: `/api/nodes/:id{${UUID}}` },
  { host: "app", method: "POST", path: `/api/nodes/:id{${UUID}}/move` },
  { host: "app", method: "GET", path: "/api/invites/:code{[A-Za-z0-9_-]{1,128}}" },
  { host: "app", method: "GET", path: "/api/_test/outbox" },
  { host: "app", method: "GET", path: "/api/auth/reset-password/:token" },
  { host: "files", method: "GET", path: "/d/*" },
  { host: "files", method: "OPTIONS", path: "/*" },
];

const hit = (host: Hit["host"], method: string, path: string, status = 200): Hit => ({
  source: "test",
  host,
  method,
  path,
  status,
});

/** One hit for every route of ROUTES except the allowlisted one. */
const ALL_HITS: Hit[] = [
  hit("app", "GET", "/api/nodes/root"),
  hit("app", "GET", `/api/nodes/${SAMPLE_UUID}`, 404),
  hit("app", "POST", `/api/nodes/${SAMPLE_UUID}/move`),
  hit("app", "GET", "/api/invites/abc_DEF-123"),
  hit("app", "GET", "/api/auth/reset-password/some-token"),
  hit("files", "GET", `/d/${SAMPLE_UUID}/token`),
  hit("files", "OPTIONS", `/d/${SAMPLE_UUID}/token`),
];

describe("matcher: a Hono path as a RegExp", () => {
  it("a parameter's own pattern decides, braces inside it included", () => {
    expect(matcher(`/api/nodes/:id{${UUID}}`).test(`/api/nodes/${SAMPLE_UUID}`)).toBe(true);
    expect(matcher(`/api/nodes/:id{${UUID}}`).test("/api/nodes/root")).toBe(false);
    expect(matcher("/api/invites/:code{[A-Za-z0-9_-]{1,128}}").test(`/api/invites/${"a".repeat(128)}`)).toBe(
      true,
    );
    expect(matcher("/api/invites/:code{[A-Za-z0-9_-]{1,128}}").test(`/api/invites/${"a".repeat(129)}`)).toBe(
      false,
    );
  });

  it("a bare parameter is one segment; a last `*` is the rest; static text is literal", () => {
    expect(matcher("/api/auth/reset-password/:token").test("/api/auth/reset-password/x")).toBe(true);
    expect(matcher("/api/auth/reset-password/:token").test("/api/auth/reset-password/x/y")).toBe(false);
    expect(matcher("/d/*").test(`/d/${SAMPLE_UUID}/token`)).toBe(true);
    expect(matcher("/d/*").test("/i/x")).toBe(false);
    expect(matcher("/*").test("/anything/at/all")).toBe(true);
    expect(matcher("/api/a.b").test("/api/aXb")).toBe(false);
  });
});

describe("uncovered: the routes no hit reaches", () => {
  it("every route hit (the allowlisted one apart): nothing is uncovered", () => {
    expect(uncovered(ROUTES, ALL_HITS)).toEqual([]);
  });

  it("CONTROL: the hits of one route removed from the hit set — exactly that route is reported", () => {
    for (const route of ROUTES.filter((route) => !ALLOWLIST.some((entry) => entry.path === route.path))) {
      const test = matcher(route.path);
      const without = ALL_HITS.filter(
        (one) => !(one.host === route.host && one.method === route.method && test.test(one.path)),
      );
      expect(without.length).toBeLessThan(ALL_HITS.length);
      expect(uncovered(ROUTES, without)).toEqual([route]);
    }
  });

  it("a hit counts for the FIRST matching route, in mount order", () => {
    const routes: Route[] = [
      { host: "app", method: "GET", path: "/api/nodes/root" },
      { host: "app", method: "GET", path: "/api/nodes/:id" },
    ];
    expect(uncovered(routes, [hit("app", "GET", "/api/nodes/root")])).toEqual([routes[1]]);
  });

  it("the method must match; HEAD reaches a GET route; a hit without a host is tried on both", () => {
    const routes: Route[] = [
      { host: "app", method: "POST", path: "/api/x" },
      { host: "files", method: "GET", path: "/t/*" },
    ];
    expect(uncovered(routes, [hit("app", "GET", "/api/x")])).toEqual(routes);
    expect(uncovered(routes, [hit(null, "POST", "/api/x"), hit(null, "HEAD", "/t/a/b")])).toEqual([]);
    // A host the route is not on does not reach it.
    expect(uncovered(routes, [hit("app", "GET", "/t/a/b")])).toEqual(routes);
  });

  it("the allowlist is explicit: the test outbox and nothing else", () => {
    expect(ALLOWLIST.map((entry) => `${entry.host} ${entry.method} ${entry.path}`)).toEqual([
      "app GET /api/_test/outbox",
    ]);
    expect(uncovered(ROUTES, ALL_HITS, [])).toEqual([ROUTES[4]]);
  });
});

describe("diffReport: what diff.ts prints and fails on", () => {
  const file = (name: string, hits: Hit[]): HitFile => ({
    file: `coverage/routes-hit.${name}.jsonl`,
    hits,
    modified: new Date(),
  });

  it("all reached: no problem, and each hit file is named with its count", () => {
    const report = diffReport(ROUTES, [
      file("e2e", ALL_HITS.slice(0, 3)),
      file("workers", ALL_HITS.slice(3)),
    ]);
    expect(report.problems).toEqual([]);
    expect(report.lines.filter((line) => line.includes("hits, written"))).toHaveLength(2);
  });

  it("no hit file at all is a failure, never 'nothing uncovered'", () => {
    const report = diffReport(ROUTES, []);
    expect(report.problems[0]).toBe("no hit file (coverage/routes-hit.*.jsonl): nothing was collected");
  });

  it("a required source that is missing or empty fails, though every route was reached", () => {
    const report = diffReport(
      ROUTES,
      [file("e2e", ALL_HITS), file("workers", [])],
      ["e2e", "workers", "tablewide"],
    );
    expect(report.problems).toEqual([
      'no hits from "workers" (coverage/routes-hit.workers.jsonl is empty)',
      'no hits from "tablewide" (coverage/routes-hit.tablewide.jsonl is missing)',
    ]);
  });

  it("an uncovered route and a stale allowlist entry are both named", () => {
    const routes = ROUTES.filter((route) => route.path !== "/api/_test/outbox");
    const report = diffReport(routes, [file("e2e", ALL_HITS.slice(1))]);
    expect(report.problems).toEqual([
      "uncovered: app GET /api/nodes/root",
      "allowlist names no route: app GET /api/_test/outbox",
    ]);
  });
});

describe("routesOf: the routes among a mounted app's entries", () => {
  const auth = {
    prefix: "/api/auth",
    endpoints: [
      ["GET,POST", "/get-session", "allow"],
      ["POST", "/sign-in/email", "deny"],
    ] as const,
  };

  it("middleware and fallbacks are left out, validator entries are one route, Better Auth is its endpoints, HEAD beside GET is the GET route", () => {
    const app = new Hono();
    app.use("*", async (_c, next) => next());
    app.use("/api/*", async (_c, next) => next());
    const api = new Hono();
    api.get("/nodes/root", (c) => c.text("root"));
    api.post(
      "/nodes/folder",
      async (_c, next) => next(),
      (c) => c.text("made"),
    );
    api.all("/auth/*", (c) => c.text("better auth"));
    app.route("/api", api);
    app.all("/api/*", (c) => c.notFound());
    app.get("/__meta", (c) => c.text("meta"));
    app.on(["GET", "HEAD"], "/d/*", (c) => c.text("bytes"));
    app.on("HEAD", "/only-head", (c) => c.text(""));
    app.all("*", (c) => c.text("spa"));
    expect(routesOf("app", app.routes, auth)).toEqual([
      { host: "app", method: "GET", path: "/api/nodes/root" },
      { host: "app", method: "POST", path: "/api/nodes/folder" },
      { host: "app", method: "GET", path: "/api/auth/get-session" },
      { host: "app", method: "POST", path: "/api/auth/get-session" },
      { host: "app", method: "POST", path: "/api/auth/sign-in/email" },
      { host: "app", method: "GET", path: "/__meta" },
      // GET + HEAD on one path is the GET route (Hono serves HEAD through it); a lone HEAD stays.
      { host: "app", method: "GET", path: "/d/*" },
      { host: "app", method: "HEAD", path: "/only-head" },
    ]);
  });
});

describe("answeredByWorker: a mock is not a hit", () => {
  it("the Worker's API and files-host answers carry their CSP; a fulfilled mock and the HTML page do not count", () => {
    expect(
      answeredByWorker({ "content-security-policy": "default-src 'none'; frame-ancestors 'none'" }),
    ).toBe(true);
    expect(
      answeredByWorker({ "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'" }),
    ).toBe(true);
    expect(answeredByWorker({ "content-type": "application/json" })).toBe(false);
    expect(answeredByWorker({ "content-security-policy": "default-src 'self'; script-src 'self'" })).toBe(
      false,
    );
  });
});

describe("hit files", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("round-trip: hitLine → readHitFiles; only routes-hit.*.jsonl files are read", () => {
    dir = mkdtempSync(join(tmpdir(), "route-coverage-"));
    writeFileSync(join(dir, "routes-hit.e2e.jsonl"), ALL_HITS.map(hitLine).join(""));
    writeFileSync(join(dir, "routes.json"), "[]");
    const files = readHitFiles(dir);
    expect(files.map((one) => one.file)).toEqual([join(dir, "routes-hit.e2e.jsonl")]);
    expect(files[0]!.hits).toEqual(ALL_HITS);
    expect(readHitFiles(join(dir, "missing"))).toEqual([]);
  });

  it("a line that is not a hit is an error, not skipped", () => {
    expect(() => parseHits(`${hitLine(ALL_HITS[0]!)}{"method":"GET"}\n`, "f.jsonl")).toThrow(
      /f\.jsonl:2: not a hit/,
    );
  });
});
