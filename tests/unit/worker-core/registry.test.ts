// The route registry rules (routes/index.ts), run against the real routers — placeholders today,
// the real ones at every wave integration — and against deliberately broken sets, so each rule
// is seen to fail.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { BA_ID, BA_ID_PARAM, TOKEN, TOKEN_PARAM, UUID, UUID_PARAM } from "../../../src/shared/ids";
import { apiRouters, routeTable } from "../../../src/worker/routes/index";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { appWith, fakeCore } from "./helpers";
import { checkRegistry, declared, type DeclaredRoute } from "./registry-check";

const UUID_SAMPLE = "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e";
const BA_SAMPLE = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL";

describe("id patterns (src/shared/ids.ts)", () => {
  it("BA_ID is /^[A-Za-z0-9]{32}$/ and BA_ID_PARAM its unanchored source", () => {
    expect(BA_ID.source).toBe("^[A-Za-z0-9]{32}$");
    expect(BA_ID.flags).toBe("");
    expect(BA_ID_PARAM).toBe("[A-Za-z0-9]{32}");
    expect(BA_ID.source).toBe(`^${BA_ID_PARAM}$`);
    expect(UUID.source).toBe(`^${UUID_PARAM}$`);
    expect(TOKEN.source).toBe(`^${TOKEN_PARAM}$`);
  });

  it("the two id families never match each other's values", () => {
    expect(BA_ID.test(BA_SAMPLE)).toBe(true);
    expect(UUID.test(UUID_SAMPLE)).toBe(true);
    expect(BA_ID.test(UUID_SAMPLE)).toBe(false);
    expect(UUID.test(BA_SAMPLE)).toBe(false);
    // 32 hex characters is a valid Better Auth id shape but not a UUID (no dashes).
    expect(UUID.test("0199c6f07b1e7c3a9d2e4f5a6b7c8d9e")).toBe(false);
    expect(BA_ID.test(`${BA_SAMPLE}x`)).toBe(false);
  });

  it("Hono honours the patterns: an id route never captures a static segment", async () => {
    const app = new Hono();
    app.get(`/nodes/:id{${UUID_PARAM}}`, (c) => c.text(`id:${c.req.param("id")}`));
    app.get("/nodes/root", (c) => c.text("root"));
    app.get(`/admin/users/:userId{${BA_ID_PARAM}}`, (c) => c.text(`user:${c.req.param("userId")}`));
    app.get(`/s/:token{${TOKEN_PARAM}}`, (c) => c.text("token"));
    const text = async (path: string) => {
      const response = await app.request(path);
      return `${response.status} ${await response.text()}`;
    };
    expect(await text(`/nodes/${UUID_SAMPLE}`)).toBe(`200 id:${UUID_SAMPLE}`);
    expect(await text("/nodes/root")).toBe("200 root");
    expect(await text("/nodes/not-a-uuid")).toMatch(/^404/);
    expect(await text(`/nodes/${BA_SAMPLE}`)).toMatch(/^404/);
    expect(await text(`/admin/users/${BA_SAMPLE}`)).toBe(`200 user:${BA_SAMPLE}`);
    expect(await text(`/admin/users/${UUID_SAMPLE}`)).toMatch(/^404/);
    expect(await text("/s/short")).toMatch(/^404/);
    expect(await text("/s/abcdefghijklmnop_-12")).toBe("200 token");
  });
});

describe("registry: the real routers", () => {
  it("has the 20 files of the route table, in its order", () => {
    expect(apiRouters.map((entry) => entry.name)).toEqual(routeTable.map((row) => row.name));
    expect(routeTable.map((row) => row.name)).toEqual([
      "health",
      "public",
      "csp-report",
      "test-outbox",
      "auth",
      "signup-intent",
      "invites",
      "pending-email",
      "account-lifecycle",
      "account",
      "nodes",
      "trash",
      "shares",
      "links",
      "uploads",
      "search",
      "recent",
      "reports",
      "public-links",
      "admin",
    ]);
    expect(new Set(apiRouters.map((entry) => entry.router)).size).toBe(20);
  });

  it("passes every rule", () => {
    expect(checkRegistry(declared(apiRouters), routeTable)).toEqual([]);
  });

  it("the app mounts every declared route under /api, and nothing else there", () => {
    const app = appWith(fakeCore());
    const mounted = app.routes
      .filter((route) => route.path.startsWith("/api/") && route.path !== "/api/*")
      .map((route) => `${route.method} ${route.path}`);
    const expected = declared(apiRouters).map((route) => `${route.method} /api${route.path}`);
    expect(mounted.sort()).toEqual(expected.sort());
    expect(expected).toContain("GET /api/health");
    expect(expected).toContain("GET /api/public/config");
    expect(expected).toContain("POST /api/public/csp-report");
    expect(expected).toContain("GET /api/_test/outbox");
  });
});

describe("registry: controls (each rule is seen to fail)", () => {
  const real = declared(apiRouters);
  const withExtra = (...extra: DeclaredRoute[]) => checkRegistry([...real, ...extra], routeTable);
  const id = `:id{${UUID_PARAM}}`;

  it("a sound set of future routes passes", () => {
    expect(
      withExtra(
        { file: "nodes", method: "GET", path: "/nodes/root" },
        { file: "nodes", method: "GET", path: `/nodes/${id}` },
        { file: "nodes", method: "POST", path: `/nodes/${id}/download-url` },
        { file: "nodes", method: "GET", path: "/account/usage" },
        { file: "trash", method: "DELETE", path: `/nodes/${id}` },
        { file: "trash", method: "POST", path: `/nodes/${id}/trash` },
        { file: "links", method: "POST", path: `/nodes/${id}/links` },
        { file: "account", method: "GET", path: "/account/sessions" },
        { file: "account", method: "DELETE", path: `/account/sessions/:id{${BA_ID_PARAM}}` },
        { file: "admin", method: "ALL", path: "/admin/*" },
        { file: "admin", method: "GET", path: `/admin/users/:userId{${BA_ID_PARAM}}` },
        { file: "admin", method: "POST", path: "/admin/jobs/:name{[a-z-]+}/run" },
        { file: "public-links", method: "GET", path: `/public/links/:token{${TOKEN_PARAM}}` },
        { file: "account-lifecycle", method: "POST", path: "/account/deletion/cancel" },
      ),
    ).toEqual([]);
  });

  it("(a) a duplicate GET /nodes/:id in a second file", () => {
    // Through real routers, as two task files would declare them.
    const nodes = new Hono<AppEnv>();
    nodes.get(`/nodes/${id}`, (c) => c.text("nodes"));
    const shares = new Hono<AppEnv>();
    shares.get(`/nodes/${id}`, (c) => c.text("shares"));
    const routers = apiRouters.map((entry) =>
      entry.name === "nodes"
        ? { ...entry, router: nodes }
        : entry.name === "shares"
          ? { ...entry, router: shares }
          : entry,
    );
    const problems = checkRegistry(declared(routers), routeTable);
    expect(problems).toContain("duplicate: GET /nodes/: is declared by nodes and by shares");
    // The same route in ONE file is fine.
    expect(checkRegistry(declared(routers.filter((entry) => entry.name !== "shares")), routeTable)).toEqual(
      [],
    );
  });

  it("(b) a route outside its file's row", () => {
    expect(withExtra({ file: "search", method: "GET", path: "/nodes" })).toEqual([
      "search: GET /nodes — outside its row (may declare: /search)",
    ]);
    expect(withExtra({ file: "nodes", method: "DELETE", path: `/nodes/${id}` })).toEqual([
      `nodes: DELETE /nodes/${id} — outside its row: claimed by trash`,
    ]);
    expect(withExtra({ file: "nodes", method: "POST", path: `/nodes/${id}/trash` })).toHaveLength(1);
    // accept-terms is a real route of account-lifecycle now: declaring it in `account` is outside
    // that file's row (and, separately, a duplicate).
    expect(
      withExtra({ file: "account", method: "POST", path: "/account/accept-terms" }).filter((problem) =>
        problem.includes("outside its row"),
      ),
    ).toHaveLength(1);
    expect(withExtra({ file: "account", method: "GET", path: "/account/usage" })).toHaveLength(1);
    expect(withExtra({ file: "uploads", method: "GET", path: "/made-up" })).toHaveLength(1);
    // A router-wide middleware would also run for every router mounted after it.
    expect(withExtra({ file: "nodes", method: "ALL", path: "/*" })).toHaveLength(1);
    expect(withExtra({ file: "nodes", method: "ALL", path: "/nodes/*" })).toHaveLength(1);
  });

  it("(c) an id parameter without a pattern, or with the other family's pattern", () => {
    expect(withExtra({ file: "nodes", method: "GET", path: "/nodes/:id" })).toEqual([
      "nodes: GET /nodes/:id — :id must carry UUID_PARAM",
    ]);
    expect(withExtra({ file: "public-links", method: "GET", path: "/public/links/:token" })).toEqual([
      "public-links: GET /public/links/:token — :token has no pattern",
    ]);
    // A :userId carrying the UUID pattern is rejected…
    expect(withExtra({ file: "admin", method: "GET", path: `/admin/users/:userId{${UUID_PARAM}}` })).toEqual([
      `admin: GET /admin/users/:userId{${UUID_PARAM}} — :userId is a Better Auth id and must carry BA_ID_PARAM`,
    ]);
    // …as is a session id with it, and a node id with the Better Auth pattern.
    expect(withExtra({ file: "account", method: "DELETE", path: `/account/sessions/${id}` })).toHaveLength(1);
    expect(withExtra({ file: "nodes", method: "GET", path: `/nodes/:id{${BA_ID_PARAM}}` })).toHaveLength(1);
    expect(withExtra({ file: "admin", method: "GET", path: "/admin/nodes/:nodeId" })).toHaveLength(1);
  });

  it("(d) a static path that an earlier parameterised route would capture", () => {
    const problems = checkRegistry(
      [
        { file: "nodes", method: "GET", path: "/nodes/:id{[a-z-]+}" },
        { file: "nodes", method: "GET", path: "/nodes/root" },
      ],
      routeTable,
    );
    expect(problems.some((problem) => problem.startsWith("shadowed: nodes: GET /nodes/root"))).toBe(true);
    // With the UUID pattern the same order is safe.
    expect(
      checkRegistry(
        [
          { file: "nodes", method: "GET", path: `/nodes/${id}` },
          { file: "nodes", method: "GET", path: "/nodes/root" },
        ],
        routeTable,
      ),
    ).toEqual([]);
  });
});
