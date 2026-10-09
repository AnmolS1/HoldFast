// The database client: one `pg` Pool per invocation, through drizzle-orm/node-postgres.
//
// Four rules for everything that uses it:
//
// 1. Inside `db.transaction(cb)` use only `tx`. A query on the outer `db` runs on another pooled
//    connection: it does not see the transaction, and it deadlocks when the pool is exhausted.
// 2. `pool.end()` throws when called twice — `close()` is guarded.
// 3. Hyperdrive is transaction-pooled: consecutive statements land on different backends. No
//    session-level `SET`, no session advisory locks, no `LISTEN`, no temp tables. Use `SET LOCAL`
//    / `pg_advisory_xact_lock` inside `db.transaction`.
// 4. Never module scope: one pool per invocation.
//
// Who closes the pool: the request-context middleware for `fetch` (after the handler and the
// request's deferred work), `runBackground` for `queue()` / `scheduled()`, and `withDb` for
// scripts and tests. `createDb` itself schedules nothing.
//
// Timestamps and time zones
// - Our tables use `timestamptz`. Better Auth's generated tables use `timestamp` WITHOUT time
//   zone, and every value in them is a UTC wall-clock time.
// - Reads through Drizzle are already UTC: its session takes timestamps as raw strings and the
//   column maps a zone-less value as UTC. The type parser registered below covers the other
//   path — a RAW `pg` query (`pool.query`) — where `pg` would otherwise read a zone-less value
//   in the process's local zone.
// - Writes of a `Date` into a zone-less column must go through a Drizzle column (it sends
//   `toISOString()`). A raw `pg` parameter is serialised in the process's local zone.
// - The session time zone is never set, and nothing may depend on it. In SQL, compare a Better
//   Auth `timestamp` column with `(now() AT TIME ZONE 'UTC')`, never with a bare `now()`.

import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import { Pool, types, type PoolClient } from "pg";
import * as schema from "./schema";

/** OID of `timestamp` WITHOUT time zone. */
const TIMESTAMP_OID = 1114;

/** Reads a zone-less timestamp ("2026-01-01 06:00:00.123") as UTC. */
export function parseTimestampAsUtc(value: string): Date | number {
  if (value === "infinity") return Infinity;
  if (value === "-infinity") return -Infinity;
  return new Date(value.replace(" ", "T") + "Z");
}

types.setTypeParser(TIMESTAMP_OID, parseTimestampAsUtc);

type Schema = typeof schema;

/** The Drizzle instance: `{ schema, casing: "snake_case" }` over a per-invocation pool. */
export type Db = NodePgDatabase<Schema>;

/** What `db.transaction(async (tx) => …)` hands to its callback. */
export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * What a query helper takes as its first argument: a `Db` or a `Tx`. A helper that needs its own
 * transaction calls `.transaction()` on what it was given — inside a transaction that is a
 * savepoint — and never reaches for an outer `db` (rule 1).
 */
export type Executor = PgDatabase<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/**
 * Takes no ExecutionContext and schedules nothing. `close()` is idempotent.
 *
 * `close()` waits for every checked-out connection to be returned (pg's `pool.end()`), so it
 * never resolves while some task still holds one. `close({ force: true })` is for the caller
 * that has given up on such tasks: it first destroys the connections that are still checked out
 * — their owners' next query fails — and then ends the pool.
 */
export function createDb(env: Env): { db: Db; close: (opts?: { force?: boolean }) => Promise<void> } {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  // Connections currently lent out, so a forced close can take them back.
  const lent = new Set<PoolClient>();
  pool.on("acquire", (client) => lent.add(client));
  pool.on("release", (_error, client) => lent.delete(client));
  let closed = false;
  return {
    db,
    close: async (opts = {}) => {
      if (closed) return;
      closed = true;
      if (opts.force) {
        for (const client of [...lent]) {
          lent.delete(client);
          try {
            // `true` destroys the connection instead of returning it to the pool.
            client.release(true);
          } catch {
            // Already released by its owner in the meantime.
          }
        }
      }
      await pool.end();
    },
  };
}

/** create → fn → close in `finally`. For scripts and tests. */
export async function withDb<T>(env: Env, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = createDb(env);
  try {
    return await fn(db);
  } finally {
    await close();
  }
}
