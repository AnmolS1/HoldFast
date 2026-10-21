// Shared by the sharing tests. Runs inside workerd, against this checkout's local Postgres.
//
// Postgres is shared by every test file and every run: fixtures have random ids and nothing here
// counts a whole table. Settings are passed in with each request, never written.
//
// `api` is one request to the REAL app — the whole pipeline and the real routers — with a
// stand-in for the session lookup only (how a session is made has its own tests), as
// tests/unit/trash/helpers.ts does; this one also sends a JSON body and lets a test choose the
// client address.
import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import { createDb, statementsSent } from "../../../src/worker/db/client";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { downloadLedger, linkAccessLog, shareLinks, shares } from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import { registerCoreDeps, type CoreDeps } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { realCore, testDb } from "../auth/helpers";
import { makeUser } from "../services-core/helpers";

export {
  auditRows,
  baId,
  makeFile,
  makeFolder,
  makeShare,
  makeUser,
  nodeById,
  rand,
  serviceDeps,
  testDb,
} from "../services-core/helpers";
export { linkById, mailTo, makeLink, makePendingShare, shareById } from "../auth/helpers";

export const TERMS = "2026-10";

export const BASE_SETTINGS: Settings = {
  signupMode: "invite",
  termsVersion: TERMS,
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: {},
};

/**
 * Ceilings that never get in the way of a test about something else: an account is not "new"
 * (so no factor shrinks a limit) and the daily counts are large. A test about a ceiling sets its
 * own key over these.
 */
export const ROOMY: NonNullable<Settings["ceilings"]> = {
  NEW_ACCOUNT_DAYS: 0,
  CEIL_SHARES_DAY: 10_000,
  CEIL_LINKS_DAY: 10_000,
  CEIL_LINK_DOWNLOADS_DAY: 10_000,
  CEIL_LINK_BYTES_DAY: 1_000_000_000_000,
  CEIL_OWNER_LINK_BYTES_DAY: 1_000_000_000_000,
  CEIL_IP_BYTES_DAY: 1_000_000_000_000,
};

/** Settings with roomy ceilings, and `ceilings` merged over them. */
export function settingsWith(over: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...over, ceilings: { ...ROOMY, ...over.ceilings } };
}

/** A verified user who has accepted the current terms: one who may change things. */
export const member = (overrides: Parameters<typeof makeUser>[0] = {}) =>
  makeUser({ termsVersion: TERMS, termsAcceptedAt: new Date(), ...overrides });

/** The made-up keys the test environment's files-token secret derives. */
export const testKeys = () => createKeys(env.FILES_TOKEN_SECRET);

// ── requests ────────────────────────────────────────────────────────────────────────────────

export type Caller = { user: SessionUser; impersonatedBy?: string } | null;

export type ApiOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  json?: unknown;
  settings?: Settings;
  headers?: Record<string, string>;
  /** The client address (`cf-connecting-ip`). */
  ip?: string;
  /** Cloudflare's request facts (`country`). */
  cf?: Record<string, unknown>;
  /** Bindings this request sees instead of the test environment's (a limiter that refuses). */
  env?: Record<string, unknown>;
  /** Replaces members of the injected modules. */
  core?: Partial<CoreDeps>;
};

export type Answer = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** SQL statements the request had sent when its answer existed. */
  statements: number;
};

const allow = { limit: async () => ({ success: true }) };

function sessionFor(caller: NonNullable<Caller>): SessionInfo {
  return {
    id: "s".repeat(32),
    userId: caller.user.id,
    token: "made-up-session-token",
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    impersonatedBy: caller.impersonatedBy ?? null,
    secondFactorAt: null,
  };
}

/** One request by `caller` (null = signed out). Everything it deferred has happened on return. */
export async function api(caller: Caller, path: string, options: ApiOptions = {}): Promise<Answer> {
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: {
      getSession: async () => (caller ? { session: sessionFor(caller), user: caller.user } : null),
    },
  };
  let handle: ReturnType<typeof createDb> | null = null;
  const make = options.core?.createDb ?? createDb;
  const core: CoreDeps = {
    ...realCore,
    createAuth: () => auth,
    getSettings: async () => options.settings ?? settingsWith(),
    ...options.core,
    createDb: (...args) => (handle = make(...args)),
  };
  const app = createApp(core);
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
  };
  const method = options.method ?? (options.json === undefined ? "GET" : "POST");
  const init: RequestInit = {
    method,
    headers: {
      origin: TEST_APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": options.ip ?? "203.0.113.7",
      ...(options.json === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  };
  if (options.cf) (init as { cf?: unknown }).cf = options.cf;
  const response = await app.fetch(
    new Request(`${TEST_APP_ORIGIN}/api${path}`, init),
    requestEnv as unknown as Env,
    ctx,
  );
  const statements = handle ? statementsSent((handle as ReturnType<typeof createDb>).db) : 0;
  while (pending.length) await Promise.allSettled(pending.splice(0));
  registerCoreDeps(realCore);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: response.status,
    body,
    headers: Object.fromEntries(response.headers.entries()),
    statements,
  };
}

/** An answer without its request id: what two refusals are compared by. */
export function envelope(answer: Answer): unknown {
  if (!answer.body || typeof answer.body !== "object") return { status: answer.status, body: answer.body };
  const { requestId: _requestId, ...rest } = answer.body as Record<string, unknown>;
  void _requestId;
  return { status: answer.status, ...rest };
}

export const asCaller = (user: SessionUser): Caller => ({ user });

/** The `error` / `details` of an error answer. */
export function errorOf(answer: Answer): { error?: string; details?: Record<string, unknown> } {
  return (answer.body ?? {}) as { error?: string; details?: Record<string, unknown> };
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────

export async function sharesOn(nodeId: string) {
  return testDb().select().from(shares).where(eq(shares.nodeId, nodeId));
}

export async function linksOn(nodeId: string) {
  return testDb().select().from(shareLinks).where(eq(shareLinks.nodeId, nodeId));
}

export async function accessLog(linkId: string) {
  return testDb().select().from(linkAccessLog).where(eq(linkAccessLog.linkId, linkId));
}

/** Today's (or `day`'s) ledger row of one subject: bytes and count, zeros when there is none. */
export async function ledgerOf(subjectType: string, subjectId: string, day: string) {
  const [row] = await testDb()
    .select({ bytes: downloadLedger.bytes, count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, day),
        sql`${downloadLedger.subjectType} = ${subjectType}`,
        eq(downloadLedger.subjectId, subjectId),
      ),
    );
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.count ?? 0) };
}

export const utcDayOf = (date: Date) => date.toISOString().slice(0, 10);
