// The one insert into `audit_log`. Called only by services/audit.ts; everything else audits
// through that service.

import type { Executor } from "../client";
import { auditLog } from "../schema";

export type AuditRow = {
  /** A Better Auth user id. No foreign key: audit rows outlive the account. */
  actorUserId: string | null;
  actorType: "user" | "admin" | "system" | "link";
  action: string;
  targetType: string | null;
  /** Either id family. */
  targetId: string | null;
  ipHashDaily: string | null;
  ua: string | null;
  country: string | null;
  requestId: string | null;
  meta: Record<string, unknown> | null;
};

export async function insertAudit(db: Executor, row: AuditRow): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: row.actorUserId,
    actorType: row.actorType,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ipHashDaily: row.ipHashDaily,
    ua: row.ua,
    country: row.country,
    requestId: row.requestId,
    meta: row.meta,
  });
}
