// CONTRACT STUB (contracts-0). Owner: T05 (database), which replaces this file with the real
// insert. Until then this is a signature only.

import type { Db } from "../client";

/** The one insert into `audit_log`. Called only by `services/audit.ts`. */
export async function insertAudit(
  db: Db,
  row: {
    actorUserId: string | null;
    actorType: "user" | "admin" | "system" | "link";
    action: string;
    targetType: string | null;
    targetId: string | null;
    ipHashDaily: string | null;
    ua: string | null;
    country: string | null;
    requestId: string | null;
    meta: Record<string, unknown> | null;
  },
): Promise<void> {
  void db;
  void row;
  throw new Error("not implemented: T05");
}
