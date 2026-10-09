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
// BOUNDS. Waiting "until nothing is left" is bounded three ways, so no deferred task can hold the
// pool or the invocation open:
//   DRAIN_DEADLINE_MS     20 s for the WHOLE drain, counted from when the handler returned. The
//                         platform gives `waitUntil` 30 s after the response, shared by every
//                         call of one request, and cancels what is left ("`ctx.waitUntil()` can
//                         extend execution for up to 30 seconds after the response is sent or the
//                         client disconnects … If any Promises have not settled after 30 seconds,
//                         they are canceled" — developers.cloudflare.com/workers/runtime-apis/
//                         context/#waituntil). At the deadline the pool is closed regardless —
//                         forcibly, connections still lent out included — and the number of
//                         abandoned tasks is logged and counted. The 10 s left are for the close.
//   CLOSE_DEADLINE_MS     3 s for the close itself. A plain close waits for every connection to
//                         come back, so it can hang on a connection something still holds: when
//                         it has not returned in 3 s it is forced, and the forced close gets 3 s
//                         more. If even that does not return, the fact is logged and counted and
//                         the invocation ends anyway. 20 + 3 + 3 s stays inside the 30.
//   MAX_DEFERRED_TASKS    100 `defer` calls per invocation.
//   MAX_DEFER_ROUNDS      8 drain passes: work deferred by deferred work, eight levels deep.
// Past either cap `defer()` throws `DEFER_LIMIT` and does not register the promise — a task that
// re-defers itself forever stops there. Queue and cron runs (`runBackground`) have the same three
// bounds on what they defer; the work a job awaits itself is not deferred work and is bounded by
// the platform's 15 minutes. So: deferred work is for short follow-ups (an audit row, a metric,
// a mail) that finish well inside 20 s. Anything longer goes to a queue.
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
import { metric, writeMetric } from "./metrics";

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

/** The only part of an ExecutionContext the auth layer gets, backed by `defer`. */
export type AuthContext = Pick<ExecutionContext, "waitUntil" | "passThroughOnException">;

/** What a service that can run outside a request takes as its first argument. */
export type ServiceDeps = {
  db: Db;
  env: Env;
  defer(p: Promise<unknown>): void;
};

/** The concrete modules injected into the apps. Only the Worker entry imports them. */
export type CoreDeps = {
  /** Overrides of the drain bounds. For tests only (a 20 s deadline cannot be waited for). */
  limits?: Partial<DeferLimits>;
  createDb: typeof createDb;
  /**
   * `ctx` is NOT the Worker's ExecutionContext: its `waitUntil` is this request's `defer`, so
   * whatever the auth layer hands to it is drained before the pool closes (and is subject to
   * the same bounds). The raw context is never given out.
   */
  createAuth: (env: Env, db: Db, ctx: AuthContext) => Auth;
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
export const DEFER_LIMIT = "too much deferred work in one invocation";

/** The whole drain, from the moment the handler returned. Under the platform's 30 s. */
export const DRAIN_DEADLINE_MS = 20_000;
/** `defer` calls per invocation. */
export const MAX_DEFERRED_TASKS = 100;
/** Drain passes per invocation: how deep deferred work may defer more work. */
export const MAX_DEFER_ROUNDS = 8;

/** One close attempt (plain, then forced). */
export const CLOSE_DEADLINE_MS = 3_000;

export type DeferLimits = {
  drainDeadlineMs: number;
  closeDeadlineMs: number;
  maxDeferredTasks: number;
  maxDeferRounds: number;
};

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
  limits: DeferLimits;
  deferred: Promise<unknown>[];
  /** `defer` calls accepted so far, and how many of their promises have not settled. */
  accepted: number;
  unsettled: number;
  /** The drain pass that is running (0 = the handler has not returned yet). */
  round: number;
  /** Set once the drain loop has ended and `close()` is about to run. Nothing is accepted after it. */
  closed: boolean;
  handle: ReturnType<typeof createDb> | null;
  keys: Keys | null;
  settings: Promise<ResolvedSettings> | null;
};

function newLifetime(core: CoreDeps, env: Env, ctx: WaitUntil): Lifetime {
  const limits: DeferLimits = {
    drainDeadlineMs: DRAIN_DEADLINE_MS,
    closeDeadlineMs: CLOSE_DEADLINE_MS,
    maxDeferredTasks: MAX_DEFERRED_TASKS,
    maxDeferRounds: MAX_DEFER_ROUNDS,
    ...core.limits,
  };
  return {
    core,
    env,
    ctx,
    limits,
    deferred: [],
    accepted: 0,
    unsettled: 0,
    round: 0,
    closed: false,
    handle: null,
    keys: null,
    settings: null,
  };
}

function lifeDb(life: Lifetime): Db {
  if (life.closed) throw new Error(CONTEXT_CLOSED);
  life.handle ??= life.core.createDb(life.env);
  return life.handle.db;
}

function lifeDefer(life: Lifetime, p: Promise<unknown>): void {
  // Work registered on a pool that is closing cannot be honoured; say so instead of losing it.
  if (life.closed) {
    p.catch(() => {});
    throw new Error(CONTEXT_CLOSED);
  }
  // Past a cap the promise is NOT registered: nothing waits for it and the pool will not stay
  // open for it. Throwing is what stops a task that re-defers itself forever.
  const tooMany = life.accepted >= life.limits.maxDeferredTasks;
  const tooDeep = life.round >= life.limits.maxDeferRounds;
  if (tooMany || tooDeep) {
    p.catch(() => {});
    writeMetric(life.env, "error", { kind: "defer_refused", reason: tooMany ? "tasks" : "rounds" });
    console.warn(`defer() refused: ${tooMany ? "task" : "round"} limit reached`);
    throw new Error(DEFER_LIMIT);
  }
  life.accepted += 1;
  life.unsettled += 1;
  const settled = () => {
    life.unsettled -= 1;
  };
  p.then(settled, settled);
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
 *
 * The loop is bounded (see BOUNDS in the header): one deadline for the whole drain, after which
 * the pool is closed whatever is still running, and `lifeDefer` refuses work past the pass limit.
 * A per-task timeout would not be a bound — tasks can be many, and can defer more.
 */
async function drainAndClose(life: Lifetime): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), life.limits.drainDeadlineMs);
  });
  let abandoned = 0;
  try {
    while (life.deferred.length) {
      life.round += 1;
      const pass = Promise.allSettled(life.deferred.splice(0)).then(() => "settled" as const);
      if ((await Promise.race([pass, deadline])) === "deadline") {
        abandoned = life.unsettled;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    life.closed = true;
    life.deferred.length = 0;
  }
  if (abandoned > 0) {
    // The count only: never what the tasks were.
    writeMetric(life.env, "error", { kind: "deferred_abandoned" }, abandoned);
    console.warn(`deferred work abandoned at the drain deadline: ${abandoned} task(s) had not settled`);
  }
  await closeWithin(life, abandoned > 0);
}

/** True when `work` settled (either way) within `ms`. Never rejects, never leaves a rejection unhandled. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = work.then(
    () => true as const,
    () => true as const,
  );
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Closes the pool, in bounded time whatever state its connections are in. Forced straight away
 * when deferred tasks were abandoned (one of them may hold a connection); otherwise a plain close
 * first, forced only if that does not return. Never throws: this runs inside `waitUntil` and in
 * a `finally`, where a rejection would be unhandled or would mask the handler's own error.
 */
async function closeWithin(life: Lifetime, force: boolean): Promise<void> {
  const handle = life.handle;
  if (!handle) return;
  const ms = life.limits.closeDeadlineMs;
  if (!force && (await settledWithin(handle.close(), ms))) return;
  if (!force) {
    writeMetric(life.env, "error", { kind: "pool_close", reason: "forced" });
    console.warn("the database pool did not close in time: forcing it");
  }
  if (await settledWithin(handle.close({ force: true }), ms)) return;
  writeMetric(life.env, "error", { kind: "pool_close", reason: "abandoned" });
  console.warn("the database pool did not close even when forced: abandoning it");
}

// ── Request path ──────────────────────────────────────────────────────────────────────────────

type RequestState = Lifetime & {
  requestId: string;
  ip: string;
  colo: string | null;
  auth: Auth | null;
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
  states.set(c, { ...newLifetime(core, c.env, ctx), ...eager, auth: null });
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
  state.auth ??= state.core.createAuth(state.env, lifeDb(state), {
    waitUntil: (promise) => lifeDefer(state, promise),
    // Fail-open to the origin makes no sense for this Worker (there is no origin behind it).
    passThroughOnException: () => {},
  });
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
