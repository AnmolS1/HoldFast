// Shared by the trash tests. Runs inside workerd, against this checkout's local Postgres and the
// local object store.
//
// Postgres is shared by every test file and every run: fixtures have random ids and nothing here
// counts a whole table. R2 is isolated per test FILE. Settings are passed in, never written.
//
// `api` is one request to the REAL app — the whole pipeline and the real routers — with a
// stand-in for the session lookup only (how a session is made has its own tests), as
// tests/unit/services-core/request.ts does for a single handler.
import { env } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { vi } from "vitest";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import { createDb, statementsSent, type Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import type { Settings } from "../../../src/worker/db/queries/settings";
import {
  auditLog,
  dmcaNoticeNodes,
  dmcaNotices,
  nodes,
  nodeVersions,
  pendingUserPurges,
  uploadParts,
  uploads,
  user,
} from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import {
  registerCoreDeps,
  resolveSettings,
  type BackgroundContext,
  type CoreDeps,
} from "../../../src/worker/services/request-context";
import { keyFor, thumbKey } from "../../../src/worker/services/storage";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { realCore, testDb } from "../auth/helpers";
import { makeUser, rand } from "../services-core/helpers";

export {
  auditRows,
  backendPid,
  baId,
  gate,
  makeFile,
  makeFolder,
  makeShare,
  makeUpload,
  makeUser,
  nodeById,
  putObject,
  rand,
  testDb,
  untilBlockedBy,
} from "../services-core/helpers";

export const TERMS = "2026-10";

const BASE_SETTINGS: Settings = {
  signupMode: "invite",
  termsVersion: TERMS,
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: {},
};

/** A verified user who has accepted the current terms: one who may change things. */
export const member = (overrides: Parameters<typeof makeUser>[0] = {}) =>
  makeUser({ termsVersion: TERMS, termsAcceptedAt: new Date(), ...overrides });

// ── requests ────────────────────────────────────────────────────────────────────────────────

export type Caller = { user: SessionUser; secondFactor?: boolean } | null;

export type ApiOptions = {
  method?: "GET" | "POST" | "DELETE";
  settings?: Settings;
  headers?: Record<string, string>;
  /** Cloudflare's request facts (`country`). */
  cf?: Record<string, unknown>;
  /** Replaces members of the injected modules (a failing `insertAudit`, a wrapped `createDb`). */
  core?: Partial<CoreDeps>;
  /** Bindings this request sees instead of the test environment's (a counting bucket). */
  env?: Record<string, unknown>;
};

export type Answer = {
  status: number;
  body: unknown;
  requestId: string | null;
  /** Every response header, by name. */
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
    impersonatedBy: null,
    secondFactorAt: caller.secondFactor ? new Date() : null,
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
    getSettings: async () => ({ ...BASE_SETTINGS, ...options.settings }),
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
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      origin: TEST_APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": "203.0.113.7",
      ...options.headers,
    },
  };
  if (options.cf) (init as { cf?: unknown }).cf = options.cf;
  const response = await app.fetch(
    new Request(`${TEST_APP_ORIGIN}/api${path}`, init),
    requestEnv as unknown as Env,
    ctx,
  );
  const statements = handle ? statementsSent((handle as ReturnType<typeof createDb>).db) : 0;
  while (pending.length) await Promise.allSettled(pending.splice(0));
  // The app was built over this call's modules; code with no request falls back to the last
  // registered ones, which must be the real ones again.
  registerCoreDeps(realCore);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const requestId =
    body && typeof body === "object" && "requestId" in body
      ? String((body as { requestId: unknown }).requestId)
      : null;
  return {
    status: response.status,
    body,
    requestId,
    headers: Object.fromEntries(response.headers.entries()),
    statements,
  };
}

/** An error answer without its request id: what two refusals are compared by. */
export function envelope(answer: Answer): unknown {
  if (!answer.body || typeof answer.body !== "object") return answer.body;
  const { requestId: _requestId, ...rest } = answer.body as Record<string, unknown>;
  void _requestId;
  return { status: answer.status, ...rest };
}

/** SQLSTATE 40P01, in the shape the driver reports it. */
export function deadlock(): Error {
  return Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" });
}

/**
 * A database handle whose first `failures` transactions end as deadlock victims: each runs its
 * work and is then rolled back with 40P01 — what Postgres does to the loser, whose statements up
 * to that point are thrown away. `attempts` counts every transaction started on the handle.
 */
export function deadlockingDb(failures = 1) {
  const made = createDb(env);
  const counter = { attempts: 0 };
  const real = made.db.transaction.bind(made.db);
  type Run = Parameters<typeof real>[0];
  (made.db as { transaction: unknown }).transaction = (run: Run, ...rest: unknown[]) => {
    counter.attempts += 1;
    if (counter.attempts > failures) return (real as (...args: unknown[]) => unknown)(run, ...rest);
    return real(async (tx) => {
      await run(tx);
      throw deadlock();
    });
  };
  return { ...made, counter };
}

// ── a background context ────────────────────────────────────────────────────────────────────

export type JobContext = {
  bg: BackgroundContext;
  /** Every `metric()` call: `[name, tags, value]`. */
  metric: ReturnType<typeof vi.fn>;
  /** `kind/outcome` of every job metric, in order. */
  outcomes(kind: string): string[];
  /** Waits for what the job deferred (audit rows). */
  settle(): Promise<void>;
};

/** What a job gets from `runBackground`, over the test database, with settings of the test's own. */
export function jobContext(
  options: { settings?: Settings; db?: Db; env?: Record<string, unknown> } = {},
): JobContext {
  registerCoreDeps(realCore);
  const deferred: Promise<unknown>[] = [];
  const metric = vi.fn();
  const resolved = resolveSettings(env, { ...BASE_SETTINGS, ...options.settings });
  const bg: BackgroundContext = {
    db: options.db ?? testDb(),
    env: { ...env, ...options.env } as unknown as Env,
    defer: (promise) => void deferred.push(promise),
    keys: createKeys(env.FILES_TOKEN_SECRET),
    settings: async () => resolved,
    metric: metric as unknown as BackgroundContext["metric"],
    deferred,
  };
  return {
    bg,
    metric,
    outcomes: (kind) =>
      metric.mock.calls
        .filter(([name, tags]) => name === "job" && (tags as { kind?: string }).kind === kind)
        .map(([, tags]) => String((tags as { outcome?: string }).outcome)),
    async settle() {
      while (deferred.length) await Promise.allSettled(deferred.splice(0));
    },
  };
}

export const cronEvent = (cron: string): ScheduledController => ({
  cron,
  scheduledTime: Date.now(),
  noRetry() {},
});

// ── rows ────────────────────────────────────────────────────────────────────────────────────

const db = () => testDb();

export async function userRow(id: string) {
  const [row] = await db().select().from(user).where(eq(user.id, id));
  return row ?? null;
}

export const usedBytes = async (id: string) => (await userRow(id))?.usedBytes ?? null;

export async function setUsedBytes(id: string, bytes: number) {
  await db().update(user).set({ usedBytes: bytes }).where(eq(user.id, id));
}

export async function nodesLeft(ids: string[]): Promise<string[]> {
  const rows = await db().select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, ids));
  return rows.map((row) => row.id).sort();
}

export async function setNode(id: string, values: Partial<typeof nodes.$inferInsert>) {
  await db().update(nodes).set(values).where(eq(nodes.id, id));
}

/** Moves a trashed root's purge date into the past: due now, with no clock moved. */
export async function makeDue(id: string) {
  await db()
    .update(nodes)
    .set({ purgeAfter: sql`now() - interval '1 minute'` })
    .where(eq(nodes.id, id));
}

/** The account as T06 leaves it when its deletion is confirmed: the date, and the pending row. */
export async function scheduleDeletion(userId: string, dueInDays: number) {
  const at = new Date(Date.now() + dueInDays * 86_400_000);
  await db().update(user).set({ deleteScheduledAt: at }).where(eq(user.id, userId));
  await db().insert(pendingUserPurges).values({ userId, scheduledFor: at });
}

export async function pendingPurge(userId: string) {
  const [row] = await db().select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId));
  return row ?? null;
}

/** A kept old version of a file, with a real key. `due`: its purge date passed yesterday. */
export async function makeVersion(
  file: { id: string; ownerId: string },
  overrides: { size?: number; due?: boolean } = {},
) {
  const versionId = uuidv7();
  const [row] = await db()
    .insert(nodeVersions)
    .values({
      nodeId: file.id,
      versionId,
      r2Key: keyFor(file.ownerId, file.id, versionId),
      size: overrides.size ?? 40,
      createdBy: file.ownerId,
      purgeAfter: new Date(Date.now() + (overrides.due ? -1 : 30) * 86_400_000),
    })
    .returning();
  return row!;
}

export async function versionsLeft(nodeId: string): Promise<string[]> {
  const rows = await db()
    .select({ versionId: nodeVersions.versionId })
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, nodeId));
  return rows.map((row) => row.versionId).sort();
}

export async function uploadRow(id: string) {
  const [row] = await db().select().from(uploads).where(eq(uploads.id, id));
  return row ?? null;
}

export async function partsOf(uploadId: string): Promise<number> {
  const rows = await db().select().from(uploadParts).where(eq(uploadParts.uploadId, uploadId));
  return rows.length;
}

/** An open DMCA notice that names the node — one of the gate's five causes. */
export async function openNoticeOn(nodeId: string): Promise<string> {
  const [notice] = await db()
    .insert(dmcaNotices)
    .values({ receivedVia: "email", status: "received" })
    .returning({ id: dmcaNotices.id });
  await db().insert(dmcaNoticeNodes).values({ noticeId: notice!.id, nodeId });
  return notice!.id;
}

export async function closeNotice(noticeId: string) {
  await db().update(dmcaNotices).set({ status: "closed" }).where(eq(dmcaNotices.id, noticeId));
}

/** The audit rows of one action about one target, oldest first. */
export async function audits(action: string, targetId: string) {
  return db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)))
    .orderBy(auditLog.at, auditLog.id);
}

// ── objects ─────────────────────────────────────────────────────────────────────────────────

/** Every key under a prefix, sorted. This file's own bucket: R2 is isolated per test file. */
export async function keysUnder(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export async function objectExists(key: string): Promise<boolean> {
  return (await env.FILES.head(key)) !== null;
}

/** The bucket, with the name of every method called on it recorded. */
export function countingBucket() {
  const calls: string[] = [];
  const bucket = new Proxy(env.FILES, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket, calls };
}

/** Stores the file's object and one thumbnail for its current version. Returns both keys. */
export async function storeFile(file: { id: string; r2Key: string | null; versionId: string | null }) {
  const thumb = thumbKey(file.id, file.versionId!, 320);
  await env.FILES.put(file.r2Key!, `content-${rand()}`);
  await env.FILES.put(thumb, "thumb");
  return { object: file.r2Key!, thumb };
}

export async function storeVersion(version: { nodeId: string; versionId: string; r2Key: string }) {
  const thumb = thumbKey(version.nodeId, version.versionId, 320);
  await env.FILES.put(version.r2Key, `old-${rand()}`);
  await env.FILES.put(thumb, "old-thumb");
  return { object: version.r2Key, thumb };
}

/** A multipart upload in the store, with one part. Returns its id. */
export async function startMultipart(key: string): Promise<string> {
  const upload = await env.FILES.createMultipartUpload(key);
  await upload.uploadPart(1, new Uint8Array(16));
  return upload.uploadId;
}

/** True while the multipart upload still exists (a part can still be added to it). */
export async function multipartIsOpen(key: string, uploadId: string): Promise<boolean> {
  try {
    await env.FILES.resumeMultipartUpload(key, uploadId).uploadPart(2, new Uint8Array(16));
    return true;
  } catch {
    return false;
  }
}
