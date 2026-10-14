// Shared by the nodes tests. A request here goes through the REAL app host — every middleware,
// the route registry, the real database and request context — with a session the test chooses
// (the stand-in auth of tests/unit/services-core/request.ts, which can only run a GET of its own:
// these routes need every method). Settings are the test's own, never the shared table.
//
// Postgres is shared by every test file of a run: fixtures have random ids and no test counts a
// table.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo } from "../../../src/worker/auth/types";
import { statementsSent, type Db } from "../../../src/worker/db/client";
import { takedownNode } from "../../../src/worker/db/queries/moderation";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { dmcaNoticeNodes, dmcaNotices, nodes, type ScanStatus } from "../../../src/worker/db/schema";
import type { CoreDeps } from "../../../src/worker/services/request-context";
import type { ScanMessage } from "../../../src/worker/services/scanning";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { auditRows, BASE_SETTINGS, makePendingShare, realCore, testDb } from "../auth/helpers";
import { makeFile, makeFolder, makeShare, makeUser, rand } from "../services-core/helpers";
import type { Caller } from "../services-core/request";

export { auditRows, testDb } from "../auth/helpers";
export {
  makeFile,
  makeFolder,
  makeShare,
  makeUpload,
  makeUser,
  nodeById,
  rand,
} from "../services-core/helpers";
export type { Caller } from "../services-core/request";

export type Answer = {
  status: number;
  /** The parsed JSON body (every answer of the app host is JSON). */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
  /** How many SQL statements the request sent in all, its deferred work included. */
  statements: number;
};

export type ApiOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  settings?: Partial<Settings>;
  env?: Record<string, unknown>;
};

const allow = { limit: async () => ({ success: true }) };

function sessionFor(caller: NonNullable<Caller>): SessionInfo {
  return {
    id: "s".repeat(32),
    userId: caller.user.id,
    token: "made-up-session-token", // not a credential: the stand-in auth never checks it
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    impersonatedBy: caller.impersonatedBy ?? null,
    secondFactorAt: caller.secondFactor ? new Date() : null,
  };
}

/**
 * One request to `/api<path>` as `caller` (null = signed out). A request with a body is sent as
 * the SPA sends it: JSON, from the app's own origin. Everything the request deferred (the audit
 * rows above all) has been written when this returns.
 */
export async function api(
  caller: Caller,
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<Answer> {
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: {
      getSession: async () => (caller ? { session: sessionFor(caller), user: caller.user } : null),
    },
  };
  let handle: Db | null = null;
  const core: CoreDeps = {
    ...realCore,
    createDb: (...args) => {
      const made = realCore.createDb(...args);
      handle = made.db;
      return made;
    },
    createAuth: () => auth,
    getSettings: async () => ({ ...BASE_SETTINGS, ...options.settings }),
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
  } as unknown as Env;
  const headers: Record<string, string> = { ...options.headers };
  if (method !== "GET") headers.origin ??= TEST_APP_ORIGIN;
  if (options.body !== undefined) headers["content-type"] ??= "application/json";
  const response = await app.fetch(
    new Request(`${TEST_APP_ORIGIN}/api${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    requestEnv,
    ctx,
  );
  const text = await response.text();
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text),
    headers: response.headers,
    statements: handle ? statementsSent(handle) : 0,
  };
}

/**
 * An answer with everything that differs between two requests by design taken out — the request
 * id — and nothing else: status, every header, the whole body. Two answers that must not be
 * told apart are compared through this.
 */
export function comparable(answer: Answer, replace: Record<string, string> = {}) {
  let body = JSON.stringify({ ...answer.body, requestId: undefined });
  for (const [from, to] of Object.entries(replace)) body = body.replaceAll(from, to);
  return {
    status: answer.status,
    headers: [...answer.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    body: JSON.parse(body) as unknown,
  };
}

/** A verified user who has accepted the terms the test settings name (mutations pass the gate). */
export async function person(overrides: Parameters<typeof makeUser>[0] = {}) {
  const row = await makeUser({ termsVersion: BASE_SETTINGS.termsVersion, ...overrides });
  return { row, id: row.id, as: { user: row } satisfies NonNullable<Caller> };
}

/** The same person seen through an admin's impersonated session. The admin id is made up. */
export const impersonated = (who: { as: NonNullable<Caller> }): Caller => ({
  ...who.as,
  impersonatedBy: "A".repeat(32),
});

/**
 * owner's tree:   shared/            ← editor (may upload), viewer; a pending share to `invited`
 *                   inner/
 *                     notes.txt      clean text
 *                     photo.png      clean image
 *                     broken.bin     scan `error`, uploaded by the editor (so they still see it)
 *                   dest/
 *                 private/           ← shared with nobody
 *                   secret.txt
 * `stranger` has no share at all; `invited` has an account, but the share to their address was
 * never activated.
 */
export async function sharedTree() {
  const [owner, editor, viewer, invited, stranger] = await Promise.all([
    person(),
    person(),
    person(),
    person(),
    person(),
  ]);
  const shared = await makeFolder(owner.id);
  const inner = await makeFolder(owner.id, shared.id);
  const dest = await makeFolder(owner.id, shared.id);
  const notes = await makeFile(owner.id, inner.id, {
    name: `notes-${rand()}.txt`,
    scanStatus: "clean",
    mimeSniffed: "text/plain",
  });
  const photo = await makeFile(owner.id, inner.id, {
    name: `photo-${rand()}.png`,
    scanStatus: "clean",
    mimeSniffed: "image/png",
  });
  const broken = await makeFile(owner.id, inner.id, {
    scanStatus: "error",
    scanReason: "engine",
    createdBy: editor.id,
  });
  const privateFolder = await makeFolder(owner.id);
  const secret = await makeFile(owner.id, privateFolder.id, { scanStatus: "clean" });
  await makeShare(shared.id, owner.id, editor.id, { role: "editor", canUpload: true });
  await makeShare(shared.id, owner.id, viewer.id, { role: "viewer" });
  await makePendingShare(shared.id, owner.id, invited.row.email);
  return {
    owner,
    editor,
    viewer,
    invited,
    stranger,
    shared,
    inner,
    dest,
    notes,
    photo,
    broken,
    privateFolder,
    secret,
  };
}

export type SharedTree = Awaited<ReturnType<typeof sharedTree>>;

// ── states a test puts a node in (written directly: the admin routes do not exist yet) ──────

/** Through the query the admin console will use: under the owner's tree lock. */
export async function takeDown(nodeId: string): Promise<void> {
  if (!(await takedownNode(testDb(), nodeId, { reason: "abuse", by: null }))) throw new Error("no such node");
}

export async function setStatus(nodeId: string, scanStatus: ScanStatus): Promise<void> {
  await testDb().update(nodes).set({ scanStatus }).where(eq(nodes.id, nodeId));
}

/** Makes `userId` the uploader of the node's current version (what an upload into a share does). */
export async function uploadedBy(nodeId: string, userId: string): Promise<void> {
  await testDb().update(nodes).set({ createdBy: userId }).where(eq(nodes.id, nodeId));
}

export async function setLegalHold(nodeId: string, held: boolean): Promise<void> {
  await testDb().update(nodes).set({ legalHold: held }).where(eq(nodes.id, nodeId));
}

/** An open DMCA notice that names the node. */
export async function openNoticeOn(nodeId: string): Promise<string> {
  const [notice] = await testDb()
    .insert(dmcaNotices)
    .values({ receivedVia: "email", status: "received" })
    .returning({ id: dmcaNotices.id });
  await testDb().insert(dmcaNoticeNodes).values({ noticeId: notice!.id, nodeId });
  return notice!.id;
}

/**
 * Many files under one folder in ONE statement: `<prefix>-00001.e1`, … — seven extensions, sizes
 * and modification times that differ from row to row; all `clean`.
 */
export async function manyFiles(
  ownerId: string,
  parentId: string,
  count: number,
  prefix = `bulk-${rand()}`,
): Promise<void> {
  await testDb().execute(sql`
    INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, r2_key,
                       version_id, scan_status, updated_at)
    SELECT gen_random_uuid(), ${ownerId}, ${ownerId}, ${parentId}::uuid, 'file',
           ${prefix} || '-' || lpad(i::text, 5, '0') || '.e' || (i % 7),
           ${prefix.toLowerCase()} || '-' || lpad(i::text, 5, '0') || '.e' || (i % 7),
           'e' || (i % 7), (i * 7919) % 100000, 'u/' || gen_random_uuid(), gen_random_uuid()::text,
           'clean', now() - make_interval(secs => i)
    FROM generate_series(1, ${count}) AS i`);
}

/** The audit rows this test's node got for an action. */
export const auditFor = (action: string, nodeId: string) => auditRows({ action, targetId: nodeId });

/** A queue stand-in that records what was sent. Pass `spy.env` as the request's `env`. */
export function scanQueueSpy() {
  const sent: ScanMessage[] = [];
  return { sent, env: { SCAN_QUEUE: { send: async (message: ScanMessage) => void sent.push(message) } } };
}
