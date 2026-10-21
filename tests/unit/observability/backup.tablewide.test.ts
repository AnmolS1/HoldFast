// The nightly export over the WHOLE database, and the restore of what it wrote — table-wide
// (serial step 3 of `npm test`; by hand `HOLDFAST_TABLEWIDE=1 npx vitest run -c
// vitest.workers.config.ts tests/unit/observability/backup.tablewide.test.ts`).
//
// The tables hold whatever earlier files left; every assertion is about rows THIS file made, or
// about the set as a whole against its own manifest. The bucket is this file's own (R2 is isolated
// per test file). The restore goes into scratch SCHEMAS of this checkout's database — a copy of
// every table (columns, defaults, keys, indexes, checks, and every foreign key re-pointed at the
// copy) — with the connection's search_path on that schema, exactly as the CLI runs against an
// empty migrated database. Credentials and secrets here are made up.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RestoreRefusal, restoreSet, type RestoreSql } from "../../../scripts/ops/restore-core";
import { hashPassword, verifyPassword } from "../../../src/worker/auth/password";
import { uuidv7 } from "../../../src/worker/db/ids";
import { schemaTableNames } from "../../../src/worker/db/queries/backup";
import { account, auditLog, nodes, nodeVersions, session, user } from "../../../src/worker/db/schema";
import {
  BACKUP_PART_BYTES,
  backupPass,
  job,
  manifestKey,
  tableKey,
  type Manifest,
} from "../../../src/worker/jobs/backup";
import { cronEvent, jobContext } from "../trash/helpers";
import { makeFile, makeFolder, makeUser, rand, testDb } from "../services-core/helpers";

const PASSWORD = "made-up restore password 7"; // made up
const OPERATOR = `t27-backup-${rand()}@example.test`; // made up
const today = new Date().toISOString().slice(0, 10);
const ctx = () => jobContext({ env: { ADMIN_EMAILS: OPERATOR } });

type Seeded = { userId: string; folder: string; child: string; file: string; versionId: string };

/** A signed-up account: a password, a session, a folder in a folder holding a file with an old version. */
async function seedAccount(): Promise<Seeded> {
  const owner = await makeUser();
  const now = new Date();
  await testDb()
    .insert(account)
    .values({
      id: `acct${rand(12)}`,
      accountId: owner.id,
      providerId: "credential",
      userId: owner.id,
      password: await hashPassword(PASSWORD),
      createdAt: now,
      updatedAt: now,
    });
  await testDb()
    .insert(session)
    .values({
      id: `sess${rand(12)}`,
      token: `made-up-session-${rand(16)}`,
      userId: owner.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: now,
      updatedAt: now,
    } as typeof session.$inferInsert);
  const folder = await makeFolder(owner.id);
  const child = await makeFolder(owner.id, folder.id);
  const file = await makeFile(owner.id, child.id, { size: 10 });
  const versionId = uuidv7();
  await testDb()
    .insert(nodeVersions)
    .values({
      nodeId: file.id,
      versionId,
      r2Key: `u/${owner.id}/${file.id}/${versionId}`,
      size: 5,
      createdBy: owner.id,
      purgeAfter: new Date(Date.now() + 30 * 86_400_000),
    });
  return { userId: owner.id, folder: folder.id, child: child.id, file: file.id, versionId };
}

/** Removes an account the way the account purge leaves it: its rows, children first, then the user. */
async function purgeAccount(seeded: Seeded) {
  await testDb().delete(nodeVersions).where(eq(nodeVersions.nodeId, seeded.file));
  for (const id of [seeded.file, seeded.child, seeded.folder])
    await testDb().delete(nodes).where(eq(nodes.id, id));
  // account and session go with the user (ON DELETE CASCADE).
  await testDb().delete(user).where(eq(user.id, seeded.userId));
}

// Incompressible filler so that one table's object is larger than one 8 MiB part.
const AUDIT_ACTION = `t27.backup.filler.${rand()}`;
async function seedFiller(megabytes: number) {
  for (let i = 0; i < megabytes * 13; i++) {
    const raw = crypto.getRandomValues(new Uint8Array(60 * 1024));
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    await testDb()
      .insert(auditLog)
      .values({ actorType: "system", action: AUDIT_ACTION, meta: { filler: btoa(binary) } });
  }
}

async function listAll(prefix: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    for (const object of listed.objects) out.set(object.key, object.etag);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out;
}

async function gunzip(key: string): Promise<string> {
  const object = await env.FILES.get(key);
  return new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

// ── the scratch schemas ───────────────────────────────────────────────────────────────────────

const schemas: string[] = [];
const clients: pg.Client[] = [];

/** A connection whose search_path is a fresh copy of the migrated schema, empty. */
async function scratchTarget(): Promise<{ sql: RestoreSql; client: pg.Client; schema: string }> {
  const schema = `t27_restore_${rand(6)}`;
  schemas.push(schema);
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  clients.push(client);
  await client.query(`CREATE SCHEMA ${schema}`);
  for (const name of schemaTableNames()) {
    await client.query(`CREATE TABLE ${schema}."${name}" (LIKE public."${name}" INCLUDING ALL)`);
  }
  // Foreign keys, read while `public` is the path (so their targets print unqualified), then
  // added with the scratch schema first in the path (so the targets are the copies).
  const keys = await client.query<{ table: string; name: string; def: string }>(`
    SELECT c.relname AS "table", f.conname AS name, pg_get_constraintdef(f.oid) AS def
    FROM pg_constraint f JOIN pg_class c ON c.oid = f.conrelid
    WHERE f.contype = 'f' AND c.relnamespace = 'public'::regnamespace`);
  await client.query(`SET search_path TO ${schema}, public`);
  for (const key of keys.rows) {
    await client.query(`ALTER TABLE "${key.table}" ADD CONSTRAINT "${key.name}" ${key.def}`);
  }
  return {
    schema,
    client,
    sql: { query: async (text, params) => ({ rows: (await client.query(text, params)).rows }) },
  };
}

const readLocal = async (key: string) => {
  const object = await env.FILES.get(key);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
};

let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  a = await seedAccount();
  b = await seedAccount();
  await seedFiller(12);
}, 120_000);

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => {});
  const admin = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await admin.connect();
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await testDb().delete(auditLog).where(eq(auditLog.action, AUDIT_ACTION));
  for (const seeded of [a, b]) if (seeded) await purgeAccount(seeded);
}, 120_000);

describe("the nightly export, run as the cron slot runs it", () => {
  let manifest: Manifest;

  it("writes one object per table and the manifest under b/db/<today>/ — and nothing outside b/db/", async () => {
    const uploadsBefore = await listAll("u/");
    const everythingBefore = await listAll("");
    const { bg, outcomes } = ctx();
    const result = await job.run(bg, env, cronEvent("0 2 * * *"), { softDeadlineMs: 600_000 });
    expect(result).toEqual({ done: true });
    expect(outcomes("backup")).toContain("ok");

    // Spike S8: a key under u/ would be a scan message on a deploy. The u/ listing is unchanged,
    // and every new key is under b/db/.
    expect(await listAll("u/")).toEqual(uploadsBefore);
    const added = [...(await listAll("")).keys()].filter((key) => !everythingBefore.has(key));
    expect(added.length).toBeGreaterThan(0);
    for (const key of added) expect(key.startsWith(`b/db/${today}/`), key).toBe(true);

    const object = await env.FILES.get(manifestKey(today));
    manifest = (await object!.json()) as Manifest;
    expect(manifest.tables.map((table) => table.name).sort()).toEqual(schemaTableNames());
    expect(manifest.detection).toBe("ok");
    for (const table of manifest.tables) {
      const head = await env.FILES.head(tableKey(today, table.name));
      expect(head?.size, table.name).toBe(table.bytes);
    }
    // The multipart path ran: the filler's table is past one part.
    expect(manifest.tables.find((table) => table.name === "audit_log")!.bytes).toBeGreaterThan(
      BACKUP_PART_BYTES,
    );
    // This file's rows are in it.
    expect(await gunzip(tableKey(today, "user"))).toContain(a.userId);
    expect(await gunzip(tableKey(today, "nodes"))).toContain(a.file);
  }, 600_000);

  it("a second pass the same day finds the set complete and writes nothing", async () => {
    const before = await listAll(`b/db/${today}/`);
    const { bg } = ctx();
    expect(await backupPass(bg, { softDeadlineMs: 600_000 })).toMatchObject({
      done: true,
      outcome: "already_complete",
    });
    expect(await listAll(`b/db/${today}/`)).toEqual(before);
  });

  it("restore: row counts equal the manifest, session is empty, the restored password verifies", async () => {
    const target = await scratchTarget();
    const result = await restoreSet({ date: today, read: readLocal, sql: target.sql });
    expect(result.dangling).toEqual([]);
    for (const table of manifest.tables) {
      const { rows } = await target.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table.name}"`,
      );
      const expected = ["session", "verification"].includes(table.name) ? 0 : table.rows;
      expect(rows[0]!.n, table.name).toBe(expected);
    }
    const restored = await target.client.query<{ password: string }>(
      `SELECT password FROM account WHERE user_id = $1 AND provider_id = 'credential'`,
      [a.userId],
    );
    expect(await verifyPassword({ hash: restored.rows[0]!.password, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: restored.rows[0]!.password, password: "not it" })).toBe(false);
    const tree = await target.client.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM nodes WHERE owner_id = $1`,
      [a.userId],
    );
    expect(new Map(tree.rows.map((row) => [row.id, row.parent_id]))).toEqual(
      new Map([
        [a.folder, null],
        [a.child, a.folder],
        [a.file, a.child],
      ]),
    );
  }, 300_000);

  it("restore refuses: no manifest, a changed object, a target with rows", async () => {
    const target = await scratchTarget();
    await expect(restoreSet({ date: "2099-12-31", read: readLocal, sql: target.sql })).rejects.toThrow(
      /no _manifest\.json/,
    );
    const tampered = async (key: string) => {
      const bytes = await readLocal(key);
      if (bytes && key.endsWith("/nodes.jsonl.gz")) bytes[bytes.length - 1] ^= 0xff;
      return bytes;
    };
    await expect(restoreSet({ date: today, read: tampered, sql: target.sql })).rejects.toThrow(
      /nodes: SHA-256 differs/,
    );
    await target.client.query(`INSERT INTO pending_user_purges (user_id, scheduled_for) VALUES ('x', now())`);
    await expect(restoreSet({ date: today, read: readLocal, sql: target.sql })).rejects.toBeInstanceOf(
      RestoreRefusal,
    );
  }, 300_000);
});

describe("a pass that dies, and passes that straddle an account purge", () => {
  it("killed mid-table: that upload is aborted, no manifest, the earlier complete set untouched", async () => {
    const date = "2099-02-01";
    const earlier = await listAll(`b/db/${today}/`);
    // A store whose second multipart part fails: the filler's table dies after its first part.
    const failing = new Proxy(env.FILES, {
      get(target, property) {
        if (property !== "createMultipartUpload") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
          const upload = await target.createMultipartUpload(...args);
          let parts = 0;
          return new Proxy(upload, {
            get(inner, name) {
              if (name === "uploadPart") {
                return async (...partArgs: Parameters<R2MultipartUpload["uploadPart"]>) => {
                  if (++parts === 2) throw new Error("the invocation was killed");
                  return inner.uploadPart(...partArgs);
                };
              }
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      },
    }) as R2Bucket;
    const { bg, outcomes } = ctx();
    await expect(backupPass(bg, { date, bucket: failing, softDeadlineMs: 600_000 })).rejects.toThrow(
      "the invocation was killed",
    );
    expect(outcomes("backup")).toContain("error");
    expect(await env.FILES.head(manifestKey(date))).toBeNull();
    expect(await env.FILES.head(tableKey(date, "audit_log"))).toBeNull();
    expect(await listAll(`b/db/${today}/`)).toEqual(earlier);
  }, 600_000);

  it("an account purged between two passes: the set restores, its rows named and resolved by ON DELETE", async () => {
    const date = "2099-03-01";
    // Pass 1 dies at the `user` table: the tables written before it (children first) hold B's rows.
    const failing = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key === tableKey(date, "user")) throw new Error("the invocation was killed");
            return (target.put as (...args: unknown[]) => unknown)(key, ...rest);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const { bg } = ctx();
    await expect(backupPass(bg, { date, bucket: failing, softDeadlineMs: 600_000 })).rejects.toThrow();
    expect(await gunzip(tableKey(date, "nodes"))).toContain(b.file);

    // Between the passes, B's account is purged.
    await purgeAccount(b);

    // Pass 2 resumes: only what pass 1 did not finish is written; then the manifest.
    const second = await backupPass(ctx().bg, { date, softDeadlineMs: 600_000 });
    expect(second.done).toBe(true);
    expect(second.written).toContain("user");
    expect(second.written).not.toContain("nodes");

    const target = await scratchTarget();
    const result = await restoreSet({ date, read: readLocal, sql: target.sql });
    // B's nodes named B as owner (RESTRICT): dropped, and named; their version went with them.
    const droppedNodes = result.dangling.filter((row) => row.table === "nodes").map((row) => row.key);
    expect(droppedNodes).toEqual(expect.arrayContaining([b.folder, b.child, b.file]));
    expect(
      result.dangling.some((row) => row.table === "node_versions" && row.key.includes(b.versionId)),
    ).toBe(true);
    const left = await target.client.query(`SELECT 1 FROM nodes WHERE owner_id = $1`, [b.userId]);
    expect(left.rows).toHaveLength(0);
    const kept = await target.client.query(`SELECT 1 FROM nodes WHERE owner_id = $1`, [a.userId]);
    expect(kept.rows).toHaveLength(3);
  }, 600_000);
});
