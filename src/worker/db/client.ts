// CONTRACT STUB (contracts-0). Owner: T05 (database), which replaces this file with the real
// client: a per-invocation `pg` Pool({ max: 5 }) through drizzle-orm/node-postgres. Until then
// these are signatures only. The three signatures do not change.
//
// `Db` becomes the drizzle instance built with T05's schema (`{ schema, casing: "snake_case" }`).
// The schema does not exist yet, so the type parameter below is a placeholder.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase<Record<string, unknown>>;

/** Takes no ExecutionContext and schedules nothing. `close()` is idempotent. */
export function createDb(env: Env): { db: Db; close: () => Promise<void> } {
  void env;
  throw new Error("not implemented: T05");
}

/** create → fn → close in `finally`. */
export async function withDb<T>(env: Env, fn: (db: Db) => Promise<T>): Promise<T> {
  void env;
  void fn;
  throw new Error("not implemented: T05");
}
