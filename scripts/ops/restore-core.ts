// The restore of one dated backup set into an EMPTY migrated database — the logic, with no I/O of
// its own: it is handed a way to read an object of the set and one database connection. The CLI
// (scripts/restore-from-backup.ts) hands it `wrangler r2 object get` and `pg`; the Workers test
// hands it the local bucket and a scratch schema. Web APIs only (DecompressionStream,
// crypto.subtle), so it runs in Node and in workerd alike.
//
// WHAT IT REFUSES, before it writes anything:
//   - a date without `_manifest.json` (an incomplete set: the export writes the manifest last);
//   - a set written while the rollback detector read anything but "ok", unless the caller says it
//     has seen the warning (`acceptDetection`);
//   - ANOTHER SCHEMA VERSION: the target's tables are not exactly the set's (every table of the
//     target's schema counts — an operator's scratch table too), its migration level is not the
//     set's (drizzle's last applied migration), or any table's columns — names, order, types —
//     differ. `jsonb_populate_recordset` would otherwise load such a set SILENTLY wrong (a renamed
//     column's data dropped, a new column NULL instead of its default). Migrate the empty target to
//     the set's level first, restore, then run the newer migrations;
//   - a target with any row in any table;
//   - an object whose size or SHA-256 differs from the manifest's.
//
// HOW IT LOADS — ONE TRANSACTION, so a failure leaves the target as empty as it found it:
//   1. every table's lines into a staging copy (`CREATE TEMP TABLE … (LIKE …)`, no constraints),
//      through `jsonb_populate_recordset(NULL::<table>, …)` — Postgres reads its own `to_jsonb`
//      output back, types and all — then `ANALYZE`d for the anti-joins below;
//   2. DANGLING ROWS. A set written by this project's job is one snapshot and has none; a set from
//      elsewhere (an older format, a hand-made one) may name a parent it lacks. Each such row gets
//      what the database itself does when a parent goes: its foreign key's ON DELETE rule — SET
//      NULL nulls the reference; CASCADE, RESTRICT and NO ACTION drop the row (and whatever then
//      names IT, to a fixed point). Every row so changed is NAMED (table, constraint, primary key —
//      masked where the key is itself a secret). NEVER SILENTLY UNDER A HOLD: a dropped row that a
//      legal hold protects (its node's, an ancestor folder's, its owner's, or its own flag) REFUSES
//      the restore unless the caller says to drop it anyway (`dropHeldDangling`);
//   3. into the real tables, parents first; a table that references itself (`nodes.parent_id`)
//      level by level — the rows whose parent is already loaded, until a round loads none. (Not
//      for the foreign key, which Postgres checks at the end of each statement: for the partial
//      unique indexes on live names, which ARE checked row by row — loading children before their
//      folder exists would make them top-level names for a moment.);
//   4. `session` and `verification` are emptied (the job exports them with no rows anyway): no
//      restored session token comes back to life, everyone signs in again;
//   5. every table's count is checked against the manifest's, less the rows step 2 dropped.

export type RestoreSql = {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

export type ManifestTable = { name: string; rows: number; bytes: number; sha256: string; columns?: string[] };
export type RestoreManifest = {
  commit: string;
  startedAt: string;
  finishedAt: string;
  detection?: string;
  migration?: { tag: string | null; when: number | null };
  tables: ManifestTable[];
};

export type Dangling = {
  table: string;
  constraint: string;
  action: "set_null" | "dropped";
  /** The primary key, comma-joined — or `sha256:<12 hex>` where the key is itself a secret. */
  key: string;
  /** A legal hold protects the row (its node, an ancestor folder, its owner, or its own flag). */
  held: boolean;
};

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
/** Tables whose primary key is itself a secret (a live invite code; a blocked file's hash): never printed. */
export const SECRET_KEY_TABLES = ["invites", "hash_blocklist"] as const;

export const setKey = (date: string, name: string) => `b/db/${date}/${name}`;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const stage = (name: string) => ident(`_restore_${name}`);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What may be shown of a row's key: the key, or a short hash of it for a secret key. */
export async function printableKey(table: string, key: string): Promise<string> {
  if (!(SECRET_KEY_TABLES as readonly string[]).includes(table)) return key;
  return `sha256:${(await sha256Hex(new TextEncoder().encode(key))).slice(0, 12)}`;
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
  /** Dangling rows under a legal hold would be dropped: drop them anyway (after recording them). */
  dropHeldDangling?: boolean;
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
      `another schema version: the set and the target differ in tables (not in the set: ${missing.join(", ") || "none"}; not in the target: ${extra.join(", ") || "none"}). Every table of the target's schema counts, a scratch table too`,
    );
  }
  let targetWhen: number | null = null;
  try {
    const level = await sql.query<{ when: string | number | null }>(
      `SELECT max(created_at)::bigint AS "when" FROM drizzle.__drizzle_migrations`,
    );
    const raw = level.rows[0]?.when;
    targetWhen = raw === null || raw === undefined ? null : Number(raw);
  } catch {
    targetWhen = null;
  }
  const setWhen = manifest.migration?.when ?? null;
  if (setWhen === null || targetWhen !== setWhen) {
    throw new RestoreRefusal(
      `another schema version: the set's migration level is ${manifest.migration?.tag ?? "not recorded"} (${String(setWhen)}), the target's is ${String(targetWhen)} — migrate the empty target to the set's level first, restore, then run the newer migrations`,
    );
  }
  const columnRows = await sql.query<{ table: string; columns: string[] }>(
    `SELECT table_name::text AS "table",
            array_agg(column_name::text || ':' || udt_name::text ORDER BY ordinal_position) AS columns
     FROM information_schema.columns WHERE table_schema = current_schema() GROUP BY table_name`,
  );
  const targetColumns = new Map(columnRows.rows.map((row) => [row.table, row.columns]));
  for (const table of manifest.tables) {
    const set = (table.columns ?? []).join(", ");
    const target = (targetColumns.get(table.name) ?? []).join(", ");
    if (set !== target) {
      throw new RestoreRefusal(
        `another schema version: the columns of ${table.name} differ (set: ${set || "not recorded"}; target: ${target})`,
      );
    }
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
      await sql.query(`ANALYZE ${stage(name)}`);
    }

    // What a legal hold protects, read BEFORE anything is dropped (the folder that carries a hold
    // may be among the dropped rows): held accounts, and held nodes — their own flag, their
    // owner's, or any ancestor's (inherited, as db/queries/holds.ts reaches down from a folder).
    const heldUsers = new Set<string>();
    const heldNodes = new Set<string>();
    if (order.includes("user")) {
      const users = await sql.query<{ id: string }>(
        `SELECT id::text AS id FROM ${stage("user")} WHERE legal_hold`,
      );
      for (const row of users.rows) heldUsers.add(row.id);
    }
    if (order.includes("nodes") && order.includes("user")) {
      const held = await sql.query<{ id: string }>(`
        WITH RECURSIVE held(id) AS (
          SELECT n.id FROM ${stage("nodes")} n LEFT JOIN ${stage("user")} u ON u.id = n.owner_id
          WHERE n.legal_hold OR COALESCE(u.legal_hold, false)
          UNION
          SELECT c.id FROM ${stage("nodes")} c JOIN held h ON c.parent_id = h.id)
        SELECT id::text AS id FROM held`);
      for (const row of held.rows) heldNodes.add(row.id);
    }
    const isHeld = (table: string, row: Record<string, unknown>): boolean =>
      row.legal_hold === true ||
      (table === "nodes" && heldNodes.has(String(row.id))) ||
      (typeof row.node_id === "string" && heldNodes.has(row.node_id)) ||
      ["owner_id", "user_id"].some(
        (column) => typeof row[column] === "string" && heldUsers.has(row[column] as string),
      );

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
               WHERE ${missingParent} RETURNING ${keyText} AS key, to_jsonb(s) AS row`
            : `DELETE FROM ${stage(key.table)} s WHERE ${missingParent} RETURNING ${keyText} AS key, to_jsonb(s) AS row`;
        const touched = await sql.query<{ key: string; row: Record<string, unknown> }>(statement);
        for (const row of touched.rows) {
          dangling.push({
            table: key.table,
            constraint: key.name,
            action: key.onDelete === "n" ? "set_null" : "dropped",
            key: await printableKey(key.table, row.key),
            held: isHeld(key.table, row.row),
          });
        }
        if (touched.rows.length) changed = true;
      }
    }

    // Never a held row dropped without the caller's word for it.
    const heldDropped = dangling.filter((row) => row.held && row.action === "dropped");
    if (heldDropped.length) {
      const named = heldDropped
        .slice(0, 20)
        .map((row) => `${row.table} ${row.key}`)
        .join("; ");
      const message = `${heldDropped.length} dangling row(s) under a legal hold would be dropped (${named}${heldDropped.length > 20 ? "; …" : ""})`;
      if (!options.dropHeldDangling) {
        throw new RestoreRefusal(
          `${message} — record them for runbook step 3(a), then pass the acknowledgement to drop them`,
        );
      }
      warnings.push(message);
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
