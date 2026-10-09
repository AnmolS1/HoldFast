// What one request's Better Auth instance and its hooks share. `createAuth` builds one of these
// per call — that is, per request: nothing here outlives the request, so plain mutable fields
// are safe where module scope would not be.
//
// The hooks get no Hono context (Better Auth calls them with its own endpoint context), so the
// route puts what only it knows — the client address the pipeline resolved, Cloudflare's `cf`
// facts — on `client` before it calls the handler, and reads `facts` afterwards to write the
// audit rows and send the security emails (auth/audit.ts).

import type { Db } from "../db/client";
import type { SignupReservation } from "../db/queries/auth-lifecycle";
import { getSettings } from "../db/queries/settings";
import { createKeys, type Keys } from "../services/keys";
import {
  resolveSettings,
  type AuthContext,
  type ResolvedSettings,
  type ServiceDeps,
} from "../services/request-context";

export type ClientFacts = {
  ip: string;
  asn: number | null;
  country: string | null;
  userAgent: string | null;
};

export type NewSession = {
  id: string;
  userId: string;
  impersonatedBy: string | null;
  country: string | null;
  uaFamily: string | null;
};

export type AuthFacts = {
  /** The matched endpoint of the HTTP request being handled (`/callback/:id`), or null. */
  endpointPath: string | null;
  /** Sessions created while handling the request, in order. */
  newSessions: NewSession[];
  createdUserId: string | null;
  passwordResetUserId: string | null;
  emailChangedUserId: string | null;
  /** The admin gate refused the request (it has written its own audit row). */
  adminDenied: boolean;
};

export type AuthScope = {
  env: Env;
  db: Db;
  keys: Keys;
  /** The request's `defer`: drained before the pool closes. */
  deps: ServiceDeps;
  /** Fresh from the table once per request — sign-up gates must not lag a kill switch by 60 s. */
  settings(): Promise<ResolvedSettings>;
  client: ClientFacts | null;
  facts: AuthFacts;
  /** What the sign-up in flight has taken, until its user exists. */
  reservation: { taken: SignupReservation; email: string } | null;
  /** One entry per `user` update in flight that touches `banned` or the address (hooks.ts). */
  userUpdates: Array<{ banned?: boolean; address?: boolean; emailChanged?: boolean }>;
  /** Memo of the per-domain sign-up check (the MX lookup is made once per request). */
  domainChecks: Map<string, Promise<string | null>>;
};

export function emptyFacts(): AuthFacts {
  return {
    endpointPath: null,
    newSessions: [],
    createdUserId: null,
    passwordResetUserId: null,
    emailChangedUserId: null,
    adminDenied: false,
  };
}

export function createScope(env: Env, db: Db, ctx: AuthContext): AuthScope {
  let settings: Promise<ResolvedSettings> | null = null;
  return {
    env,
    db,
    keys: createKeys(env.FILES_TOKEN_SECRET),
    deps: {
      db,
      env,
      // Read at call time and never as a method call on `ctx` in source: `ctx.waitUntil` IS the
      // request's `defer` (services/request-context.ts), not the Worker's raw waitUntil.
      defer: (promise) => Reflect.apply(ctx.waitUntil, ctx, [promise]),
    },
    settings: () =>
      (settings ??= getSettings(db, { fresh: true }).then((stored) => resolveSettings(env, stored))),
    client: null,
    facts: emptyFacts(),
    reservation: null,
    userUpdates: [],
    domainChecks: new Map(),
  };
}
