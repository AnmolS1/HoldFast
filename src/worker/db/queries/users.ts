// CONTRACT STUB (contracts-0). Owner: T05 (database), which replaces this file with the real
// queries and adds the rest of the module. Until then these are signatures only.

import type { Db } from "../client";

/** `banned` honours `banExpires`. Null when no user has that id. */
export async function userState(
  db: Db,
  userId: string,
): Promise<{
  banned: boolean;
  suspendedAt: Date | null;
  deleteScheduledAt: Date | null;
  legalHold: boolean;
} | null> {
  void db;
  void userId;
  throw new Error("not implemented: T05");
}

/** One primary-key read of `user.termsVersion`. */
export async function termsVersionOf(db: Db, userId: string): Promise<string | null> {
  void db;
  void userId;
  throw new Error("not implemented: T05");
}
