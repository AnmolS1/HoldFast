// CONTRACT STUB (contracts-0). Owner: T07 (worker core), which replaces the accessor bodies and
// fills in the members marked `unknown` below. Until then these are types and signatures only.
//
// The accessors are how every route reaches the database and auth; there is no `c.var.db`.
// Services that can run outside a request take a `ServiceDeps`, never a Hono context.

import type { Context } from "hono";
import type { Auth, SessionInfo, SessionUser } from "../auth/types";
import type { createDb, Db } from "../db/client";
import type { insertAudit } from "../db/queries/audit";
import type { getSettings, Settings } from "../db/queries/settings";
import type { termsVersionOf } from "../db/queries/users";

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

/** One per request. `db`, `auth`, `keys` and `settings` are lazy and memoized. */
export type RequestContext = {
  requestId: string;
  ip: string;
  colo: string | null;
  db: Db;
  auth: Auth;
  /** The purpose keys. Their type belongs to `services/keys.ts`, which is not written yet. */
  keys: unknown;
  settings: Settings;
};

/** What queue and cron code gets. It is a `ServiceDeps`. */
export type BackgroundContext = ServiceDeps & {
  /** The purpose keys. Their type belongs to `services/keys.ts`, which is not written yet. */
  keys: unknown;
  settings: Settings;
  /** Narrowed to the metric names and tags of `services/metrics.ts` once that file exists. */
  metric(name: string, tags: Record<string, unknown>, value?: number): void;
  /** Promises registered through `defer`, drained before the pool closes. */
  deferred: Promise<unknown>[];
};

export function db(c: Context<AppEnv>): Db {
  void c;
  throw new Error("not implemented: T07");
}

export function auth(c: Context<AppEnv>): Auth {
  void c;
  throw new Error("not implemented: T07");
}

export function keys(c: Context<AppEnv>): unknown {
  void c;
  throw new Error("not implemented: T07");
}

export function settings(c: Context<AppEnv>): Settings {
  void c;
  throw new Error("not implemented: T07");
}

export function defer(c: Context<AppEnv>, p: Promise<unknown>): void {
  void c;
  void p;
  throw new Error("not implemented: T07");
}

export function deps(c: Context<AppEnv>): ServiceDeps {
  void c;
  throw new Error("not implemented: T07");
}
