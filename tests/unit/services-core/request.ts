// Runs a piece of code inside a REAL request: the whole pipeline of the app host, the real
// database, the real request context — with a session the test chooses. The context-taking
// services (permissions, ceilings) are called from request handlers only, so that is where they
// are tested.
//
// The auth instance is a stand-in that answers `getSession` with the given session (how a
// session is made and checked has its own tests); everything else is exactly what the Worker
// entry injects. Settings are the test's own, never the shared table.
import { env } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import type { Tx } from "../../../src/worker/db/client";
import type { Settings } from "../../../src/worker/db/queries/settings";
import type { AppEnv, CoreDeps } from "../../../src/worker/services/request-context";
import {
  ceilingExceeded,
  consumeCeiling,
  type Amount,
  type CeilingResult,
  type CeilingSubject,
  type LedgerOnlyKind,
} from "../../../src/worker/services/ceilings";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { realCore } from "../auth/helpers";

// Both forms of `consumeCeiling` as one signature, for the helper at the end of this file.
const consumeAny = consumeCeiling as (
  c: Context<AppEnv>,
  kind: LedgerOnlyKind | "link_user",
  subject: CeilingSubject,
  amount: Amount,
  opts?: { tx: Tx },
) => Promise<CeilingResult>;

export type Caller = { user: SessionUser; impersonatedBy?: string } | null;

export type InvokeOptions = {
  settings?: Settings;
  env?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type Invoked<T> =
  | { ok: true; status: 200; value: T; headers: Headers }
  | {
      ok: false;
      status: number;
      error: string;
      details?: Record<string, unknown>;
      message: string;
      headers: Headers;
    };

type Work = (c: Context<AppEnv>) => Promise<unknown>;

const BASE_SETTINGS: Settings = {
  signupMode: "invite",
  termsVersion: "2026-10",
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: {},
};
const allow = { limit: async () => ({ success: true }) };

/** A session row for the user, as the session lookup would return it. */
function sessionFor(caller: NonNullable<Caller>): SessionInfo {
  return {
    id: "s".repeat(32),
    userId: caller.user.id,
    token: "made-up-session-token",
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    impersonatedBy: caller.impersonatedBy ?? null,
  };
}

/**
 * Runs `work` as the handler of one GET request made by `caller` (null = signed out) and returns
 * what it returned — or the error envelope the app answered with.
 */
export async function invoke<T>(
  caller: Caller,
  work: (c: Context<AppEnv>) => Promise<T>,
  options: InvokeOptions = {},
): Promise<Invoked<T>> {
  let result: { value: unknown } | null = null;
  const router = new Hono<AppEnv>();
  const run: Work = work;
  router.get("/_services-core", async (c) => {
    result = { value: await run(c) };
    return c.json({ done: true });
  });
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: {
      getSession: async () => (caller ? { session: sessionFor(caller), user: caller.user } : null),
    },
  };
  const core: CoreDeps = {
    ...realCore,
    createAuth: () => auth,
    getSettings: async () => ({ ...BASE_SETTINGS, ...options.settings }),
  };
  const app = createApp(core, { extraRouters: [router] });

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const requestEnv = {
    ...env,
    RL_AUTH: allow,
    RL_API: allow,
    RL_FILES: allow,
    RL_LINKS: allow,
    ...options.env,
  } as unknown as Env;
  const response = await app.fetch(
    new Request(`${TEST_APP_ORIGIN}/api/_services-core`, { headers: options.headers }),
    requestEnv,
    ctx,
  );
  while (pending.length) await Promise.allSettled(pending.splice(0));

  if (response.status === 200 && result) {
    await response.arrayBuffer();
    return { ok: true, status: 200, value: (result as { value: T }).value, headers: response.headers };
  }
  const body = (await response.json()) as {
    error: string;
    message: string;
    details?: Record<string, unknown>;
  };
  return {
    ok: false,
    status: response.status,
    error: body.error,
    message: body.message,
    details: body.details,
    headers: response.headers,
  };
}

/** The value, or a thrown error that says what the app answered instead. */
export async function value<T>(
  caller: Caller,
  work: (c: Context<AppEnv>) => Promise<T>,
  options: InvokeOptions = {},
): Promise<T> {
  const invoked = await invoke(caller, work, options);
  if (!invoked.ok) throw new Error(`the request failed: ${invoked.status} ${invoked.error}`);
  return invoked.value;
}

/**
 * `consumeCeiling` the way a route uses it: look at the answer, and throw the 429 on a refusal.
 * (`consumeCeiling` itself ANSWERS; a caller that did not look would have enforced nothing.)
 */
export async function consumeOrThrow(...args: Parameters<typeof consumeAny>): Promise<void> {
  const result = await consumeAny(...args);
  if (!result.ok) throw ceilingExceeded(result);
}
