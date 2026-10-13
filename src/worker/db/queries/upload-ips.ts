// Encrypted uploader IPs, kept for lawful reporting only. Rows carry no foreign key: they
// outlive the node and the account for their retention period (90 days, or as long as they are
// held: the row's own `legalHold`, a hold on the uploader's account — a held account keeps EVERY
// address it uploaded from, also for files that are not held themselves — or a node the purge
// gate protects, queries/holds.ts).
// Only ciphertext passes through here.

import { and, eq, inArray, lt, not, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type UploadIp, uploadIps } from "../schema";
import { nodeProtected, userHeld } from "./holds";

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

/**
 * Past retention and kept by nothing: not the row's own flag, not a hold on its uploader, and
 * not its node — a node the purge gate protects (its hold, its OWNER's hold, `under_review`,
 * `suspected_csam`, an open notice) keeps the addresses of everyone who uploaded to it.
 * For a row whose node is gone only the flag and the uploader's hold can still be known.
 */
const pastRetention = (olderThanDays: number) =>
  and(
    eq(uploadIps.legalHold, false),
    lt(uploadIps.at, sql`now() - make_interval(days => ${olderThanDays})`),
    not(userHeld(sql`${uploadIps.uploaderId}`)),
    not(nodeProtected(sql`${uploadIps.nodeId}`)),
  );

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
