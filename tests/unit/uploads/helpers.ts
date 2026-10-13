// Shared by the upload tests. Every request goes through the REAL app — the whole pipeline, the
// real database and the local object store — with a session the test chooses and settings and
// vars of its own (never the shared `settings` table). Postgres is shared by every test file:
// every fixture has random ids and no test counts a whole table.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { PART_BYTES } from "../../../src/shared/constants";
import type { InitUploadBody, InitUploadResponse } from "../../../src/shared/schemas/upload";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import type { Db } from "../../../src/worker/db/client";
import { pgError } from "../../../src/worker/db/errors";
import type { Settings } from "../../../src/worker/db/queries/settings";
import {
  auditLog,
  downloadLedger,
  strikes,
  uploadParts,
  uploads,
  user as userTable,
} from "../../../src/worker/db/schema";
import type { CoreDeps } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { realCore, testDb } from "../auth/helpers";
import { makeUser, rand } from "../services-core/helpers";

export const MIB = 1_048_576;
export const TERMS = "2026-10";
/** Old enough that no new-account factor applies. */
export const LONG_AGO = new Date("2025-01-01T00:00:00.000Z");
export const GB = 1_000_000_000;

/** Limits far above anything a test uploads; a test about a ceiling passes its own. */
export const ROOMY: Settings = {
  signupMode: "invite",
  termsVersion: TERMS,
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: {
    CEIL_UPLOAD_BYTES_DAY: 100 * GB,
    CEIL_UPLOAD_COUNT_DAY: 100_000,
    CEIL_EDITOR_UPLOAD_BYTES_DAY: 100 * GB,
  },
};

export type UserRow = typeof userTable.$inferSelect;

/** A verified user with accepted terms, an account older than the new-account window and room. */
export async function uploader(overrides: Partial<typeof userTable.$inferInsert> = {}): Promise<UserRow> {
  return makeUser({ termsVersion: TERMS, createdAt: LONG_AGO, quotaBytes: 10 * GB, ...overrides });
}

export async function userRow(id: string): Promise<UserRow> {
  const [row] = await testDb().select().from(userTable).where(eq(userTable.id, id));
  return row!;
}

export const usedBytes = async (id: string) => (await userRow(id)).usedBytes;

export async function sessionRow(id: string) {
  const [row] = await testDb().select().from(uploads).where(eq(uploads.id, id));
  return row ?? null;
}

export const sessionsOf = (uploaderId: string) =>
  testDb().select().from(uploads).where(eq(uploads.uploaderId, uploaderId));

export const partRows = (uploadId: string) =>
  testDb()
    .select()
    .from(uploadParts)
    .where(eq(uploadParts.uploadId, uploadId))
    .orderBy(uploadParts.partNumber);

export const strikesOf = (userId: string) =>
  testDb().select().from(strikes).where(eq(strikes.userId, userId));

export const ledgerOf = (subjectType: "upload_user" | "upload_editor", subjectId: string) =>
  testDb()
    .select()
    .from(downloadLedger)
    .where(and(eq(downloadLedger.subjectType, subjectType), eq(downloadLedger.subjectId, subjectId)));

export const auditFor = (action: string, targetId: string) =>
  testDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));

// ── requests ────────────────────────────────────────────────────────────────────────────────

export type TxFailure = { code: string | undefined };

export type CallOptions = {
  json?: unknown;
  /** A raw body, with the `Content-Length` to declare (default: the bytes' length). */
  body?: ReadableStream<Uint8Array> | Uint8Array;
  contentLength?: number | null;
  headers?: Record<string, string>;
  settings?: Settings;
  env?: Record<string, unknown>;
  /** Scan messages this request sent land here instead of on the local queue. */
  sent?: unknown[];
  /** Every transaction of this request that FAILED is recorded here (its SQLSTATE, if it had one). */
  failures?: TxFailure[];
  /**
   * Called with each transaction the request opens on the database handle, after its callback
   * has run and before it commits: throw from it to make that attempt fail.
   */
  beforeCommit?: (attempt: number) => void;
  /** Deferred work is dropped instead of awaited — what a dead invocation does. */
  dropDeferred?: boolean;
};

export type Answer<T = Record<string, unknown>> = {
  status: number;
  body: T;
  headers: Headers;
  /** The response exactly as sent, minus the request id (which differs by design). */
  bytes: string;
};

function sessionFor(user: SessionUser): SessionInfo {
  return {
    id: "s".repeat(32),
    userId: user.id,
    token: "made-up-session-token", // not a credential: the auth instance below is a stand-in
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    impersonatedBy: null,
    secondFactorAt: null,
  };
}

const allow = { limit: async () => ({ success: true }) };

/** The real `createDb`, with every transaction opened on the handle observed. */
function observedCore(options: CallOptions): Pick<CoreDeps, "createDb"> {
  if (!options.failures && !options.beforeCommit) return { createDb: realCore.createDb };
  return {
    createDb: (...args) => {
      const handle = realCore.createDb(...args);
      const transaction = handle.db.transaction.bind(handle.db) as Db["transaction"];
      let attempt = 0;
      const observed: Db["transaction"] = async (run, config) => {
        const n = ++attempt;
        try {
          return await transaction(async (tx) => {
            const value = await run(tx);
            options.beforeCommit?.(n);
            return value;
          }, config);
        } catch (error) {
          options.failures?.push({ code: pgError(error)?.code });
          throw error;
        }
      };
      handle.db.transaction = observed;
      return handle;
    },
  };
}

/** What Postgres raises for a deadlock victim, as the driver hands it on. */
export function deadlockError(): Error {
  return Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" });
}

/**
 * One request to the app as `caller` (a `user` row; null = signed out), same-origin. The
 * request's deferred work has settled when this returns (unless `dropDeferred`).
 */
export async function call<T = Record<string, unknown>>(
  caller: UserRow | null,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Answer<T>> {
  const user = caller as unknown as SessionUser | null;
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: { getSession: async () => (user ? { session: sessionFor(user), user } : null) },
  };
  const core: CoreDeps = {
    ...realCore,
    ...observedCore(options),
    createAuth: () => auth,
    getSettings: async () => ({ ...ROOMY, ...options.settings }),
  };
  const app = createApp(core);

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const sent = options.sent ?? [];
  const requestEnv = {
    ...env,
    RL_AUTH: allow,
    RL_API: allow,
    RL_FILES: allow,
    RL_LINKS: allow,
    SCAN_QUEUE: { send: async (message: unknown) => void sent.push(message) },
    ...options.env,
  } as unknown as Env;

  const headers: Record<string, string> = { origin: TEST_APP_ORIGIN, ...options.headers };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    body = options.body;
    const length =
      options.contentLength !== undefined
        ? options.contentLength
        : options.body instanceof Uint8Array
          ? options.body.byteLength
          : null;
    if (length !== null) headers["content-length"] = String(length);
  } else if (options.contentLength != null) {
    headers["content-length"] = String(options.contentLength);
  }
  const response = await app.fetch(
    new Request(`${TEST_APP_ORIGIN}/api${path}`, { method, headers, body }),
    requestEnv,
    ctx,
  );
  if (options.dropDeferred) {
    // Their rejections are nobody's: the invocation is gone.
    for (const promise of pending.splice(0)) promise.catch(() => {});
  } else {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  const bytes =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? JSON.stringify({ ...(parsed as Record<string, unknown>), requestId: "" })
      : text;
  return { status: response.status, body: parsed as T, headers: response.headers, bytes };
}

// ── bodies ──────────────────────────────────────────────────────────────────────────────────

const CHUNK = new Uint8Array(MIB);

/** `size` zero bytes as a stream, a mebibyte at a time: nothing of that size is ever held. */
export function zeros(size: number): ReadableStream<Uint8Array> {
  let left = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const take = Math.min(left, CHUNK.byteLength);
      controller.enqueue(take === CHUNK.byteLength ? CHUNK : CHUNK.subarray(0, take));
      left -= take;
    },
  });
}

/** A made-up SHA-256 (64 hex characters). The server does not verify it: the scanner does. */
export const sha = () => rand(32);

export function initBody(overrides: Partial<InitUploadBody> = {}): InitUploadBody {
  return {
    parentId: null,
    name: `file-${rand()}.bin`,
    size: 1000,
    mimeDeclared: "application/octet-stream",
    fileLastModified: "2026-10-01T12:00:00.000Z",
    onConflict: "fail",
    purpose: "file",
    ...overrides,
  };
}

/** Init that must be admitted (`201`). */
export async function init(
  caller: UserRow,
  overrides: Partial<InitUploadBody> = {},
  options: CallOptions = {},
): Promise<InitUploadResponse> {
  const answer = await call<InitUploadResponse>(caller, "POST", "/uploads", {
    ...options,
    json: initBody(overrides),
  });
  if (answer.status !== 201) throw new Error(`init: ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** The whole body of a single session. */
export function putSingle(caller: UserRow, uploadId: string, bytes: Uint8Array, options: CallOptions = {}) {
  return call<{ etag: string }>(caller, "PUT", `/uploads/${uploadId}/single`, { ...options, body: bytes });
}

export function complete(
  caller: UserRow,
  uploadId: string,
  body: { sha256?: string; parts?: { n: number; etag: string }[] } = {},
  options: CallOptions = {},
) {
  return call(caller, "POST", `/uploads/${uploadId}/complete`, {
    ...options,
    json: { sha256: body.sha256 ?? sha(), parts: body.parts ?? [] },
  });
}

/** Init and the one PUT of a small file: a session ready to be completed. */
export async function uploaded(
  caller: UserRow,
  overrides: Partial<InitUploadBody> = {},
  bytes?: Uint8Array,
  options: CallOptions = {},
) {
  const content = bytes ?? new Uint8Array(overrides.size ?? 1000);
  const session = await init(caller, { ...overrides, size: content.byteLength }, options);
  const put = await putSingle(caller, session.uploadId, content, options);
  if (put.status !== 200) throw new Error(`single: ${put.status} ${JSON.stringify(put.body)}`);
  return session;
}

/** Every part of a multipart session, in order. Returns what `complete` wants. */
export async function putParts(
  caller: UserRow,
  session: Pick<InitUploadResponse, "uploadId" | "partBytes" | "partCount">,
  size: number,
  options: CallOptions = {},
) {
  const parts: { n: number; etag: string }[] = [];
  for (let n = 1; n <= session.partCount; n++) {
    const length =
      n < session.partCount ? session.partBytes : size - (session.partCount - 1) * session.partBytes;
    const answer = await call<{ n: number; etag: string }>(
      caller,
      "PUT",
      `/uploads/${session.uploadId}/parts/${n}`,
      { ...options, body: zeros(length), contentLength: length },
    );
    if (answer.status !== 200) throw new Error(`part ${n}: ${answer.status} ${JSON.stringify(answer.body)}`);
    parts.push(answer.body);
  }
  return parts;
}

/** The smallest multipart upload: one full part and one byte. */
export const TWO_PARTS = PART_BYTES + 1;
