// Encrypted uploader IPs, kept for lawful reporting only. Rows carry no foreign key: they
// outlive the node and the account for their retention period (90 days, or as long as
// `legalHold` is set). Only ciphertext passes through here.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type UploadIp, uploadIps } from "../schema";

export const UPLOAD_IP_RETENTION_DAYS = 90;

/** One row per uploaded version, written in the transaction that completes the upload. */
export async function record(
  tx: Executor,
  row: {
    nodeId: string;
    versionId: string;
    uploaderId: string;
    ipEncrypted: Uint8Array;
    iv: Uint8Array;
    keyVersion: number;
  },
): Promise<string> {
  const [inserted] = await tx
    .insert(uploadIps)
    .values({
      nodeId: row.nodeId,
      versionId: row.versionId,
      uploaderId: row.uploaderId,
      ipEncrypted: row.ipEncrypted,
      iv: row.iv,
      keyVersion: row.keyVersion,
    })
    .returning({ id: uploadIps.id });
  return inserted!.id;
}

/** The node's rows, oldest first: ciphertext, IV and key version, for the reporting procedure. */
export async function forNode(db: Executor, nodeId: string): Promise<UploadIp[]> {
  if (!isUuid(nodeId)) return [];
  return db.select().from(uploadIps).where(eq(uploadIps.nodeId, nodeId)).orderBy(uploadIps.at, uploadIps.id);
}

const pastRetention = (olderThanDays: number) =>
  and(eq(uploadIps.legalHold, false), lt(uploadIps.at, sql`now() - make_interval(days => ${olderThanDays})`));

/** Ids of rows past retention and not held, oldest first. */
export async function expired(
  db: Executor,
  limit: number,
  olderThanDays: number = UPLOAD_IP_RETENTION_DAYS,
): Promise<string[]> {
  const rows = await db
    .select({ id: uploadIps.id })
    .from(uploadIps)
    .where(pastRetention(olderThanDays))
    .orderBy(uploadIps.at)
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Deletes up to `limit` rows past retention and not held. Returns how many went. */
export async function deleteExpired(
  db: Executor,
  limit: number,
  olderThanDays: number = UPLOAD_IP_RETENTION_DAYS,
): Promise<number> {
  const doomed = db
    .select({ id: uploadIps.id })
    .from(uploadIps)
    .where(pastRetention(olderThanDays))
    .limit(limit);
  const rows = await db
    .delete(uploadIps)
    .where(and(inArray(uploadIps.id, doomed), eq(uploadIps.legalHold, false)))
    .returning({ id: uploadIps.id });
  return rows.length;
}
