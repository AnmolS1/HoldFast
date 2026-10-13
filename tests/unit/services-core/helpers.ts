// Shared by the services-core tests. Runs inside workerd, against this checkout's local Postgres
// and the local object store.
//
// Postgres is shared by every test file and every run: every fixture has random ids and no test
// counts a whole table. R2 and the queue are isolated per test FILE.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "../../../src/worker/db/ids";
import { nodes, scanJobs, type ScanStatus, shares, uploads, user } from "../../../src/worker/db/schema";
import { queue } from "../../../src/worker/scan/consumer";
import { extOf, nameKeyOf } from "../../../src/worker/services/filename";
import { runBackground } from "../../../src/worker/services/request-context";
import { keyFor } from "../../../src/worker/services/storage";
import { realCore, testDb } from "../auth/helpers";

export { eventually, mailTo, serviceDeps, testDb, auditRows, ADMIN_EMAIL } from "../auth/helpers";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A user id in the auth library's shape: 32 characters of [A-Za-z0-9]. */
export function baId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => ALNUM[byte % ALNUM.length]).join(
    "",
  );
}

export const rand = (bytes = 4) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A user row written directly (no sign-up). The address is at a reserved test domain. */
export async function makeUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const id = overrides.id ?? baId();
  const [row] = await testDb()
    .insert(user)
    .values({
      id,
      name: `Test ${id.slice(0, 6)}`,
      email: `${id.toLowerCase()}@services-core.example.test`,
      emailVerified: true,
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeFolder(
  ownerId: string,
  parentId: string | null = null,
  overrides: Partial<typeof nodes.$inferInsert> = {},
) {
  const name = overrides.name ?? `folder-${rand()}`;
  const [row] = await testDb()
    .insert(nodes)
    .values({
      ownerId,
      createdBy: ownerId,
      parentId,
      kind: "folder",
      name,
      nameKey: nameKeyOf(name),
      ext: "",
      scanStatus: "clean",
      ...overrides,
    })
    .returning();
  return row!;
}

/** A file node whose key is a real `keyFor` key. No object is stored: see `putObject`. */
export async function makeFile(
  ownerId: string,
  parentId: string | null = null,
  overrides: Partial<typeof nodes.$inferInsert> & { scanStatus?: ScanStatus } = {},
) {
  const id = overrides.id ?? uuidv7();
  const versionId = overrides.versionId ?? uuidv7();
  const name = overrides.name ?? `file-${rand()}.bin`;
  const [row] = await testDb()
    .insert(nodes)
    .values({
      id,
      ownerId,
      createdBy: ownerId,
      parentId,
      kind: "file",
      name,
      nameKey: nameKeyOf(name),
      ext: extOf(name),
      size: 100,
      r2Key: keyFor(ownerId, id, versionId),
      versionId,
      scanStatus: "pending",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeUpload(
  ownerId: string,
  uploaderId: string,
  overrides: Partial<typeof uploads.$inferInsert> = {},
) {
  const nodeId = overrides.nodeId ?? uuidv7();
  const versionId = overrides.versionId ?? uuidv7();
  const name = overrides.name ?? `upload-${rand()}.bin`;
  const [row] = await testDb()
    .insert(uploads)
    .values({
      ownerId,
      uploaderId,
      parentId: null,
      nodeId,
      versionId,
      name,
      nameKey: nameKeyOf(name),
      size: 1000,
      r2Key: keyFor(ownerId, nodeId, versionId),
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeShare(
  nodeId: string,
  grantedBy: string,
  granteeUserId: string,
  overrides: Partial<typeof shares.$inferInsert> = {},
) {
  const [row] = await testDb()
    .insert(shares)
    .values({
      nodeId,
      grantedBy,
      granteeEmail: `${granteeUserId.toLowerCase()}@services-core.example.test`,
      granteeUserId,
      activatedAt: new Date(),
      role: "viewer",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function nodeById(id: string) {
  const [row] = await testDb().select().from(nodes).where(eq(nodes.id, id));
  return row ?? null;
}

export async function jobsFor(r2Key: string) {
  return testDb().select().from(scanJobs).where(eq(scanJobs.r2Key, r2Key));
}

/** Stores an object straight through the binding (local R2 emits no event for it). */
export async function putObject(key: string, bytes: Uint8Array | string): Promise<void> {
  await env.FILES.put(key, bytes);
}

export const SCAN_QUEUE_NAME = "holdfast-scan-dev";

export type Delivery = { body: unknown; attempts?: number };
export type Outcome = "ack" | "retry";
export type Delivered = { outcome: Outcome; delaySeconds?: number }[];

/**
 * Hands the consumer one batch — inside `runBackground`, exactly as the Worker entry does — and
 * says what became of each message. `envOverrides` are the vars this delivery sees.
 */
export async function deliver(
  messages: Delivery[],
  envOverrides: Record<string, unknown> = {},
  queueName: string = SCAN_QUEUE_NAME,
): Promise<Delivered> {
  const runEnv = { ...env, ...envOverrides } as unknown as Env;
  const batch = createMessageBatch(
    queueName,
    messages.map((message, index) => ({
      id: `m${index}-${rand()}`,
      timestamp: new Date(),
      body: message.body,
      attempts: message.attempts ?? 1,
    })),
  );
  // The harness records THAT a message was retried, not with which delay: the delay is taken
  // from the call itself.
  const delays = new Map<string, number | undefined>();
  for (const message of batch.messages) {
    const retry = message.retry.bind(message);
    Object.defineProperty(message, "retry", {
      value: (options?: QueueRetryOptions) => {
        delays.set(message.id, options?.delaySeconds);
        retry(options);
      },
    });
  }
  const ctx = createExecutionContext();
  await runBackground(runEnv, ctx, (bg) => queue(batch, runEnv, ctx, bg), realCore);
  const result = await getQueueResult(batch, ctx);
  return batch.messages.map((message) => {
    const retried = result.retryMessages.find((entry) => entry.msgId === message.id);
    if (retried) return { outcome: "retry", delaySeconds: delays.get(message.id) };
    if (result.ackAll || result.explicitAcks.includes(message.id)) return { outcome: "ack" };
    throw new Error("the consumer neither acknowledged nor retried a message");
  });
}

/** The store's own event for an object written under `u/`, as recorded from the dev queue. */
export function r2Event(key: string, action = "CompleteMultipartUpload", size = 100) {
  return {
    account: "9668af964b3bf13cc286ae6b73097a35",
    bucket: "holdfast-files-dev",
    eventTime: new Date().toISOString(),
    action,
    object: { key, size, eTag: "dce1c18393acbef2580b54a3b321765d-3" },
  };
}

// ── races, without sleeping ─────────────────────────────────────────────────────────────────

/** A promise with its resolver, so one side of a race can be held until the other is in place. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => (open = resolve));
  return { opened, open };
}

/** The backend process id of the connection a transaction runs on. */
export async function backendPid(tx: {
  execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>;
}) {
  const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  return Number((result.rows[0] as { pid: number }).pid);
}

/**
 * Resolves once some backend of this database is blocked on a lock that `pid` holds — or, when
 * `orElse` is given, once that returns true (the other side got past the point where it would
 * have blocked). Polls the server's own view of who waits for whom; throws after ten seconds.
 */
export async function untilBlockedBy(
  pid: number,
  orElse: () => boolean = () => false,
): Promise<"blocked" | "passed"> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (orElse()) return "passed";
    const result = await testDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`,
    );
    if (Number(result.rows[0]?.n) > 0) return "blocked";
    if (Date.now() > deadline)
      throw new Error("nothing ever waited for the lock, and the other side never passed");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
