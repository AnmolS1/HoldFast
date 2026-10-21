// Shared by the admin console's Worker tests (T25). A request goes through the REAL app host —
// every middleware, the route registry, the real database and request context — with a session
// the test chooses (a stand-in auth that answers `getSession` with it, as tests/unit/nodes does).
// Settings are the test's own, never the shared table (PLAN §6 rule 16).
//
// Postgres is shared by every test file of a run: fixtures have random ids, no test counts a
// whole table. R2 is isolated per test FILE. The operators a lock mails are a fresh made-up
// address per test (the mail ledger is shared, and ADMIN_EMAIL's hourly count is not ours).
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { insertReport, setUnderReview } from "../../../src/worker/db/queries/moderation";
import { record as recordUploadIp } from "../../../src/worker/db/queries/upload-ips";
import {
  auditLog,
  hashBlocklist,
  nodes,
  nodeVersions,
  reports,
  shareLinks,
  strikes,
  uploadIps,
  user,
  type ScanStatus,
} from "../../../src/worker/db/schema";
import type { CoreDeps } from "../../../src/worker/services/request-context";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { sealIp } from "../../../src/worker/services/tokens";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { BASE_SETTINGS, realCore, serviceDeps, testDb } from "../auth/helpers";
import { makeFile, makeFolder, makeUser, rand } from "../services-core/helpers";

export { makeLink, serviceDeps, testDb } from "../auth/helpers";
export { baId, makeFile, makeFolder, makeShare, makeUser, nodeById, rand } from "../services-core/helpers";

// ── callers ─────────────────────────────────────────────────────────────────────────────────

export type Who = {
  user: SessionUser;
  /** The session passed a second factor at this time (null: never). Default: just now. */
  secondFactorAt?: Date | null;
  /** When the session was made. Default: just now. */
  sessionCreatedAt?: Date;
  impersonatedBy?: string;
};

export type Answer = {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
  /** Promises the request handed to `waitUntil` that had not settled when the response was read. */
  pendingAtResponse: number;
};

export type CallOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  settings?: Partial<Settings>;
  env?: Record<string, unknown>;
  /** A raw body (and no JSON content type). */
  raw?: string;
  /** Read the settings table as it is (the table-wide files only): no test settings over it. */
  tableSettings?: boolean;
};

const allow = { limit: async () => ({ success: true }) };

function sessionFor(who: Who): SessionInfo {
  const at = new Date();
  return {
    id: "s".repeat(32),
    userId: who.user.id,
    token: "made-up-session-token", // not a credential: the stand-in auth never checks it
    expiresAt: new Date(at.getTime() + 3_600_000),
    createdAt: who.sessionCreatedAt ?? at,
    updatedAt: at,
    impersonatedBy: who.impersonatedBy ?? null,
    secondFactorAt: who.secondFactorAt === undefined ? at : who.secondFactorAt,
  };
}

/**
 * One request to `/api<path>` as `who` (null = signed out). A request with a body is sent as the
 * SPA sends it: JSON, from the app's own origin. Everything the request deferred (audit rows,
 * mails) has been written when this returns.
 */
export async function call(
  who: Who | null,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Answer> {
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: { getSession: async () => (who ? { session: sessionFor(who), user: who.user } : null) },
  };
  const core: CoreDeps = {
    ...realCore,
    createAuth: () => auth,
    getSettings: options.tableSettings
      ? realCore.getSettings
      : async (db, opts) => ({
          ...(await realCore.getSettings(db, opts)),
          ...BASE_SETTINGS,
          ...options.settings,
        }),
  };
  const app = createApp(core);
  const pending: Promise<unknown>[] = [];
  let settled = 0;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      promise.then(
        () => (settled += 1),
        () => (settled += 1),
      );
    },
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
  const headers: Record<string, string> = { ...options.headers };
  if (method !== "GET") headers.origin ??= TEST_APP_ORIGIN;
  if (options.body !== undefined) headers["content-type"] ??= "application/json";
  const response = await app.fetch(
    new Request(`${TEST_APP_ORIGIN}/api${path}`, {
      method,
      headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    }),
    requestEnv,
    ctx,
  );
  const text = await response.text();
  const pendingAtResponse = pending.length - settled;
  while (pending.length) await Promise.allSettled(pending.splice(0));
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text, headers: response.headers, pendingAtResponse };
}

/** `call` under /api/admin. */
export const adminCall = (who: Who | null, method: string, path: string, options: CallOptions = {}) =>
  call(who, method, `/admin${path}`, options);

/** A verified account that has accepted the test settings' terms. */
export async function member(overrides: Parameters<typeof makeUser>[0] = {}) {
  const row = await makeUser({ termsVersion: BASE_SETTINGS.termsVersion, ...overrides });
  return { row, id: row.id, as: { user: row as unknown as SessionUser } satisfies Who };
}

/** An admin as `requireAdmin` asks: the role, two-factor on the account, a session that passed it. */
export async function admin(overrides: Parameters<typeof makeUser>[0] = {}) {
  return member({ role: "admin", twoFactorEnabled: true, name: `Admin ${rand()}`, ...overrides });
}

/** The made-up operator mailbox of one test, and the env that makes it the only one. */
export function operators() {
  const address = `ops-${rand(6)}@example.test`;
  return { address, env: { ADMIN_EMAILS: address, E2E_ADMIN_EMAILS: "" } };
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────

/** A made-up digest: 64 hex characters of no real content. */
export const madeUpSha = () => rand(32);

/** An uploader address row for a node's version, sealed exactly as the upload route seals it. */
export async function uploadAddress(nodeId: string, versionId: string, uploaderId: string, ip: string) {
  const sealed = await sealIp(env, ip);
  const id = await recordUploadIp(testDb(), {
    nodeId,
    versionId,
    uploaderId,
    ipEncrypted: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
  });
  return id;
}

/** A kept old version of a node, uploaded by `createdBy`. */
export async function oldVersion(nodeId: string, ownerId: string, createdBy: string | null) {
  const versionId = `old-${rand(6)}`;
  await testDb()
    .insert(nodeVersions)
    .values({
      nodeId,
      versionId,
      r2Key: `u/${ownerId}/${nodeId}/${versionId}`,
      size: 10,
      createdBy,
      purgeAfter: new Date(Date.now() + 30 * 86_400_000),
    });
  return versionId;
}

/** A report as the intake files it: the node goes under review and its links pause (`report`). */
export async function reported(
  nodeId: string,
  ownerId: string,
  category: (typeof reports.category.enumValues)[number] = "other",
  extra: { reporterEmail?: string; reporterIpHashStable?: string } = {},
) {
  await setUnderReview(testDb(), nodeId);
  const id = await insertReport(testDb(), {
    nodeId,
    ownerId,
    source: "user",
    category,
    reporterIpHashStable: extra.reporterIpHashStable ?? `made-up-${rand(8)}`,
    reporterEmail: extra.reporterEmail ?? null,
    details: "made up for a test",
  });
  return id!;
}

/**
 * A file owned by `owner`, its current version uploaded by `uploader` (with an address row), and
 * LOCKED as suspected CSAM through T10's one handler. Returns the case's report id.
 */
export async function lockedFile(
  opts: { owner?: { id: string }; uploader?: { id: string }; sha256?: string } = {},
) {
  const owner = opts.owner ?? (await member());
  const uploader = opts.uploader ?? owner;
  const sha256 = opts.sha256 ?? madeUpSha();
  const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256, createdBy: uploader.id });
  await uploadAddress(file.id, file.versionId!, uploader.id, "192.0.2.10");
  const ops = operators();
  const service = serviceDeps(ops.env);
  const { reportId } = await lockSuspectedCsam(service.deps, file.id, { source: "admin" });
  await service.settle();
  return { owner, uploader, file, sha256, reportId, ops };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────

export async function nodeRowOf(id: string) {
  const [row] = await testDb().select().from(nodes).where(eq(nodes.id, id));
  return row ?? null;
}

export async function reportRowOf(id: string) {
  const [row] = await testDb().select().from(reports).where(eq(reports.id, id));
  return row ?? null;
}

export async function userRowOf(id: string) {
  const [row] = await testDb().select().from(user).where(eq(user.id, id));
  return row ?? null;
}

export async function linkRowOf(id: string) {
  const [row] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, id));
  return row!;
}

export async function blocklistRow(sha256: string) {
  const [row] = await testDb().select().from(hashBlocklist).where(eq(hashBlocklist.sha256, sha256));
  return row ?? null;
}

export async function strikesOfUser(userId: string) {
  return testDb().select().from(strikes).where(eq(strikes.userId, userId));
}

export async function addressRows(nodeId: string) {
  return testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, nodeId));
}

/** The audit rows with this action and target id, oldest first. */
export async function auditOf(action: string, targetId: string) {
  return testDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)))
    .orderBy(auditLog.at);
}

/** Every audit row about this target id (any action), oldest first. */
export async function auditAbout(targetId: string) {
  return testDb().select().from(auditLog).where(eq(auditLog.targetId, targetId)).orderBy(auditLog.at);
}

/** No answer of the console carries a content URL: no files-host origin, no `/t/`, `/i/`, `/d/` path. */
export function contentUrlsIn(text: string): string[] {
  const found = text.match(
    /files\.localhost|https?:\/\/[^"]*\/(?:t|i|d)\/[0-9a-f-]{36}|"\/(?:t|i|d)\/[0-9a-f-]{36}/g,
  );
  return found ?? [];
}

export { type ScanStatus };
export { makeFolder as folder };
