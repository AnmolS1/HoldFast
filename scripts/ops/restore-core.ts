// The restore of one dated backup set into an EMPTY migrated database — the logic, with no I/O of
// its own: it is handed a way to read an object of the set and one database connection. The CLI
// (scripts/restore-from-backup.ts) hands it `wrangler r2 object get` and `pg`; the Workers test
// hands it the local bucket and a scratch schema. Web APIs only (DecompressionStream,
// crypto.subtle), so it runs in Node and in workerd alike.
//
// WHAT IT REFUSES, before it writes anything:
//   - a date without `_manifest.json` (an incomplete set: the export writes the manifest last);
//   - an object whose size or SHA-256 differs from the manifest's;
//   - a manifest whose tables are not exactly the target's (another schema version);
//   - a target with any row in any table (it loads only into an empty migrated database);
//   - a set written while the rollback detector read anything but "ok", unless the caller says it
//     has seen the warning (`acceptDetection`).
//
// HOW IT LOADS — ONE TRANSACTION, so a failure leaves the target as empty as it found it:
//   1. every table's lines into a staging copy (`CREATE TEMP TABLE … (LIKE …)`, no constraints),
//      through `jsonb_populate_recordset(NULL::<table>, …)` — Postgres reads its own `to_jsonb`
//      output back, types and all;
//   2. DANGLING ROWS. A set is written over several passes, so a row can name a parent that was
//      removed between them (standing check (a): an account purged between two passes). Each
//      such row gets what the database itself did to it when the parent went: its foreign key's
//      ON DELETE rule — SET NULL nulls the reference; CASCADE, RESTRICT and NO ACTION drop the row
//      (and whatever then names IT, to a fixed point). Every row so changed is NAMED (table,
//      constraint, primary key) in the result; nothing is dropped silently;
//   3. into the real tables, parents first; a table that references itself (`nodes.parent_id`, a
//      NON-deferrable foreign key) level by level: the rows whose parent is already loaded, until
//      a round loads none;
//   4. `session` and `verification` are emptied: no restored session token comes back to life,
//      everyone signs in again;
//   5. every table's count is checked against the manifest's, less the rows step 2 dropped.

export type RestoreSql = {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

export type ManifestTable = { name: string; rows: number; bytes: number; sha256: string };
export type RestoreManifest = {
  commit: string;
  startedAt: string;
  finishedAt: string;
  detection?: string;
  tables: ManifestTable[];
};

export type Dangling = { table: string; constraint: string; action: "set_null" | "dropped"; key: string };

export type RestoreResult = {
  manifest: RestoreManifest;
  /** Rows per table as loaded (session and verification: before they were emptied). */
  loaded: Record<string, number>;
  dangling: Dangling[];
  warnings: string[];
};

export class RestoreRefusal extends Error {}

/** Tables emptied after the load: nobody's session comes back. */
export const SIGNED_OUT_TABLES = ["session", "verification"] as const;
const BATCH_LINES = 500;

export const setKey = (date: string, name: string) => `b/db/${date}/${name}`;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const stage = (name: string) => ident(`_restore_${name}`);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

type ForeignKey = {
  name: string;
  table: string;
  columns: string[];
  target: string;
  targetColumns: string[];
  /** pg_constraint.confdeltype: a no action, r restrict, c cascade, n set null, d set default. */
  onDelete: string;
};

async function foreignKeys(sql: RestoreSql): Promise<ForeignKey[]> {
  const result = await sql.query<{
    name: string;
    table: string;
    columns: string[];
    target: string;
    target_columns: string[];
    on_delete: string;
  }>(`
    SELECT f.conname AS name, src.relname AS "table", dst.relname AS target, f.confdeltype::text AS on_delete,
           ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.n ORDER BY k.o) AS columns,
           ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.n ORDER BY k.o) AS target_columns
    FROM pg_constraint f
    JOIN pg_class src ON src.oid = f.conrelid
    JOIN pg_class dst ON dst.oid = f.confrelid
    WHERE f.contype = 'f' AND src.relnamespace = current_schema()::regnamespace
    ORDER BY f.conname`);
  return result.rows.map((row) => ({
    name: row.name,
    table: row.table,
    columns: row.columns,
    target: row.target,
    targetColumns: row.target_columns,
    onDelete: row.on_delete,
  }));
}

async function primaryKeys(sql: RestoreSql): Promise<Map<string, string[]>> {
  const result = await sql.query<{ table: string; columns: string[] }>(`
    SELECT c.relname AS "table", array_agg(a.attname::text ORDER BY k.o) AS columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid AND c.relnamespace = current_schema()::regnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(n, o)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.n
    WHERE i.indisprimary
    GROUP BY c.relname`);
  return new Map(result.rows.map((row) => [row.table, row.columns]));
}

/** Parents before children; a self-reference does not order. */
export function loadOrder(tables: string[], keys: ForeignKey[]): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const pending = [...tables].sort();
  while (pending.length) {
    const next = pending.find((name) =>
      keys
        .filter((key) => key.table === name && key.target !== name && tables.includes(key.target))
        .every((key) => placed.has(key.target)),
    );
    if (!next) throw new RestoreRefusal(`a foreign-key cycle among ${pending.join(", ")}`);
    order.push(next);
    placed.add(next);
    pending.splice(pending.indexOf(next), 1);
  }
  return order;
}

export type RestoreOptions = {
  date: string;
  /** The object's bytes, or null when it does not exist. */
  read(key: string): Promise<Uint8Array | null>;
  sql: RestoreSql;
  /** The set was written while the detector read rollback (or anything but ok): load it anyway. */
  acceptDetection?: boolean;
  log?: (line: string) => void;
};

export async function restoreSet(options: RestoreOptions): Promise<RestoreResult> {
  const { sql, date } = options;
  const log = options.log ?? (() => {});
  const warnings: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RestoreRefusal("the date must be YYYY-MM-DD");

  // ── checks before anything is written ──
  const manifestBytes = await options.read(setKey(date, "_manifest.json"));
  if (!manifestBytes)
    throw new RestoreRefusal(`no _manifest.json for ${date}: an incomplete set is never restored`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RestoreManifest;
  if (!Array.isArray(manifest.tables) || manifest.tables.length === 0) {
    throw new RestoreRefusal("the manifest lists no tables");
  }
  // Any value but "ok" (rollback, paused, unknown, not_read, or none recorded) is warned about.
  if (manifest.detection !== "ok") {
    const warning = `this set was written while the rollback detector read "${String(manifest.detection ?? "nothing")}"`;
    warnings.push(warning);
    if (!options.acceptDetection) {
      throw new RestoreRefusal(
        `${warning} — read runbooks/backup-restore.md, then pass the acknowledgement to load it`,
      );
    }
  }

  const targetTables = (
    await sql.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`,
    )
  ).rows.map((row) => row.name);
  const listed = manifest.tables.map((table) => table.name).sort();
  const missing = targetTables.filter((name) => !listed.includes(name));
  const extra = listed.filter((name) => !targetTables.includes(name));
  if (missing.length || extra.length) {
    throw new RestoreRefusal(
      `the set and the target differ in tables (not in the set: ${missing.join(", ") || "none"}; not in the target: ${extra.join(", ") || "none"}) — another schema version`,
    );
  }
  for (const name of targetTables) {
    const rows = await sql.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${ident(name)}) AS any`);
    if (rows.rows[0]?.any)
      throw new RestoreRefusal(
        `the target is not empty (${name} has rows): restore into an empty migrated database`,
      );
  }

  const texts = new Map<string, string>();
  for (const table of manifest.tables) {
    const bytes = await options.read(setKey(date, `${table.name}.jsonl.gz`));
    if (!bytes) throw new RestoreRefusal(`${table.name}: its object is missing`);
    if (bytes.byteLength !== table.bytes)
      throw new RestoreRefusal(`${table.name}: size differs from the manifest`);
    if ((await sha256Hex(bytes)) !== table.sha256)
      throw new RestoreRefusal(`${table.name}: SHA-256 differs from the manifest`);
    texts.set(table.name, await gunzipText(bytes));
  }
  log(`verified ${manifest.tables.length} objects against the manifest`);

  const keys = await foreignKeys(sql);
  const pks = await primaryKeys(sql);
  const order = loadOrder(targetTables, keys);
  const loaded: Record<string, number> = {};
  const dangling: Dangling[] = [];

  await sql.query("BEGIN");
  try {
    // 1. staging
    for (const name of order) {
      await sql.query(`CREATE TEMP TABLE ${stage(name)} (LIKE ${ident(name)}) ON COMMIT DROP`);
      const lines = texts
        .get(name)!
        .split("\n")
        .filter((line) => line !== "");
      for (let at = 0; at < lines.length; at += BATCH_LINES) {
        const batch = `[${lines.slice(at, at + BATCH_LINES).join(",")}]`;
        await sql.query(
          `INSERT INTO ${stage(name)} SELECT * FROM jsonb_populate_recordset(NULL::${ident(name)}, $1::jsonb)`,
          [batch],
        );
      }
      const expected = manifest.tables.find((table) => table.name === name)!.rows;
      if (lines.length !== expected)
        throw new RestoreRefusal(`${name}: ${lines.length} lines, the manifest says ${expected}`);
      loaded[name] = lines.length;
    }

    // 2. dangling rows, to a fixed point
    for (let changed = true; changed;) {
      changed = false;
      for (const key of keys) {
        if (!order.includes(key.table) || !order.includes(key.target)) continue;
        const pk = pks.get(key.table)!;
        const missingParent = `${key.columns.map((c) => `s.${ident(c)} IS NOT NULL`).join(" AND ")}
          AND NOT EXISTS (SELECT 1 FROM ${stage(key.target)} p WHERE ${key.columns
            .map((c, i) => `p.${ident(key.targetColumns[i]!)} = s.${ident(c)}`)
            .join(" AND ")})`;
        const keyText = `concat_ws(',', ${pk.map((c) => `s.${ident(c)}::text`).join(", ")})`;
        const statement =
          key.onDelete === "n"
            ? `UPDATE ${stage(key.table)} s SET ${key.columns.map((c) => `${ident(c)} = NULL`).join(", ")}
               WHERE ${missingParent} RETURNING ${keyText} AS key`
            : `DELETE FROM ${stage(key.table)} s WHERE ${missingParent} RETURNING ${keyText} AS key`;
        const touched = await sql.query<{ key: string }>(statement);
        for (const row of touched.rows) {
          dangling.push({
            table: key.table,
            constraint: key.name,
            action: key.onDelete === "n" ? "set_null" : "dropped",
            key: row.key,
          });
        }
        if (touched.rows.length) changed = true;
      }
    }

    // 3. into the real tables, parents first; a self-referencing table level by level
    for (const name of order) {
      const self = keys.filter((key) => key.table === name && key.target === name);
      if (self.length === 0) {
        await sql.query(`INSERT INTO ${ident(name)} SELECT * FROM ${stage(name)}`);
        continue;
      }
      const pk = pks.get(name)!;
      const notYet = `NOT EXISTS (SELECT 1 FROM ${ident(name)} t WHERE ${pk.map((c) => `t.${ident(c)} = s.${ident(c)}`).join(" AND ")})`;
      const parentsIn = self
        .map(
          (key) =>
            `(${key.columns.map((c) => `s.${ident(c)} IS NULL`).join(" OR ")} OR EXISTS (SELECT 1 FROM ${ident(name)} p WHERE ${key.columns
              .map((c, i) => `p.${ident(key.targetColumns[i]!)} = s.${ident(c)}`)
              .join(" AND ")}))`,
        )
        .join(" AND ");
      for (;;) {
        const round = await sql.query<{ n: number }>(
          `WITH moved AS (INSERT INTO ${ident(name)} SELECT * FROM ${stage(name)} s WHERE ${notYet} AND ${parentsIn} RETURNING 1)
           SELECT count(*)::int AS n FROM moved`,
        );
        if ((round.rows[0]?.n ?? 0) === 0) break;
      }
      const left = await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${stage(name)} s WHERE ${notYet}`,
      );
      if ((left.rows[0]?.n ?? 0) > 0)
        throw new RestoreRefusal(`${name}: ${left.rows[0]!.n} rows form a cycle and cannot be loaded`);
    }

    // 4. everyone signs in again
    for (const name of SIGNED_OUT_TABLES) {
      if (order.includes(name)) await sql.query(`DELETE FROM ${ident(name)}`);
    }

    // 5. counts
    for (const name of order) {
      const dropped = dangling.filter((row) => row.table === name && row.action === "dropped").length;
      const expected = (SIGNED_OUT_TABLES as readonly string[]).includes(name) ? 0 : loaded[name]! - dropped;
      const count = (await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident(name)}`)).rows[0]!
        .n;
      if (count !== expected) throw new RestoreRefusal(`${name}: ${count} rows loaded, expected ${expected}`);
    }
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK").catch(() => {});
    throw error;
  }
  log(
    `restored ${order.length} tables; ${dangling.length} dangling row(s) resolved by their foreign key's ON DELETE rule; session and verification emptied`,
  );
  return { manifest, loaded, dangling, warnings };
}
