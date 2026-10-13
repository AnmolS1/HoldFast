// Shared by the search / recent / starred tests: one GET against the REAL routes, behind the real
// pipeline and the real database, as a caller the test chooses.
//
// Built the way tests/unit/services-core/request.ts#invoke is — a stand-in auth instance that
// answers `getSession` with the given user, settings that are the test's own (never the shared
// table) — but it fetches the route itself instead of running a callback.
import { env } from "cloudflare:workers";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionUser } from "../../../src/worker/auth/types";
import type { Settings } from "../../../src/worker/db/queries/settings";
import type { CoreDeps } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { realCore } from "../auth/helpers";

export type Caller = { user: SessionUser } | null;

export type Answer = {
  status: number;
  /** The parsed JSON body, whatever it is. */
  body: unknown;
  /** The body as it was sent. */
  text: string;
  /** Every data point the request wrote to the metrics binding. */
  metrics: unknown[];
};

const SETTINGS: Settings = {
  signupMode: "invite",
  termsVersion: "2026-10",
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: {},
};
const allow = { limit: async () => ({ success: true }) };

/** `GET /api<path>` as `caller` (null = signed out). Deferred work has finished when it returns. */
export async function get(caller: Caller, path: string): Promise<Answer> {
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: {
      getSession: async () =>
        caller
          ? {
              session: {
                id: "s".repeat(32),
                userId: caller.user.id,
                token: "made-up-session-token", // not a credential: the stand-in never checks it
                expiresAt: new Date(Date.now() + 3_600_000),
                createdAt: new Date(),
                updatedAt: new Date(),
                impersonatedBy: null,
                secondFactorAt: null,
              },
              user: caller.user,
            }
          : null,
    },
  };
  const core: CoreDeps = { ...realCore, createAuth: () => auth, getSettings: async () => SETTINGS };
  const app = createApp(core);

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const metrics: unknown[] = [];
  const requestEnv = {
    ...env,
    RL_AUTH: allow,
    RL_API: allow,
    RL_FILES: allow,
    RL_LINKS: allow,
    METRICS: { writeDataPoint: (point: unknown) => void metrics.push(point) },
  } as unknown as Env;

  const response = await app.fetch(new Request(`${TEST_APP_ORIGIN}/api${path}`), requestEnv, ctx);
  while (pending.length) await Promise.allSettled(pending.splice(0));
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the test sees `text`.
  }
  return { status: response.status, body, text, metrics };
}

/** The query string for a search. */
export const searchPath = (params: Record<string, string | number>) =>
  `/search?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
