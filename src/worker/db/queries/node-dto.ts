// The one read the Node → NodeDto mapper makes of its own (`services/node-dto.ts`).

import { inArray, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { user } from "../schema";

/**
 * The display name of each of these users, in one statement (none for an empty set). Only `id`
 * and the name leave the database — never the address: a name that IS the user's own address
 * comes back as `""`, and the comparison is made in the statement.
 * An id no user has (a deleted account) is simply not in the map.
 */
export async function displayNames(db: Executor, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({
      id: user.id,
      displayName: sql<string>`CASE WHEN lower(${user.name}) = lower(${user.email}) THEN '' ELSE ${user.name} END`,
    })
    .from(user)
    .where(inArray(user.id, wanted));
  return new Map(rows.map((row) => [row.id, row.displayName]));
}
