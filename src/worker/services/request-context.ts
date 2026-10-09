// The request context: how every route reaches the database, auth, keys and settings, and what
// decides when the database pool is closed.
//
//   db(c)            the per-request Drizzle client, opened on first use
//   auth(c)          the per-request Better Auth instance (never cached on the isolate)
//   keys(c)          the purpose keys (services/keys.ts) — `await keys(c).get("download-token")`
//   settings(c)      ASYNC: `(await settings(c)).readOnly` — the settings table merged over env defaults
//   defer(c, p)      run `p` after the response; the pool stays open until it settles
//   deps(c)          a `ServiceDeps` for services that also run outside a request
//
// There is no `c.var.db`. Hono rebuilds `c.var` from a map on every access, so a lazy member
// cannot live there; `c.var` holds only the eager values (requestId, ip, user, session,
// impersonating, termsStale).
//
// LIFETIME. Nothing is opened until asked for. After the handler returns, the middleware waits —
// inside one `waitUntil` — for every deferred promise, INCLUDING promises deferred by deferred
// work, and only then closes the pool. Closing while deferred work still uses the pool is the one
// placement that fails ("Cannot use a pool after calling end on the pool").
//
// RULES FOR ROUTE AUTHORS
//  (a) Never call `c.executionCtx.waitUntil` for anything that touches the database: use `defer`.
//  (b) A handler that returns a streaming body fed from the database passes the stream's
//      completion promise to `defer` before returning.
//  (c) Never keep `db(c)` (or anything from this module) at module scope.
//  (d) Never cache at module scope a PROMISE created inside a request: on a deployed Worker an
//      aborted request orphans it and the isolate hangs on it. Module caches hold resolved values.
//  (e) Inside `db.transaction(cb)` use only `tx`.
//  (f) No session-level SET, session advisory locks, LISTEN or temp tables (transaction pooling).

import type { Context } from "hono";
import type { Auth, SessionInfo, SessionUser } from "../auth/types";
import type { createDb, Db } from "../db/client";
import type { insertAudit } from "../db/queries/audit";
import type { getSettings, Settings } from "../db/queries/settings";
import type { termsVersionOf } from "../db/queries/users";
import { createKeys, type Keys } from "./keys";
import { metric } from "./metrics";

/** Hono environment of both apps. `Variables` holds the eager per-request values only. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    ip: string;
    user: SessionUser | null;
    session: SessionInfo | null;
    impersonating: boolean;
    termsStale: boolean;
  };
};

/** What a service that can run outside a request takes as its first argument. */
export type ServiceDeps = {
  db: Db;
  env: Env;
  defer(p: Promise<unknown>): void;
};

/** The concrete modules injected into the apps. Only the Worker entry imports them. */
export type CoreDeps = {
  createDb: typeof createDb;
  createAuth: (env: Env, db: Db, ctx: ExecutionContext) => Auth;
  getSettings: typeof getSettings;
  termsVersionOf: typeof termsVersionOf;
  insertAudit: typeof insertAudit;
};

/**
 * The settings table merged over the env defaults: the five keys every request path reads are
 * always present. The rest stay as the table has them (absent when there is no row).
 */
export type ResolvedSettings = Omit<
  Settings,
  "signupMode" | "termsVersion" | "uploadsEnabled" | "linksEnabled" | "readOnly"
> & {
  signupMode: "invite" | "open";
  termsVersion: string;
  uploadsEnabled: boolean;
  linksEnabled: boolean;
  readOnly: boolean;
};

/** One per request. Everything but the first three members is lazy and memoized. */
export type RequestContext = {
  requestId: string;
  ip: string;
  colo: string | null;
  readonly db: Db;
  readonly auth: Auth;
  readonly keys: Keys;
  settings(): Promise<ResolvedSettings>;
};

/** What queue and cron code gets. It is a `ServiceDeps`. */
export type BackgroundContext = ServiceDeps & {
  readonly keys: Keys;
  settings(): Promise<ResolvedSettings>;
  metric: typeof metric;
  /** Promises registered through `defer`, drained before the pool closes. */
  deferred: Promise<unknown>[];
};

export const CONTEXT_CLOSED = "request context closed";

/** Env defaults under the settings table. An unknown `SIGNUP_MODE` is the closed one. */
export function resolveSettings(
  env: Pick<Env, "SIGNUP_MODE" | "TERMS_VERSION">,
  stored: Settings,
): ResolvedSettings {
  return {
    ...stored,
    signupMode: stored.signupMode ?? (env.SIGNUP_MODE === "open" ? "open" : "invite"),
    termsVersion: stored.termsVersion ?? env.TERMS_VERSION,
    uploadsEnabled: stored.uploadsEnabled ?? true,
    linksEnabled: stored.linksEnabled ?? true,
    readOnly: stored.readOnly ?? false,
  };
}

// ── The lifetime core, shared by the fetch path and by runBackground ──────────────────────────

/** All this module needs of an ExecutionContext. Hono's own context type satisfies it too. */
export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

type Lifetime = {
  core: CoreDeps;
  env: Env;
  ctx: WaitUntil;
  deferred: Promise<unknown>[];
  /** Set once the drain loop has ended and `close()` is about to run. Nothing is accepted after it. */
  closed: boolean;
  handle: { db: Db; close: () => Promise<void> } | null;
  keys: Keys | null;
  settings: Promise<ResolvedSettings> | null;
};

function newLifetime(core: CoreDeps, env: Env, ctx: WaitUntil): Lifetime {
  return { core, env, ctx, deferred: [], closed: false, handle: null, keys: null, settings: null };
}

function lifeDb(life: Lifetime): Db {
  if (life.closed) throw new Error(CONTEXT_CLOSED);
  life.handle ??= life.core.createDb(life.env);
  return life.handle.db;
}

function lifeDefer(life: Lifetime, p: Promise<unknown>): void {
  // Work registered on a pool that is closing cannot be honoured; say so instead of losing it.
  if (life.closed) throw new Error(CONTEXT_CLOSED);
  life.deferred.push(p);
  life.ctx.waitUntil(p);
}

function lifeKeys(life: Lifetime): Keys {
  life.keys ??= createKeys(life.env.FILES_TOKEN_SECRET);
  return life.keys;
}

function lifeSettings(life: Lifetime): Promise<ResolvedSettings> {
  // Memoized for this invocation only. The 60 s cache across requests is getSettings' own.
  life.settings ??= life.core.getSettings(lifeDb(life)).then((stored) => resolveSettings(life.env, stored));
  return life.settings;
}

/**
 * Wait for the deferred work until none is left, then close the pool if one was opened.
 * A single `Promise.allSettled(deferred)` would miss work deferred by deferred work, and the pool
 * would close under it — hence the loop: each pass takes what is there, and it ends only when a
 * pass registered nothing new.
 */
async function drainAndClose(life: Lifetime): Promise<void> {
  while (life.deferred.length) await Promise.allSettled(life.deferred.splice(0));
  life.closed = true;
  if (life.handle) await life.handle.close();
}

// ── Request path ──────────────────────────────────────────────────────────────────────────────

type RequestState = Lifetime & {
  requestId: string;
  ip: string;
  colo: string | null;
  auth: Auth | null;
  executionCtx: ExecutionContext;
};

const states = new WeakMap<object, RequestState>();

function stateOf(c: Context<AppEnv>): RequestState {
  const state = states.get(c);
  if (!state) throw new Error("no request context: the requestContext middleware has not run");
  return state;
}

/** Called by the request-context middleware, once per request. Opens nothing. */
export function openRequestContext(
  c: Context<AppEnv>,
  core: CoreDeps,
  eager: { requestId: string; ip: string; colo: string | null },
): void {
  // Hono types its own narrower ExecutionContext; at runtime it is the Worker's.
  const ctx = c.executionCtx as unknown as ExecutionContext;
  states.set(c, { ...newLifetime(core, c.env, ctx), ...eager, auth: null, executionCtx: ctx });
}

/**
 * Called by the middleware in a `finally`, after the handler. Registers the drain-then-close with
 * `waitUntil` and returns at once: the response is not held back by deferred work.
 * This is the only caller of `close()` on the fetch path.
 */
export function finishRequestContext(c: Context<AppEnv>): void {
  const state = states.get(c);
  if (!state) return;
  state.ctx.waitUntil(drainAndClose(state));
}

export function db(c: Context<AppEnv>): Db {
  return lifeDb(stateOf(c));
}

export function auth(c: Context<AppEnv>): Auth {
  const state = stateOf(c);
  state.auth ??= state.core.createAuth(state.env, lifeDb(state), state.executionCtx);
  return state.auth;
}

export function keys(c: Context<AppEnv>): Keys {
  return lifeKeys(stateOf(c));
}

export function settings(c: Context<AppEnv>): Promise<ResolvedSettings> {
  return lifeSettings(stateOf(c));
}

export function defer(c: Context<AppEnv>, p: Promise<unknown>): void {
  lifeDefer(stateOf(c), p);
}

/** `db` is the same lazy client as `db(c)`: building a `ServiceDeps` opens nothing. */
export function deps(c: Context<AppEnv>): ServiceDeps {
  const state = stateOf(c);
  const made: ServiceDeps = {
    get db() {
      return lifeDb(state);
    },
    env: state.env,
    defer: (p) => lifeDefer(state, p),
  };
  origins.set(made, state.core);
  return made;
}

/** The whole context as one object, for code that wants to pass it along. */
export function requestContext(c: Context<AppEnv>): RequestContext {
  const state = stateOf(c);
  return {
    requestId: state.requestId,
    ip: state.ip,
    colo: state.colo,
    get db() {
      return db(c);
    },
    get auth() {
      return auth(c);
    },
    get keys() {
      return keys(c);
    },
    settings: () => settings(c),
  };
}

/** The injected modules of this request. For this task's own middleware and services. */
export function coreOf(c: Context<AppEnv>): CoreDeps {
  return stateOf(c).core;
}

// ── Which CoreDeps a ServiceDeps came from (services/audit.ts needs `insertAudit`) ─────────────

const origins = new WeakMap<object, CoreDeps>();
let registered: CoreDeps | null = null;

/**
 * Remembers the injected modules for code that has no request: `runBackground` called without a
 * `core` argument, and `audit()` handed a `ServiceDeps` that was built by hand. `createApp` and
 * `createFilesHost` call it; the Worker entry builds both from one `CoreDeps`.
 */
export function registerCoreDeps(core: CoreDeps): void {
  registered = core;
}

/** The modules behind a `ServiceDeps`: its own when this module built it, else the registered ones. */
export function coreFor(source: ServiceDeps): CoreDeps {
  const core = origins.get(source) ?? registered;
  if (!core) throw new Error("no CoreDeps registered: createApp() has not run");
  return core;
}

// ── Queue and cron ────────────────────────────────────────────────────────────────────────────

/**
 * Runs `fn` with a full `BackgroundContext` — one pool for the whole batch or job run — then
 * drains the deferred work until none is left and closes the pool, also when `fn` throws.
 * `index.ts` wraps `queue()` and `scheduled()` with it; an admin "run job" route can give a job
 * the same context: `runBackground(c.env, c.executionCtx, (bg) => runJob(name, bg))` — note that
 * this opens a SECOND pool beside the request's own (a Worker may hold 6 connections at once and
 * each pool takes up to 5), so such a route should not also query through `db(c)` while it runs.
 */
export async function runBackground<T>(
  env: Env,
  ctx: WaitUntil,
  fn: (bg: BackgroundContext) => Promise<T>,
  core?: CoreDeps,
): Promise<T> {
  const used = core ?? registered;
  if (!used) throw new Error("no CoreDeps registered: createApp() has not run");
  const life = newLifetime(used, env, ctx);
  const bg: BackgroundContext = {
    get db() {
      return lifeDb(life);
    },
    env,
    defer: (p) => lifeDefer(life, p),
    get keys() {
      return lifeKeys(life);
    },
    settings: () => lifeSettings(life),
    metric,
    deferred: life.deferred,
  };
  origins.set(bg, used);
  try {
    return await fn(bg);
  } finally {
    await drainAndClose(life);
  }
}
