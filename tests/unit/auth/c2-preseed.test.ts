// C2 — Better Auth issue #10315. The Gate-A discriminator: the three AsyncLocalStorage instances
// Better Auth uses are the ones src/worker/auth/als-preseed.ts created, so Better Auth never
// awaits its own module-scope loader.
//
// THIS FILE MUST NOT IMPORT als-preseed STATICALLY, and must reach Better Auth only through
// create-auth.ts. A static import would evaluate the pre-seed itself and the check would pass
// whatever create-auth.ts does. The module is imported dynamically, in the test body, AFTER
// Better Auth has handled a request:
//   - real build: the import returns the already-evaluated module → the instances compared are
//     the ones Better Auth is using;
//   - mutant (the `import "./als-preseed"` line removed from create-auth.ts): the module is
//     evaluated only now; Better Auth has created its own storages, and they are not these.
//
// Mutant control (run by hand, never committed): delete the import line in create-auth.ts,
// run this file unchanged, expect the identity test to FAIL; restore.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../../src/worker/auth/create-auth";
import { createDb } from "../../../src/worker/db/client";
import endpointContextSource from "../../../node_modules/@better-auth/core/dist/context/endpoint-context.mjs?raw";
import globalSource from "../../../node_modules/@better-auth/core/dist/context/global.mjs?raw";
import requestStateSource from "../../../node_modules/@better-auth/core/dist/context/request-state.mjs?raw";
import transactionSource from "../../../node_modules/@better-auth/core/dist/context/transaction.mjs?raw";
import loaderSource from "../../../node_modules/@better-auth/core/dist/async_hooks/index.mjs?raw";
import createAuthSource from "../../../src/worker/auth/create-auth.ts?raw";
import thisFileSource from "./c2-preseed.test.ts?raw";

const KEYS = ["requestStateAsyncStorage", "adapterAsyncStorage", "endpointContextAsyncStorage"] as const;
type Bag = { version: string; epoch: number; context: Record<string, unknown> };
const bag = () =>
  (globalThis as unknown as Record<symbol, Bag | undefined>)[Symbol.for("better-auth:global")];

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe("C2: the pre-seeded storages are the ones Better Auth uses", () => {
  it("storage identity — after a request, all three are the pre-seed's instances", async () => {
    const { db, close } = createDb(env);
    try {
      const auth = createAuth(env, db, ctx);
      // A request that goes through the router, the endpoint context and the database adapter.
      const response = await auth.handler(
        new Request(`${env.APP_ORIGIN}/api/auth/get-session`, {
          headers: { cookie: "hf.session_token=not-a-session.c2", "cf-connecting-ip": "198.51.100.77" },
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
    } finally {
      await close();
    }

    // What Better Auth is holding NOW, before the pre-seed module is looked at. All three must
    // exist: a key Better Auth never created would be filled in by a late pre-seed (`??=`) and
    // compare equal in the mutant too.
    const held = { ...(bag()?.context ?? {}) };
    for (const key of KEYS) expect(held[key], `${key} exists after a request`).toBeDefined();

    const { seeded } = await import("../../../src/worker/auth/als-preseed");
    for (const key of KEYS) {
      expect(held[key] === seeded[key], `${key} is the pre-seeded instance`).toBe(true);
      expect(bag()?.context[key] === seeded[key], `${key} is still the pre-seeded instance`).toBe(true);
    }
  });

  it("this file has no static import of the pre-seed, and create-auth.ts imports it first", () => {
    const staticImports = [...thisFileSource.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map(
      (m) => m[1],
    );
    expect(staticImports.some((path) => path!.includes("als-preseed"))).toBe(false);
    expect(staticImports.some((path) => /^(better-auth|@better-auth)/.test(path!))).toBe(false);

    // The first statement of create-auth.ts is the side-effect import.
    const firstStatement = createAuthSource
      .replace(/^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*/, "")
      .trimStart();
    expect(firstStatement.startsWith('import "./als-preseed";')).toBe(true);
    // Invariant (i): no dynamic import() in the module that builds the instance (comments aside).
    const code = createAuthSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(/\bimport\s*\(/.test(code)).toBe(false);
  });
});

describe("C2 drift guard: the installed @better-auth/core still works the way the pre-seed assumes", () => {
  it("the bag is globalThis[Symbol.for('better-auth:global')] with a `context` object", () => {
    expect(globalSource).toContain('Symbol.for("better-auth:global")');
    expect(globalSource).toMatch(/globalThis\[symbol\]\s*=\s*\{[^}]*context:/s);
    expect(globalSource).toContain('const __betterAuthVersion = "1.7.7"');
  });

  it("the loader is still a module-scope promise (the defect is still there)", () => {
    expect(loaderSource).toMatch(/const AsyncLocalStoragePromise = import\(/);
    expect(loaderSource).toContain('"node:async_hooks"');
  });

  // Each consumer must return the EXISTING storage before it awaits the loader.
  const consumers: Array<[name: string, source: string, key: string]> = [
    ["request-state.mjs", requestStateSource, "requestStateAsyncStorage"],
    ["transaction.mjs", transactionSource, "adapterAsyncStorage"],
    ["endpoint-context.mjs", endpointContextSource, "endpointContextAsyncStorage"],
  ];
  it.each(consumers)(
    "%s returns the existing %s storage before awaiting the loader",
    (_name, source, key) => {
      const read = source.indexOf(`context.${key}`);
      const returned = source.indexOf("if (existing) return existing;");
      const awaited = source.indexOf("await getAsyncLocalStorage()");
      expect(read, `${key} is read from the bag`).toBeGreaterThan(-1);
      expect(returned, "an existing storage is returned").toBeGreaterThan(read);
      expect(awaited, "the loader is awaited only afterwards").toBeGreaterThan(returned);
    },
  );

  it("no other key is created on the bag by a request", () => {
    // If an upgrade adds a fourth storage, the pre-seed must be extended.
    const keys = Object.keys(bag()?.context ?? {}).filter((key) => key.endsWith("AsyncStorage"));
    expect(keys.sort()).toEqual([...KEYS].sort());
  });
});
