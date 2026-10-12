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
  /** The address of the user row this request is creating (set before the row exists), or null. */
  signingUpEmail: string | null;
  /** A provider identity is being linked to an account that already existed (hooks.ts). */
  linking: { userId: string; providerId: string; cleaned: boolean; swept?: boolean } | null;
  /** The user whose passkey sign-in in this request counts as a second factor (auth/second-factor.ts). */
  passkeySecondFactorFor: string | null;
  /** The two-factor code this request is answering with (auth/second-factor.ts). */
  secondFactor: {
    userId: string;
    sessionId: string | null;
    mode: "sign_in" | "step_up" | "enrolment";
    method: "totp" | "backup_code";
    /** The budget this attempt was counted on, and whether it is a known device's own. */
    budget: { key: string; known: boolean };
    /** This attempt used the last one its budget had in the window. */
    exhaustedNow: boolean;
    grantsNewSession: boolean;
    /** Positive proof that THIS request presented a valid factor (auth/second-factor.ts). */
    proved: boolean;
    /** The stored backup codes before the endpoint ran (a used code changes them). */
    backupCodesBefore: string | null;
    email: string;
    name: string;
  } | null;
  /** The admin whose impersonation this request is ending. */
  impersonatorId: string | null;
  /** The sign-in throttle turned this request away (auth/signin-throttle.ts). */
  throttled: boolean;
  /** The throttle's pair key of the sign-in attempt in flight, to give back if it succeeds. */
  signInAttempt: string | null;
  /**
   * The address this request has shown to be the CALLER'S OWN — by its session, by the sign-up
   * browser's proof, or by being that sign-up (auth/hooks.ts): mail to it is counted on the
   * address's own budget (services/email.ts "WHOSE BUDGET"). Null: a stranger's request.
   */
  ownAddress: { email: string; accountId: string } | null;
  /**
   * A cleanup that takes trust away failed twice (auth/second-factor.ts `cleanUpOrFlag`): the
   * route answers 5xx — after the audit row and the notice, never instead of them.
   */
  cleanupFailed: boolean;
  /** The kinds of unauthenticated mail this request has caused to be sent (services/email.ts). */
  mailed: string[];
  /** This request verified the right password for the account of `signInAttempt`. */
  signInProved: boolean;
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
  /**
   * `password` of the body of a request that needs the owner AGAIN (`/change-email`,
   * `/unlink-account`, the passkey management endpoints), as the route read it before the
   * handler ran (auth/mailbox-proof.ts `ownerAgain`; Better Auth's schemas for those endpoints
   * do not know the field). Beside `client`, not in `facts`: the handler starts each request
   * with fresh facts.
   */
  reauthPassword?: unknown;
  facts: AuthFacts;
  /** What the sign-up in flight has taken, until its user exists. */
  reservation: { taken: SignupReservation; email: string } | null;
  /** One entry per `user` update in flight that touches `banned` or the address (hooks.ts). */
  userUpdates: Array<{ banned?: boolean; address?: boolean; emailChanged?: boolean }>;
  /** Memo of the per-domain sign-up check (the MX lookup is made once per request). */
  domainChecks: Map<string, Promise<string | null>>;
  /**
   * "The request has been answered." Mail that an auth request causes is sent only after this
   * (`afterAnswer`): work that started earlier would run beside the request's own — more round
   * trips before the answer exactly when there is somebody to mail (auth/parity.ts). The route
   * holds it (`held`) until the answer is complete; a handler called without the route releases
   * it when it returns.
   */
  answered: { promise: Promise<void>; release(): void; held: boolean };
};

/**
 * `work`, started once the request has been answered — as a promise for the request's deferred
 * work (`scope.deps.defer(afterAnswer(scope, () => send…()))`).
 */
export function afterAnswer<T>(scope: AuthScope, work: () => Promise<T>): Promise<T> {
  return scope.answered.promise.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).then(work);
}

export function emptyFacts(): AuthFacts {
  return {
    endpointPath: null,
    newSessions: [],
    createdUserId: null,
    passwordResetUserId: null,
    emailChangedUserId: null,
    adminDenied: false,
    signingUpEmail: null,
    linking: null,
    passkeySecondFactorFor: null,
    secondFactor: null,
    impersonatorId: null,
    throttled: false,
    signInAttempt: null,
    signInProved: false,
    ownAddress: null,
    cleanupFailed: false,
    mailed: [],
  };
}

function answerGate(): AuthScope["answered"] {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release, held: false };
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
    answered: answerGate(),
  };
}
