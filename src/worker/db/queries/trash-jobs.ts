// Queries only the trash routes and the scheduled jobs make: the purge-request marker, the
// retention deletes, the reads the account purge and the reconcile job need, and the rollback
// detector's number with the lock its writers share.
//
// WHAT A RETENTION DELETE KEEPS is not decided here. Every delete below asks queries/holds.ts —
// `userHeld` and `nodeProtected`, the record the purge gate is generated from — in the deleting
// statement itself, so a row that concerns a held account or a protected node is never listed
// first and deleted later. Each is ONE statement over many owners and takes no tree lock: a hold
// placed while it runs protects from the next run on (accepted residual, H1 X2.3).
//
// Nothing here writes a `legalHold` column: no job sets or releases a hold.

import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { UUID_PARAM } from "../../../shared/ids";
import type { Executor } from "../client";
import { session } from "../auth-schema";
import { isUuid } from "../ids";
import {
  auditLog,
  linkAccessLog,
  nodes,
  nodeVersions,
  pendingUserPurges,
  reports,
  type Upload,
  uploads,
  user,
} from "../schema";
import { nodeProtected, userHeld } from "./holds";
import { clearSettingsCache } from "./settings";
import { notPurgeRequested } from "./trash";
import { lockOwnerTree, notEffectivelyHidden } from "./tree";
import { COMPLETING_STALE_MINUTES, owesLockedNode } from "./uploads";
import { markStarted } from "./user-purge";
import { lockUser } from "./users";

// ── the trash routes ────────────────────────────────────────────────────────────────────────

/**
 * The owner asked for these trashed roots to be deleted for good while the gate refused: the
 * marker hides them from the trash listing and keeps them in the purge queue until the hold is
 * gone. The first request's time is kept. Returns how many rows carry the marker now.
 */
export async function requestPurge(db: Executor, rootIds: readonly string[]): Promise<number> {
  const ids = [...new Set(rootIds.filter(isUuid))];
  if (ids.length === 0) return 0;
  const rows = await db
    .update(nodes)
    .set({ purgeRequestedAt: sql`COALESCE(${nodes.purgeRequestedAt}, now())` })
    .where(and(inArray(nodes.id, ids), eq(nodes.trashedRoot, true), isNotNull(nodes.deletedAt)))
    .returning({ id: nodes.id });
  return rows.length;
}

/**
 * True when the node, or a folder above it, is a root whose purge was requested. To its owner
 * such a node is gone — it answers as a purged one does. False for an id that does not exist.
 * One statement, whatever the answer; the test is `trash.notPurgeRequested`, the listing's own.
 */
export async function purgeWasRequested(db: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const result = await db.execute<{ requested: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM nodes n WHERE n.id = ${nodeId} AND NOT ${notPurgeRequested("n")}) AS requested`);
  return result.rows[0]?.requested === true;
}

/**
 * Which roots a caller may delete for good: `due` — the purge job's (a trashed root past its
 * date, or one whose purge was requested); `trashed` — a user's (any trashed root); `any` — the
 * account purge's (every root of the account, trashed or not).
 */
export type PurgeRule = "due" | "trashed" | "any";

/**
 * Takes the owner's tree lock and says whether the root is STILL what the caller may purge.
 *
 * The caller found the root in a list, or read it before its transaction — and its owner (or
 * the editor who trashed it) may have RESTORED it since. `trash.deleteSubtreeRows` deletes any
 * root it is given, so this is asked first, in the same transaction, under the lock `restore`
 * takes too: a restore either committed before (the answer is false, nothing is deleted) or
 * waits until the purge is over (and finds nothing to restore).
 *
 * The tree lock is the first lock `deleteSubtreeRows` takes itself; taking it here keeps the
 * lock order (it is re-entrant within the transaction) and the two reads take no row lock.
 * True for an id that does not exist: the delete then finds nothing, and says so.
 */
export async function lockTreeForPurge(tx: Executor, rootId: string, rule: PurgeRule): Promise<boolean> {
  if (!isUuid(rootId)) return true;
  const [peek] = await tx.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, rootId));
  if (!peek) return true;
  await lockOwnerTree(tx, peek.ownerId);
  if (rule === "any") return true;
  const [row] = await tx
    .select({
      trashed: sql<boolean>`(${nodes.trashedRoot} AND ${nodes.deletedAt} IS NOT NULL)`,
      due: sql<boolean>`(${nodes.trashedRoot} AND ${nodes.deletedAt} IS NOT NULL AND ${nodes.purgeAfter} <= now())`,
      requested: sql<boolean>`(${nodes.purgeRequestedAt} IS NOT NULL)`,
    })
    .from(nodes)
    .where(eq(nodes.id, rootId));
  if (!row) return true;
  return rule === "trashed" ? row.trashed : row.due || row.requested;
}

/** How many roots `trash.listTrash` would list for the owner — the same rows, counted. */
export async function countTrash(db: Executor, ownerId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.trashedRoot, true),
        isNotNull(nodes.deletedAt),
        notPurgeRequested(),
        isNull(nodes.system),
        notEffectivelyHidden(),
        sql`${nodes.scanStatus} <> 'suspected_csam'`,
      ),
    );
  return row?.n ?? 0;
}

// ── retention ───────────────────────────────────────────────────────────────────────────────

export const LINK_ACCESS_LOG_RETENTION_DAYS = 180;
export const AUDIT_LOG_RETENTION_DAYS = 180;
export const DOWNLOAD_LEDGER_RETENTION_DAYS = 90;
export const PASSWORD_ATTEMPT_IDLE_HOURS = 24;
export const EMAIL_LEDGER_RETENTION_HOURS = 48;

/** The link aliased `kept_link` is one whose records are kept: its creator or its node is held. */
const LINK_KEPT = sql`(${userHeld(sql`kept_link.created_by`)} OR ${nodeProtected(sql`kept_link.node_id`)})`;

/**
 * Public-link access rows older than the period — except those of a link a held account created
 * or that points at a protected node, and those about a protected file inside such a link.
 */
export async function deleteOldLinkAccess(
  db: Executor,
  limit: number,
  olderThanDays: number = LINK_ACCESS_LOG_RETENTION_DAYS,
): Promise<number> {
  const doomed = db
    .select({ id: linkAccessLog.id })
    .from(linkAccessLog)
    .where(
      and(
        lt(linkAccessLog.at, sql`now() - make_interval(days => ${olderThanDays})`),
        sql`NOT EXISTS (SELECT 1 FROM share_links kept_link
                        WHERE kept_link.id = ${linkAccessLog.linkId} AND ${LINK_KEPT})`,
        not(nodeProtected(sql`${linkAccessLog.nodeId}`)),
      ),
    )
    .orderBy(linkAccessLog.id)
    .limit(limit);
  const rows = await db
    .delete(linkAccessLog)
    .where(inArray(linkAccessLog.id, doomed))
    .returning({ id: linkAccessLog.id });
  return rows.length;
}

/**
 * `audit_log.target_id` is text and holds either id family — or anything else. It is read as a
 * node id only where it has the shape of one: a bare `::uuid` cast would throw on the first
 * malformed row and end the whole delete, every night. Null for every other row.
 */
const AUDIT_TARGET_NODE = sql`(CASE WHEN ${auditLog.targetType} = 'node'
  AND ${auditLog.targetId} ~* ${sql.raw(`'^${UUID_PARAM}$'`)} THEN ${auditLog.targetId}::uuid END)`;

/**
 * Audit rows older than the period — except a row marked `meta.legalHold`, a row a held account
 * made, a row about a held account, and a row about a protected node or about a node a held
 * account uploaded.
 */
export async function deleteOldAudit(
  db: Executor,
  limit: number,
  olderThanDays: number = AUDIT_LOG_RETENTION_DAYS,
): Promise<number> {
  const doomed = db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        lt(auditLog.at, sql`now() - make_interval(days => ${olderThanDays})`),
        sql`COALESCE(${auditLog.meta} ->> 'legalHold', '') <> 'true'`,
        not(userHeld(sql`${auditLog.actorUserId}`)),
        sql`NOT (COALESCE(${auditLog.targetType}, '') = 'user' AND ${userHeld(sql`${auditLog.targetId}`)})`,
        not(nodeProtected(AUDIT_TARGET_NODE)),
        sql`NOT EXISTS (SELECT 1 FROM nodes target_node
                        WHERE target_node.id = ${AUDIT_TARGET_NODE}
                          AND ${userHeld(sql`target_node.created_by`)})`,
      ),
    )
    .orderBy(auditLog.id)
    .limit(limit);
  const rows = await db.delete(auditLog).where(inArray(auditLog.id, doomed)).returning({ id: auditLog.id });
  return rows.length;
}

/** A session row is kept this long after it expired: the raw address and agent go with the row. */
export const SESSION_EXPIRED_GRACE_DAYS = 1;
/** A report's reporter address hash is kept this long after the report was resolved. */
export const REPORTER_HASH_RETENTION_DAYS = 90;

/**
 * Better Auth session rows that expired more than the grace ago — a browser that never comes
 * back is the only way a row ever reaches this (a returning token is deleted by Better Auth
 * itself), and its raw `ip_address` / `user_agent` would otherwise stay for ever. Never a live
 * session, and never a held account's: the purge keeps that session (T29 §C). The column is a
 * `timestamp` without a zone written in UTC, so it is compared with UTC now.
 */
export async function deleteExpiredSessions(
  db: Executor,
  limit: number,
  graceDays: number = SESSION_EXPIRED_GRACE_DAYS,
): Promise<number> {
  const doomed = db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        lt(session.expiresAt, sql`(now() AT TIME ZONE 'UTC') - make_interval(days => ${graceDays})`),
        not(userHeld(sql`${session.userId}`)),
      ),
    )
    .limit(limit);
  const rows = await db.delete(session).where(inArray(session.id, doomed)).returning({ id: session.id });
  return rows.length;
}

/**
 * Sets `reporter_ip_hash_stable` to NULL on reports resolved (`actioned` / `dismissed`, with a
 * `resolved_at`) more than the period ago. Nothing else on the row changes. An unresolved
 * report, and a closed one with no `resolved_at`, keeps it. Kept too: a report on a node the
 * purge gate protects, or one whose owner or reporter account is held — a preserved case is not
 * edited. Everything that reads the hash (the open-report dedupe, the per-reporter 24 h cap, the
 * admin's distinct-reporter count) looks at open reports or the last 24 hours.
 */
export async function nullStaleReporterHashes(
  db: Executor,
  limit: number,
  afterDays: number = REPORTER_HASH_RETENTION_DAYS,
): Promise<number> {
  const doomed = db
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        isNotNull(reports.reporterIpHashStable),
        inArray(reports.status, ["actioned", "dismissed"]),
        lt(reports.resolvedAt, sql`now() - make_interval(days => ${afterDays})`),
        not(nodeProtected(sql`${reports.nodeId}`)),
        not(userHeld(sql`${reports.ownerId}`)),
        not(userHeld(sql`${reports.reporterUserId}`)),
      ),
    )
    .limit(limit);
  const rows = await db
    .update(reports)
    .set({ reporterIpHashStable: null })
    .where(inArray(reports.id, doomed))
    .returning({ id: reports.id });
  return rows.length;
}

/** The ledger subjects whose `subject_id` is a user id. */
const USER_SUBJECTS = [
  "user",
  "upload_user",
  "upload_editor",
  "transform_user",
  "share_user",
  "link_user",
  "link_owner",
] as const;
const userSubjects = sql.join(
  USER_SUBJECTS.map((subject) => sql.raw(`'${subject}'`)),
  sql`, `,
);

/**
 * Daily ledger rows older than the period — except a held account's, and those of a link a held
 * account created or that points at a protected node. Rows keyed by an IP hash, a sign-up
 * counter or a once-a-day marker cannot be tied to an account: they go with their age.
 */
export async function deleteOldLedger(
  db: Executor,
  limit: number,
  olderThanDays: number = DOWNLOAD_LEDGER_RETENTION_DAYS,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM download_ledger WHERE (day, subject_type, subject_id) IN (
      SELECT dl.day, dl.subject_type, dl.subject_id FROM download_ledger dl
      WHERE dl.day < (now() AT TIME ZONE 'UTC')::date - ${olderThanDays}::int
        AND NOT (dl.subject_type IN (${userSubjects}) AND ${userHeld(sql`dl.subject_id`)})
        AND NOT (dl.subject_type = 'link' AND EXISTS (
          SELECT 1 FROM share_links kept_link WHERE kept_link.id::text = dl.subject_id AND ${LINK_KEPT}))
      ORDER BY dl.day, dl.subject_type, dl.subject_id
      LIMIT ${limit})
    RETURNING 1`);
  return result.rows.length;
}

/**
 * Password-attempt counters nobody has added to for the period and that lock nothing now —
 * except those on a link a held account created or that points at a protected node.
 */
export async function deleteIdlePasswordAttempts(
  db: Executor,
  limit: number,
  idleHours: number = PASSWORD_ATTEMPT_IDLE_HOURS,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM link_password_attempts WHERE (link_id, ip_hash_stable) IN (
      SELECT a.link_id, a.ip_hash_stable FROM link_password_attempts a
      WHERE a.last_failure_at < now() - make_interval(hours => ${idleHours})
        AND (a.locked_until IS NULL OR a.locked_until <= now())
        AND NOT EXISTS (SELECT 1 FROM share_links kept_link WHERE kept_link.id = a.link_id AND ${LINK_KEPT})
      ORDER BY a.link_id, a.ip_hash_stable
      LIMIT ${limit})
    RETURNING 1`);
  return result.rows.length;
}

/**
 * Mail-cap windows older than the period. Keyed by a hash of the recipient: they cannot be tied
 * to an account, so no hold keeps them.
 */
export async function deleteOldEmailWindows(
  db: Executor,
  limit: number,
  olderThanHours: number = EMAIL_LEDGER_RETENTION_HOURS,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM email_ledger WHERE (window_kind, window_start, recipient_hash) IN (
      SELECT e.window_kind, e.window_start, e.recipient_hash FROM email_ledger e
      WHERE e.window_start < now() - make_interval(hours => ${olderThanHours})
      ORDER BY e.window_kind, e.window_start, e.recipient_hash
      LIMIT ${limit})
    RETURNING 1`);
  return result.rows.length;
}

// ── stale uploads ───────────────────────────────────────────────────────────────────────────

/**
 * Locks one session `uploads.expired` listed and returns it — if it is STILL stale: `open` past
 * its `expiresAt`, or `completing` for longer than the grace and owing no locked node. Null when
 * it moved on meanwhile (a client claimed it, it finished, its hash was csam-listed). The list is advice; this row, under its lock, decides.
 * Call it after the owner's `user` row is locked (queries/tree.ts, lock order).
 */
export async function lockStaleUpload(tx: Executor, uploadId: string): Promise<Upload | null> {
  const [row] = await tx
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.id, uploadId),
        or(
          and(eq(uploads.status, "open"), lte(uploads.expiresAt, sql`now()`)),
          and(
            eq(uploads.status, "completing"),
            sql`COALESCE(${uploads.completingAt}, ${uploads.createdAt}) < now() - make_interval(mins => ${COMPLETING_STALE_MINUTES})`,
            // The same exclusion as the listing, asked again here: a hash put on the csam list
            // after `expired()` ran makes the session the repair sweep's — never aborted here.
            not(owesLockedNode()),
          ),
        ),
      ),
    )
    .for("update");
  return row ?? null;
}

// ── the account purge ───────────────────────────────────────────────────────────────────────

/**
 * `claimed` — the purge may run, and from here on a cancel is refused; `gone` — no pending row
 * (cancelled, or another run finished it); `dropped` — the account is gone or its deletion was
 * cancelled, and the stale pending row was removed; `held` — the account is on legal hold: left
 * exactly as it is; `early` — not due yet.
 */
export type PurgeClaim = "claimed" | "gone" | "dropped" | "held" | "early";

/**
 * Decides, under the `user` row's lock, whether this account's purge may start — and starts it.
 * The job's list (`user-purge.due`) is advice: between that read and this call the user may have
 * cancelled, and a hold may have been placed. `schedule` and `cancel` take the same lock first
 * (queries/user-purge.ts), then the pending row, as this does; once this has committed with
 * `claimed`, `cancel` refuses.
 */
export async function claimAccountPurge(tx: Executor, userId: string): Promise<PurgeClaim> {
  const exists = await lockUser(tx, userId);
  const [pending] = await tx
    .select({
      finishedAt: pendingUserPurges.finishedAt,
      due: sql<boolean>`(${pendingUserPurges.scheduledFor} <= now())`,
    })
    .from(pendingUserPurges)
    .where(eq(pendingUserPurges.userId, userId))
    .for("update");
  if (!pending || pending.finishedAt !== null) return "gone";
  const [subject] = exists
    ? await tx
        .select({ deleteScheduledAt: user.deleteScheduledAt, legalHold: user.legalHold })
        .from(user)
        .where(eq(user.id, userId))
    : [];
  if (!subject || subject.deleteScheduledAt === null) {
    await tx.delete(pendingUserPurges).where(eq(pendingUserPurges.userId, userId));
    return "dropped";
  }
  if (subject.legalHold) return "held";
  if (!pending.due) return "early";
  await markStarted(tx, userId);
  return "claimed";
}

/**
 * Locks the account's `user` row for its hard delete and says whether it may still go: `gone` —
 * another run deleted it; `held` — a hold was placed while the purge was running (the writers
 * that set one lock this row too, so the answer cannot change before the delete commits).
 * Call it first in the transaction that deletes the account.
 */
export async function lockAccountForDelete(tx: Executor, userId: string): Promise<"ok" | "gone" | "held"> {
  if (!(await lockUser(tx, userId))) return "gone";
  const [subject] = await tx.select({ legalHold: user.legalHold }).from(user).where(eq(user.id, userId));
  if (!subject) return "gone";
  return subject.legalHold ? "held" : "ok";
}

/** Is the account on legal hold now? False when there is no such account. */
export async function accountHeld(db: Executor, userId: string): Promise<boolean> {
  const [subject] = await db.select({ legalHold: user.legalHold }).from(user).where(eq(user.id, userId));
  return subject?.legalHold === true;
}

// ── reconcile ───────────────────────────────────────────────────────────────────────────────

/** Account ids in id order, after `after` (null = from the start). */
export async function userIdsAfter(db: Executor, after: string | null, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(after === null ? undefined : gt(user.id, after))
    .orderBy(user.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

const UNFINISHED = ["open", "completing"] as const;

/**
 * Which of these object keys a row still references: a node's current version, a kept old
 * version, or an upload session that is not finished (its object may be on its way).
 */
export async function referencedKeys(db: Executor, keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const list = [...keys];
  const current = await db.select({ key: nodes.r2Key }).from(nodes).where(inArray(nodes.r2Key, list));
  const old = await db
    .select({ key: nodeVersions.r2Key })
    .from(nodeVersions)
    .where(inArray(nodeVersions.r2Key, list));
  const arriving = await db
    .select({ key: uploads.r2Key })
    .from(uploads)
    .where(and(inArray(uploads.r2Key, list), inArray(uploads.status, [...UNFINISHED])));
  for (const row of [...current, ...old, ...arriving]) if (row.key !== null) found.add(row.key);
  return found;
}

/** `<nodeId>/<versionId>` for every version of these nodes that exists, current or kept. */
export async function knownVersions(db: Executor, nodeIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const ids = [...new Set(nodeIds.filter(isUuid))];
  if (ids.length === 0) return found;
  const current = await db
    .select({ nodeId: nodes.id, versionId: nodes.versionId })
    .from(nodes)
    .where(inArray(nodes.id, ids));
  const old = await db
    .select({ nodeId: nodeVersions.nodeId, versionId: nodeVersions.versionId })
    .from(nodeVersions)
    .where(inArray(nodeVersions.nodeId, ids));
  for (const row of [...current, ...old])
    if (row.versionId !== null) found.add(`${row.nodeId}/${row.versionId}`);
  return found;
}

// ── the rollback detector's number, and the run lock ────────────────────────────────────────
//
// The reconcile job's cursor (`settings.reconcileCursor`, a JSON object) holds its place AND the
// database's generation. They are written separately, so that neither write can undo the other:
// the place by a merge that leaves `generation` as it is, the generation only by a
// compare-and-set — never with a value read earlier and written back. The generation is never
// interpreted in SQL: it is read as stored text, compared as stored text, written as digits.

const CURSOR_KEY = "reconcileCursor";

/**
 * What the database holds for the rollback detector, RAW, in one statement: the generation as
 * its stored jsonb TEXT — never interpreted here (`jobs/reconcile.ts#parseGeneration` is the one
 * parser) — and the two mail times. All null when there is no cursor object; `generation` null
 * when it has none.
 */
export async function readDetectorFields(
  db: Executor,
): Promise<{ generation: string | null; rollbackMailedAt: string | null; unknownMailedAt: string | null }> {
  const result = await db.execute<{
    generation: string | null;
    rollback_mailed_at: string | null;
    unknown_mailed_at: string | null;
  }>(sql`
    SELECT (value -> 'generation')::text AS generation,
           value ->> 'rollbackMailedAt' AS rollback_mailed_at,
           value ->> 'unknownMailedAt' AS unknown_mailed_at
      FROM settings WHERE key = ${CURSOR_KEY} AND jsonb_typeof(value) = 'object'`);
  const row = result.rows[0];
  return {
    generation: row?.generation ?? null,
    rollbackMailedAt: row?.rollback_mailed_at ?? null,
    unknownMailedAt: row?.unknown_mailed_at ?? null,
  };
}

/** The cursor as an object, whatever is stored (a value of another shape is the start). */
const storedObject = sql`CASE WHEN jsonb_typeof(settings.value) = 'object' THEN settings.value ELSE '{}'::jsonb END`;

/** Saves where the next reconcile run continues. The generation in the same value is kept. */
export async function saveReconcilePlace(
  db: Executor,
  place: { user: string | null; area: number; object: string | null },
): Promise<void> {
  const fields = sql`jsonb_build_object('user', ${place.user}::text, 'area', ${place.area}::int, 'object', ${place.object}::text)`;
  await db.execute(sql`
    INSERT INTO settings (key, value, updated_by) VALUES (${CURSOR_KEY}, ${fields}, NULL)
    ON CONFLICT (key) DO UPDATE SET value = ${storedObject} || ${fields}, updated_by = NULL, updated_at = now()`);
  clearSettingsCache();
}

/** The two mail times the detector keeps in the cursor (kept by every merge). */
export type DetectorMailField = "rollbackMailedAt" | "unknownMailedAt";

/** Notes when the operators were last mailed about the state going on. */
export async function markDetectorMailed(db: Executor, field: DetectorMailField, at: Date): Promise<void> {
  const fields = sql`jsonb_build_object(${field}::text, ${at.toISOString()}::text)`;
  await db.execute(sql`
    INSERT INTO settings (key, value, updated_by) VALUES (${CURSOR_KEY}, ${fields}, NULL)
    ON CONFLICT (key) DO UPDATE SET value = ${storedObject} || ${fields}, updated_by = NULL, updated_at = now()`);
  clearSettingsCache();
}

/** That state is over: the next one mails at once. */
export async function clearDetectorMailed(db: Executor, field: DetectorMailField): Promise<void> {
  await db.execute(sql`
    UPDATE settings SET value = settings.value - ${field}::text, updated_at = now()
    WHERE key = ${CURSOR_KEY} AND jsonb_typeof(settings.value) = 'object' AND settings.value ? ${field}::text`);
  clearSettingsCache();
}

// ── the scanner-down alert's state (T27B; the detector's mail-time pattern) ──────────────────
//
// One settings row (`scannerAlert`; `getSettings` ignores the key), a JSON object:
//   since        the open episode's start (null: none open)       endedAt      when it was ended
//   mailedAt     the last scanner_down mail — NEVER reset by a recovery (one mail per 6 h, across
//                episodes)                                         lastErrorAt  the last scanner error
//   suspects     `{ owner, at }` of recent engine/timeout dead letters (bounded): one owner's file
//                can cause those, so they count only from enough DISTINCT owners
// Dead letters are handled concurrently: every change is read-decide-write under the row's lock.

export const SCANNER_ALERT_KEY = "scannerAlert";

export type ScannerAlertState = {
  since: string | null;
  endedAt: string | null;
  mailedAt: string | null;
  lastErrorAt: string | null;
  suspects: Array<{ owner: string; at: string }>;
};

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function readAlertState(value: unknown): ScannerAlertState {
  const object = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const suspects = Array.isArray(object.suspects)
    ? object.suspects.flatMap((entry) => {
        const item = entry as { owner?: unknown; at?: unknown } | null;
        const owner = text(item?.owner);
        const at = text(item?.at);
        return owner && at ? [{ owner, at }] : [];
      })
    : [];
  return {
    since: text(object.since),
    endedAt: text(object.endedAt),
    mailedAt: text(object.mailedAt),
    lastErrorAt: text(object.lastErrorAt),
    suspects,
  };
}

/**
 * Reads, changes and writes the alert row in one transaction, the row locked (created empty
 * first if absent): concurrent dead letters see each other's changes.
 */
export async function changeScannerAlert<T>(
  db: Executor,
  key: string,
  change: (state: ScannerAlertState) => { next: ScannerAlertState; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO settings (key, value, updated_by) VALUES (${key}, '{}'::jsonb, NULL) ON CONFLICT (key) DO NOTHING`);
    const found = await tx.execute<{ value: unknown }>(
      sql`SELECT value FROM settings WHERE key = ${key} FOR UPDATE`,
    );
    const { next, result } = change(readAlertState(found.rows[0]?.value));
    await tx.execute(sql`
      UPDATE settings SET value = ${JSON.stringify(next)}::jsonb, updated_by = NULL, updated_at = now() WHERE key = ${key}`);
    return result;
  });
}

/** A scanner error while an episode is open: its time, for the recovery's quiet period. One statement. */
export async function noteScannerError(db: Executor, key: string, at: Date): Promise<void> {
  await db.execute(sql`
    UPDATE settings SET value = jsonb_set(value, '{lastErrorAt}', to_jsonb(${at.toISOString()}::text)), updated_at = now()
    WHERE key = ${key} AND jsonb_typeof(value) = 'object'
      AND value ->> 'since' IS NOT NULL AND value ->> 'endedAt' IS NULL`);
}

/**
 * A real verdict: the open episode ends — only when its last scanner error is at least `quietMs`
 * old (hysteresis). `mailedAt` is KEPT. One statement; nothing when no episode is open. Returns
 * the episode's start when it ended one.
 */
export async function endScannerEpisode(
  db: Executor,
  key: string,
  at: Date,
  quietMs: number,
): Promise<{ since: string } | null> {
  const quietSince = new Date(at.getTime() - quietMs).toISOString();
  const result = await db.execute<{ since: string }>(sql`
    UPDATE settings SET value = jsonb_set(value, '{endedAt}', to_jsonb(${at.toISOString()}::text)), updated_at = now()
    WHERE key = ${key} AND jsonb_typeof(value) = 'object'
      AND value ->> 'since' IS NOT NULL AND value ->> 'endedAt' IS NULL
      AND COALESCE(value ->> 'lastErrorAt', value ->> 'since') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      AND COALESCE(value ->> 'lastErrorAt', value ->> 'since')::timestamptz <= ${quietSince}::timestamptz
    RETURNING value ->> 'since' AS since`);
  return result.rows[0] ?? null;
}

/** A claimed mail that reached nobody is given back (only if nothing claimed after it). */
export async function releaseScannerDownMail(
  db: Executor,
  key: string,
  claimedAt: Date,
  previous: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE settings SET value = jsonb_set(value, '{mailedAt}', COALESCE(to_jsonb(${previous}::text), 'null'::jsonb)), updated_at = now()
    WHERE key = ${key} AND jsonb_typeof(value) = 'object' AND value ->> 'mailedAt' = ${claimedAt.toISOString()}`);
}

/**
 * Counts the database's generation up — only if it is still EXACTLY what was read (`from`: the
 * stored jsonb text as `readDetectorFields` gave it, null for none): a compare of the raw stored
 * form, no number interpreted in SQL. Writes `next`, canonical digits. True when this call moved
 * it; a reading made before someone else moved it — a run, an operator, a restore — moves nothing.
 */
export async function advanceGenerationRow(
  db: Executor,
  from: string | null,
  next: string,
): Promise<boolean> {
  if (!/^(0|[1-9][0-9]*)$/.test(next)) throw new Error("generation: not canonical digits");
  const value = sql`${next}::jsonb`;
  const result =
    from === null
      ? // No generation stored (it reads as 0): the count may create the row or the field.
        await db.execute(sql`
          INSERT INTO settings (key, value, updated_by)
          VALUES (${CURSOR_KEY}, jsonb_build_object('generation', ${value}), NULL)
          ON CONFLICT (key) DO UPDATE
            SET value = ${storedObject} || jsonb_build_object('generation', ${value}), updated_by = NULL, updated_at = now()
            WHERE NOT (jsonb_typeof(settings.value) = 'object' AND settings.value ? 'generation')
          RETURNING key`)
      : await db.execute(sql`
          UPDATE settings
            SET value = jsonb_set(settings.value, '{generation}', ${value}), updated_by = NULL, updated_at = now()
            WHERE key = ${CURSOR_KEY} AND jsonb_typeof(settings.value) = 'object'
              AND (settings.value -> 'generation')::text = ${from}
          RETURNING key`);
  clearSettingsCache();
  return result.rows.length === 1;
}

/**
 * Runs `run` while this invocation holds the job lock `name` — or not at all, when another run
 * holds it (`{ held: false }`, at once: nothing waits).
 *
 * The lock is a transaction-scoped advisory lock (behind Hyperdrive's transaction pooling a
 * session lock is not possible — db/client.ts rule 3), so its transaction stays open, idle,
 * while `run` works: `holdMs` raises that one transaction's idle limit to cover the run, and
 * the lock ends with it — committed when `run` returns, rolled back when it throws, and dropped
 * by the server if this invocation dies. `run` NEVER uses the lock's transaction: it works on the
 * handle's other pooled connections (the one deliberate exception to rule 1; the pool has five,
 * and a run uses one or two at a time).
 */
export async function withJobLock<T>(
  db: Executor,
  name: string,
  holdMs: number,
  run: () => Promise<T>,
): Promise<{ held: true; value: T } | { held: false }> {
  let out: { held: true; value: T } | { held: false } = { held: false };
  await db.transaction(async (tx) => {
    const result = await tx.execute<{ got: boolean }>(sql`
      SELECT set_config('idle_in_transaction_session_timeout', ${String(Math.trunc(holdMs))}, true),
             pg_try_advisory_xact_lock(hashtextextended(${"job:" + name}, 0)) AS got`);
    if (result.rows[0]?.got !== true) return;
    out = { held: true, value: await run() };
  });
  return out;
}
