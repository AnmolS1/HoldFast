// Shared by the worker-core tests. Runs inside workerd (so it lives here, not under tests/setup).
//
// The apps are driven directly — `createApp(fakeCore).fetch(request, env, ctx)` — with a fake
// `CoreDeps`, an env that is the real test env plus overrides, and a hand-made ExecutionContext
// whose `waitUntil` promises the test can wait for. That is the only handle on "what happened
// after the response".
import { env as workerEnv } from "cloudflare:workers";
import type { Hono } from "hono";
import { createApp, type AppOptions } from "../../../src/worker/app";
import type { Auth, SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import type { Db } from "../../../src/worker/db/client";
import type { Settings } from "../../../src/worker/db/queries/settings";
import type { AppEnv, CoreDeps } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";

export const POOL_ENDED = "Cannot use a pool after calling end on the pool";

export type FakeCore = {
  core: CoreDeps;
  /** Everything the fakes did, in order: "createDb", "query", "close", "getSession", "getSettings", … */
  calls: string[];
  audits: Array<Parameters<CoreDeps["insertAudit"]>[1]>;
  /** Mutable: what the fakes answer with. */
  state: {
    session: { session: SessionInfo; user: SessionUser } | null;
    settings: Settings;
    termsVersionInDb: string | null;
    queryFails: boolean;
  };
};

/** A `CoreDeps` that behaves like the real one where it matters: `close()` twice throws, and a query after `close()` rejects. */
export function fakeCore(): FakeCore {
  const calls: string[] = [];
  const audits: FakeCore["audits"] = [];
  const state: FakeCore["state"] = { session: null, settings: {}, termsVersionInDb: null, queryFails: false };

  const core: CoreDeps = {
    createDb() {
      calls.push("createDb");
      let closed = false;
      const db = {
        async execute() {
          if (closed) throw new Error(POOL_ENDED);
          if (state.queryFails) throw new Error("connect ECONNREFUSED");
          calls.push("query");
          return { rows: [{ "?column?": 1 }] };
        },
        get closed() {
          return closed;
        },
      } as unknown as Db;
      return {
        db,
        async close() {
          if (closed) throw new Error("Called end on pool more than once");
          closed = true;
          calls.push("close");
        },
      };
    },
    createAuth(): Auth {
      calls.push("createAuth");
      return {
        handler: async () => new Response("fake auth handler", { status: 501 }),
        api: {
          async getSession() {
            calls.push("getSession");
            return state.session;
          },
        },
      };
    },
    async getSettings(db) {
      await (db as unknown as { execute(): Promise<unknown> }).execute();
      calls.push("getSettings");
      return state.settings;
    },
    async termsVersionOf(db) {
      await (db as unknown as { execute(): Promise<unknown> }).execute();
      calls.push("termsVersionOf");
      return state.termsVersionInDb;
    },
    async insertAudit(db, row) {
      await (db as unknown as { execute(): Promise<unknown> }).execute();
      calls.push("insertAudit");
      audits.push(row);
    },
  };
  return { core, calls, audits, state };
}

export type FakeCtx = ExecutionContext & {
  pending: Promise<unknown>[];
  /** Waits for everything handed to `waitUntil`, including work registered while waiting. */
  settle(): Promise<void>;
};

export function fakeCtx(): FakeCtx {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  } as unknown as FakeCtx;
}

export function testEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...workerEnv, ...overrides } as unknown as Env;
}

const allow = { limit: async () => ({ success: true }) };
export const ALLOW_ALL = { RL_AUTH: allow, RL_API: allow, RL_FILES: allow, RL_LINKS: allow };

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CallOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  env?: Record<string, unknown>;
  origin?: string;
};

/** One request through an app, with its own ExecutionContext. The caller consumes the body. */
export async function call(app: Hono<AppEnv>, path: string, options: CallOptions = {}) {
  const ctx = fakeCtx();
  const request = new Request(`${options.origin ?? TEST_APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
  // The real limiters are per-minute counters shared by the whole file (RL_AUTH: 20/min by IP),
  // so by default a request sees limiters that always allow. A test of the limits passes its own.
  const response = await app.fetch(request, testEnv({ ...ALLOW_ALL, ...options.env }), ctx);
  return { response, ctx };
}

/** Same-origin headers for a state-changing request (what a browser on the app origin sends). */
export const sameOrigin = { origin: TEST_APP_ORIGIN, "sec-fetch-site": "same-origin" };

export function appWith(fake: FakeCore, options?: AppOptions) {
  return createApp(fake.core, options);
}

const BASE_DATE = new Date("2026-01-01T00:00:00.000Z");

export function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "u".repeat(32),
    name: "Test User",
    email: "user@example.test",
    emailVerified: true,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    role: "user",
    banned: false,
    banExpires: null,
    twoFactorEnabled: false,
    quotaBytes: 5_368_709_120,
    usedBytes: 0,
    termsVersion: "2026-10-01",
    suspendedAt: null,
    deleteScheduledAt: null,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s".repeat(32),
    userId: "u".repeat(32),
    token: "session-token",
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides,
  };
}

export function signIn(fake: FakeCore, user: Partial<SessionUser> = {}, session: Partial<SessionInfo> = {}) {
  fake.state.session = { user: makeUser(user), session: makeSession(session) };
}
