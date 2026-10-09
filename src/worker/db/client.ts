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

import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
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

/** The longest one statement inside a transaction may run. */
export const TX_STATEMENT_TIMEOUT_MS = 30_000;
/** The longest a transaction may sit idle between two statements. */
export const TX_IDLE_TIMEOUT_MS = 30_000;

/**
 * Takes no ExecutionContext and schedules nothing. `close()` is idempotent.
 *
 * `close()` is pg's `pool.end()`: it resolves only once EVERY connection has come back
 * (pg-pool 3.14 index.js `_pulseQueue`: an ending pool removes its idle clients and calls the end
 * callback only when `_clients` is empty). A task that sits on a connection — a query in flight,
 * a transaction it never commits — therefore blocks it for ever.
 *
 * `close({ force: true })` is for the caller that has given up on such tasks. It may be called
 * first, or after a plain `close()` that did not return. For every connection still lent out:
 *   1. `client.release(true)` — pg-pool `_release` with a truthy argument goes to `_remove`,
 *      which drops the client from `_clients` at once and calls `client.end()` (pg 8.23
 *      lib/client.js `end`: with a query in flight it destroys the socket, otherwise it sends
 *      Terminate);
 *   2. `client.release` is then replaced with a no-op: pg-pool's own `pool.query` wrapper, and a
 *      task that wakes up later, will call it again, and the original throws "Release called on
 *      client which has already been released" from inside an event callback;
 *   3. the socket is destroyed (`client.connection.stream.destroy()`, the call pg-pool itself
 *      uses for a timed-out client), so the server-side session ends now, not when the server
 *      next reads from it. `client.end()` has already marked the client as ending, so this
 *      raises no "terminated unexpectedly" error; an error listener is attached regardless.
 * The abandoned owners' next use of their connection fails; nothing waits for them.
 *
 * NOTHING is sent to the server about the abandoned work: no CancelRequest, no
 * `pg_cancel_backend` / `pg_terminate_backend`. Those address a backend by process id, and behind
 * Hyperdrive's transaction pooling the backend an invocation saw may be serving ANOTHER
 * invocation's statement by the time a cancel lands. The forced close touches only this
 * invocation's own sockets. What then stops the work on the server:
 *   - inside a transaction, the two limits every transaction of this handle sets for itself
 *     (`TX_STATEMENT_TIMEOUT_MS`, `TX_IDLE_TIMEOUT_MS` — `SET LOCAL`, so they end with the
 *     transaction; a session-level SET is not possible behind transaction pooling);
 *   - a single auto-commit statement outside a transaction has no such limit: it is bounded only
 *     by the destroyed socket and by what the server (or Hyperdrive) does about a client that is
 *     gone — Postgres notices at its next read or write on that connection.
 */
export function createDb(
  env: Env,
  limits: { statementTimeoutMs?: number; idleInTransactionTimeoutMs?: number } = {},
): { db: Db; close: (opts?: { force?: boolean }) => Promise<void> } {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  const db = drizzle(pool, { schema, casing: "snake_case" });

  // Every top-level transaction bounds itself on the SERVER, first thing: one statement may run
  // for at most `statementTimeoutMs`, and the transaction may sit idle between statements for at
  // most `idleInTransactionTimeoutMs`. So a transaction whose client has gone away (a forced
  // close, an isolate that died) cannot hold its locks and its connection for long. Savepoints
  // (`tx.transaction`) inherit the limits of the transaction they are in.
  const statementMs = Math.trunc(limits.statementTimeoutMs ?? TX_STATEMENT_TIMEOUT_MS);
  const idleMs = Math.trunc(limits.idleInTransactionTimeoutMs ?? TX_IDLE_TIMEOUT_MS);
  if (!(statementMs > 0) || !(idleMs > 0)) throw new Error("transaction limits must be positive");
  // `set_config(name, value, is_local => true)` is SET LOCAL as a function: one statement for
  // both settings, and they end with the transaction.
  const setLimits = sql`SELECT set_config('statement_timeout', ${String(statementMs)}, true),
    set_config('idle_in_transaction_session_timeout', ${String(idleMs)}, true)`;
  const begin = db.transaction.bind(db);
  db.transaction = ((run, config) =>
    begin(async (tx) => {
      await tx.execute(setLimits);
      return run(tx);
    }, config)) as typeof db.transaction;

  // Connections currently lent out, so a forced close can take them back.
  const lent = new Set<PoolClient>();
  // …and every statement any of them sends is counted (`statementsSent`): the auth routes bring
  // each of their answers to one fixed number of round trips, whatever the answer is.
  const counter = { sent: 0 };
  statementCounters.set(db, counter);
  const counted = new WeakSet<PoolClient>();
  pool.on("acquire", (client) => {
    lent.add(client);
    if (counted.has(client)) return;
    counted.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
      counter.sent += 1;
      return query(...args);
    };
  });
  pool.on("release", (_error, client) => lent.delete(client));
  let ending: Promise<void> | null = null;

  const takeBack = (client: PoolClient): void => {
    lent.delete(client);
    client.on("error", () => {});
    try {
      client.release(true);
    } catch {
      // Released by its owner in the meantime.
    }
    client.release = () => {};
    try {
      (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    } catch {
      // Already gone.
    }
  };

  return {
    db,
    close: async (opts = {}) => {
      // Before pool.end() on a first forced call, so that the pool finds itself empty at once.
      if (opts.force) for (const client of [...lent]) takeBack(client);
      ending ??= pool.end();
      await ending;
    },
  };
}

const statementCounters = new WeakMap<object, { sent: number }>();

/** How many statements this handle's connections have sent so far (0 for a handle not made here). */
export function statementsSent(db: Db): number {
  return statementCounters.get(db)?.sent ?? 0;
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
