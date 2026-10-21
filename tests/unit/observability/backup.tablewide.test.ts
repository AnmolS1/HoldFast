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
import { eq, inArray } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import journal from "../../../drizzle/meta/_journal.json";
import { restoreSet, type RestoreSql } from "../../../scripts/ops/restore-core";
import { hashPassword, verifyPassword } from "../../../src/worker/auth/password";
import { uuidv7 } from "../../../src/worker/db/ids";
import { schemaTableNames } from "../../../src/worker/db/queries/backup";
import { withJobLock } from "../../../src/worker/db/queries/trash-jobs";
import { account, auditLog, nodes, nodeVersions, session, user } from "../../../src/worker/db/schema";
import {
  BACKUP_PART_BYTES,
  backupPass,
  EMPTIED_TABLES,
  job,
  manifestKey,
  NULLED_COLUMNS,
  tableKey,
  type Manifest,
} from "../../../src/worker/jobs/backup";
import { cronEvent, jobContext } from "../trash/helpers";
import { makeFile, makeFolder, makeUser, rand, testDb } from "../services-core/helpers";

const PASSWORD = "made-up restore password 7"; // made up
const OAUTH_SENTINEL = `made-up-oauth-token-${rand(8)}`; // made up
const OPERATOR = `t27-backup-${rand()}@example.test`; // made up
const today = new Date().toISOString().slice(0, 10);
const ctx = () => jobContext({ env: { ADMIN_EMAILS: OPERATOR } });

type Seeded = { userId: string; folder: string; child: string; file: string; versionId: string };

/** A signed-up account: a password, a session, a folder in a folder holding a file with an old version. */
async function seedAccount(options: { folderHeld?: boolean } = {}): Promise<Seeded> {
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
      accessToken: OAUTH_SENTINEL,
      refreshToken: OAUTH_SENTINEL,
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
  const folder = await makeFolder(owner.id, null, { legalHold: options.folderHeld === true });
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

async function readManifest(date: string): Promise<Manifest> {
  return (await (await env.FILES.get(manifestKey(date)))!.json()) as Manifest;
}

async function writeManifest(date: string, manifest: Manifest) {
  await env.FILES.put(manifestKey(date), JSON.stringify(manifest));
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Copies set `from` to set `to`, with one table's lines filtered — a set as a straddle would leave it. */
async function copySet(
  from: string,
  to: string,
  filter: { table?: string; drop?: (line: string) => boolean } = {},
) {
  const manifest = await readManifest(from);
  for (const table of manifest.tables) {
    let bytes = new Uint8Array(await (await env.FILES.get(tableKey(from, table.name)))!.arrayBuffer());
    if (table.name === filter.table) {
      const lines = (await gunzip(tableKey(from, table.name))).split("\n").filter(Boolean);
      const kept = lines.filter((line) => !filter.drop!(line));
      const text = kept.map((line) => `${line}\n`).join("");
      bytes = new Uint8Array(
        await new Response(
          new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
      table.rows = kept.length;
      table.bytes = bytes.byteLength;
      table.sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    }
    await env.FILES.put(tableKey(to, table.name), bytes);
  }
  await writeManifest(to, manifest);
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

/** A store that fails `put` of one key — an invocation killed at that table. */
function failingPut(failKey: string): R2Bucket {
  return new Proxy(env.FILES, {
    get(target, property) {
      if (property === "put") {
        return async (key: string, ...rest: unknown[]) => {
          if (key === failKey) throw new Error("the invocation was killed");
          return (target.put as (...args: unknown[]) => unknown)(key, ...rest);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as R2Bucket;
}

let a: Seeded;
let b: Seeded;
let held: Seeded;
const extraNodes: string[] = [];

beforeAll(async () => {
  a = await seedAccount();
  b = await seedAccount();
  held = await seedAccount({ folderHeld: true });
  await seedFiller(12);
}, 120_000);

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => {});
  const admin = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await admin.connect();
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  await testDb().delete(auditLog).where(eq(auditLog.action, AUDIT_ACTION));
  if (extraNodes.length) {
    await testDb().update(nodes).set({ parentId: null }).where(inArray(nodes.id, extraNodes));
    await testDb().delete(nodes).where(inArray(nodes.id, extraNodes));
  }
  for (const seeded of [a, b, held]) if (seeded) await purgeAccount(seeded);
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

    manifest = await readManifest(today);
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

  it("M4: session and verification leave as ZERO-row tables; the OAuth tokens of `account` are not exported", async () => {
    expect([...EMPTIED_TABLES].sort()).toEqual(["session", "verification"]);
    for (const name of EMPTIED_TABLES) {
      expect(manifest.tables.find((table) => table.name === name)!.rows, name).toBe(0);
      expect(await gunzip(tableKey(today, name)), name).toBe("");
    }
    expect(manifest.emptied).toEqual([...EMPTIED_TABLES]);
    expect(manifest.nulled).toEqual(NULLED_COLUMNS);
    const accounts = await gunzip(tableKey(today, "account"));
    expect(accounts).toContain(a.userId);
    expect(accounts).not.toContain(OAUTH_SENTINEL);
  });

  it("M2: the manifest records the migration level and every table's columns", async () => {
    const last = journal.entries[journal.entries.length - 1]!;
    expect(manifest.migration).toEqual({ tag: last.tag, when: last.when });
    const nodesColumns = manifest.tables.find((table) => table.name === "nodes")!.columns;
    expect(nodesColumns).toContain("parent_id:uuid");
    expect(nodesColumns).toContain("legal_hold:bool");
    for (const table of manifest.tables) expect(table.columns.length, table.name).toBeGreaterThan(0);
  });

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
      expect(rows[0]!.n, table.name).toBe(table.rows);
    }
    const restored = await target.client.query<{ password: string; access_token: string | null }>(
      `SELECT password, access_token FROM account WHERE user_id = $1 AND provider_id = 'credential'`,
      [a.userId],
    );
    expect(await verifyPassword({ hash: restored.rows[0]!.password, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: restored.rows[0]!.password, password: "not it" })).toBe(false);
    expect(restored.rows[0]!.access_token).toBeNull();
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
    await expect(restoreSet({ date: today, read: readLocal, sql: target.sql })).rejects.toThrow(
      /is not empty/,
    );
  }, 300_000);

  it("B1/R-10: a set written while the detector did not read ok is refused — loaded only when acknowledged", async () => {
    const date = "2099-04-01";
    await copySet(today, date);
    await writeManifest(date, { ...(await readManifest(date)), detection: "rollback" });
    const target = await scratchTarget();
    await expect(restoreSet({ date, read: readLocal, sql: target.sql })).rejects.toThrow(
      /rollback detector read "rollback"/,
    );
    const { rows } = await target.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user"`);
    expect(rows[0]!.n).toBe(0);
    const loaded = await restoreSet({ date, read: readLocal, sql: target.sql, acceptDetection: true });
    expect(loaded.warnings).toEqual([expect.stringContaining('read "rollback"')]);
  }, 300_000);

  it("B1/M2: another schema version is refused — a table missing or extra, another migration level", async () => {
    const target = await scratchTarget();
    const date = "2099-04-02";
    await copySet(today, date);
    const base = await readManifest(date);
    await writeManifest(date, {
      ...base,
      tables: base.tables.filter((table) => table.name !== "user_prefs"),
    });
    await expect(restoreSet({ date, read: readLocal, sql: target.sql })).rejects.toThrow(
      /another schema version.*not in the set: user_prefs/,
    );
    await writeManifest(date, {
      ...base,
      tables: [...base.tables, { ...base.tables[0]!, name: "gone_table" }],
    });
    await expect(restoreSet({ date, read: readLocal, sql: target.sql })).rejects.toThrow(
      /another schema version.*not in the target: gone_table/,
    );
    await writeManifest(date, { ...base, migration: { tag: "0007_jit_off", when: 1 } });
    await expect(restoreSet({ date, read: readLocal, sql: target.sql })).rejects.toThrow(
      /migration level.*0007_jit_off/,
    );
  }, 300_000);

  it("M2: a column renamed, dropped or added in the target is refused, naming the table", async () => {
    const target = await scratchTarget();
    const change = async (ddl: string, undo: string, expected: RegExp) => {
      await target.client.query(ddl);
      await expect(restoreSet({ date: today, read: readLocal, sql: target.sql })).rejects.toThrow(expected);
      await target.client.query(undo);
    };
    await change(
      `ALTER TABLE user_prefs RENAME COLUMN theme TO theme_renamed`,
      `ALTER TABLE user_prefs RENAME COLUMN theme_renamed TO theme`,
      /columns of user_prefs differ/,
    );
    await change(
      `ALTER TABLE invites ADD COLUMN extra text`,
      `ALTER TABLE invites DROP COLUMN extra`,
      /columns of invites differ/,
    );
    await change(`ALTER TABLE invites DROP COLUMN note`, `SELECT 1`, /columns of invites differ/);
  }, 300_000);
});

describe("passes: the deadline, a death, the lock, the read-back, one snapshot", () => {
  it("B1: a pass cut by its soft deadline leaves no manifest and nothing at the cut table; the next pass starts over and completes", async () => {
    const date = "2099-05-01";
    let skew = 0;
    const clock = () => Date.now() + skew;
    const { bg, outcomes } = ctx();
    const first = await backupPass(bg, {
      date,
      softDeadlineMs: 600_000,
      pageRows: 2,
      clock,
      afterPage: (table, page) => {
        // The deadline passes while `nodes` is being read, after its first page.
        if (table === "nodes" && page === 1) skew = 3_600_000;
      },
    });
    expect(first).toMatchObject({ done: false, outcome: "partial" });
    expect(first.written).not.toContain("nodes");
    expect(outcomes("backup")).toContain("partial");
    expect(outcomes("backup")).not.toContain("ok");
    expect(await env.FILES.head(tableKey(date, "nodes"))).toBeNull();
    expect(await env.FILES.head(manifestKey(date))).toBeNull();

    const second = await backupPass(ctx().bg, { date, softDeadlineMs: 600_000 });
    expect(second).toMatchObject({ done: true, outcome: "ok" });
    // M1: the set is ONE snapshot — the second pass wrote every table again, not only what was left.
    expect([...second.written].sort()).toEqual(schemaTableNames());
    expect(first.written.length).toBeGreaterThan(0);
    const manifest = await readManifest(date);
    expect(manifest.attempt).toBe(second.attempt);
    expect(manifest.attempt).not.toBe(first.attempt);
  }, 600_000);

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

  it("B1: the manifest is read back and every object head()ed — a short object fails the pass, no ok", async () => {
    const date = "2099-05-02";
    const lying = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "head") {
          return async (key: string) => {
            const head = await target.head(key);
            if (head && key === tableKey(date, "nodes")) return { ...head, size: head.size - 1 };
            return head;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const { bg, outcomes } = ctx();
    await expect(backupPass(bg, { date, bucket: lying, softDeadlineMs: 600_000 })).rejects.toThrow(
      /missing or short/,
    );
    expect(outcomes("backup")).not.toContain("ok");
  }, 600_000);

  it("B1: one pass at a time — while another holds the lock, a pass does nothing and answers overlap", async () => {
    const date = "2099-05-03";
    const { bg, outcomes } = ctx();
    const locked = await withJobLock(testDb(), "backup", 60_000, async () =>
      backupPass(bg, { date, softDeadlineMs: 600_000 }),
    );
    expect(locked).toMatchObject({ held: true, value: { done: false, outcome: "overlap", written: [] } });
    expect(outcomes("backup")).toEqual(["overlap"]);
    expect(await listAll(`b/db/${date}/`)).toEqual(new Map());
  }, 120_000);

  it("d-m1: a set completed between the first look and the lock is not overwritten", async () => {
    const date = "2099-05-04";
    await copySet(today, date);
    const before = await listAll(`b/db/${date}/`);
    // The first head() of the manifest misses, as if the other pass finished just after it.
    let looks = 0;
    const late = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "head") {
          return async (key: string) =>
            key === manifestKey(date) && looks++ === 0 ? null : target.head(key);
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const result = await backupPass(ctx().bg, { date, bucket: late, softDeadlineMs: 600_000 });
    expect(result).toMatchObject({ done: true, outcome: "already_complete", written: [] });
    expect(await listAll(`b/db/${date}/`)).toEqual(before);
  }, 120_000);

  it("standing check (a): an account purged after a dead pass — the next pass starts over, the set restores with no dangling row", async () => {
    const date = "2099-03-01";
    const victim = await seedAccount();
    await expect(
      backupPass(ctx().bg, { date, bucket: failingPut(tableKey(date, "user")), softDeadlineMs: 600_000 }),
    ).rejects.toThrow();
    await purgeAccount(victim);
    const second = await backupPass(ctx().bg, { date, softDeadlineMs: 600_000 });
    expect(second.done).toBe(true);
    expect(second.written).toContain("nodes");
    const target = await scratchTarget();
    const result = await restoreSet({ date, read: readLocal, sql: target.sql });
    expect(result.dangling).toEqual([]);
    expect(
      (await target.client.query(`SELECT 1 FROM nodes WHERE owner_id = $1`, [victim.userId])).rows,
    ).toHaveLength(0);
  }, 600_000);

  it("M1: a move between two pages of `nodes` cannot make a cycle — every row of a set is one snapshot", async () => {
    const date = "2099-06-01";
    const owner = await makeUser();
    // Fourteen folders; A is the first in key order and B the last, so twelve rows lie between
    // them and they land on different pages. A sits in B.
    const made: string[] = [];
    for (let i = 0; i < 14; i++) made.push((await makeFolder(owner.id)).id);
    extraNodes.push(...made);
    const sorted = (
      await testDb().select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, made)).orderBy(nodes.id)
    ).map((row) => row.id);
    const nodeA = { id: sorted[0]! };
    const nodeB = { id: sorted[sorted.length - 1]! };
    await testDb().update(nodes).set({ parentId: nodeB.id }).where(eq(nodes.id, nodeA.id));
    let moved = false;
    const result = await backupPass(ctx().bg, {
      date,
      softDeadlineMs: 600_000,
      pageRows: 5,
      afterPage: async (table, _page, lines) => {
        const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id);
        if (moved || table !== "nodes" || !ids.includes(nodeA.id)) return;
        if (ids.includes(nodeB.id)) throw new Error("A and B on one page: the test proves nothing");
        moved = true;
        // A to the top level, then B into A — each legal at its moment.
        await testDb().update(nodes).set({ parentId: null }).where(eq(nodes.id, nodeA.id));
        await testDb().update(nodes).set({ parentId: nodeA.id }).where(eq(nodes.id, nodeB.id));
      },
    });
    expect(moved).toBe(true);
    expect(result.done).toBe(true);
    const target = await scratchTarget();
    await restoreSet({ date, read: readLocal, sql: target.sql });
    const pair = await target.client.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM nodes WHERE id = ANY($1::uuid[])`,
      [[nodeA.id, nodeB.id]],
    );
    // The tree as it was when the pass began: A in B, B at the top.
    expect(new Map(pair.rows.map((row) => [row.id, row.parent_id]))).toEqual(
      new Map([
        [nodeA.id, nodeB.id],
        [nodeB.id, null],
      ]),
    );
    await testDb().update(nodes).set({ parentId: null }).where(eq(nodes.id, nodeB.id));
  }, 600_000);

  it("M1: a dangling row is reported; one under a legal hold refuses the restore unless dropHeldDangling", async () => {
    // Sets as a straddle would leave them: B's (not held) and HELD's (folder on legal hold) user rows gone.
    const plain = "2099-07-01";
    await copySet(today, plain, { table: "user", drop: (line) => line.includes(`"${b.userId}"`) });
    const plainTarget = await scratchTarget();
    const loaded = await restoreSet({ date: plain, read: readLocal, sql: plainTarget.sql });
    const bNodes = loaded.dangling.filter((row) => row.table === "nodes").map((row) => row.key);
    expect(bNodes).toEqual(expect.arrayContaining([b.folder, b.child, b.file]));
    expect(loaded.dangling.every((row) => !row.held)).toBe(true);

    const withHold = "2099-07-02";
    await copySet(today, withHold, { table: "user", drop: (line) => line.includes(`"${held.userId}"`) });
    const heldTarget = await scratchTarget();
    await expect(restoreSet({ date: withHold, read: readLocal, sql: heldTarget.sql })).rejects.toThrow(
      /legal hold/,
    );
    const { rows } = await heldTarget.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM nodes`);
    expect(rows[0]!.n).toBe(0);
    const forced = await restoreSet({
      date: withHold,
      read: readLocal,
      sql: heldTarget.sql,
      dropHeldDangling: true,
    });
    const heldRows = forced.dangling.filter((row) => row.held).map((row) => row.key);
    // The held folder, and everything under it (held by inheritance).
    expect(heldRows).toEqual(expect.arrayContaining([held.folder, held.child, held.file]));
    // A row ABOUT a held node (its kept version, dropped with it) is held through its node_id.
    expect(
      forced.dangling.find((row) => row.table === "node_versions" && row.key.includes(held.versionId)),
    ).toMatchObject({
      held: true,
    });
    expect(forced.warnings.some((warning) => /legal hold/.test(warning))).toBe(true);
  }, 600_000);
});
