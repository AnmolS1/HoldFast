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
import { isUuid } from "../ids";
import {
  auditLog,
  linkAccessLog,
  nodes,
  nodeVersions,
  pendingUserPurges,
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
// One settings row, `scannerAlert` = `{ since, mailedAt }` (ISO times; `getSettings` ignores the
// key). Present while the scanner is believed down; gone once a real verdict came back. Unlike
// the detector — which runs under the generation lock — dead letters are handled concurrently,
// so the mail is CLAIMED in one statement and only the caller that gets the row back sends it.

export const SCANNER_ALERT_KEY = "scannerAlert";

/**
 * Claims the scanner-down mail: true when no mail is recorded, or the last one is at least
 * `everyMs` old — then `mailedAt` is `at` (and `since` kept, or `at` for a new episode). The
 * previous `mailedAt` comes back for `releaseScannerDownMail`.
 */
export async function claimScannerDownMail(
  db: Executor,
  at: Date,
  everyMs: number,
): Promise<{ claimed: false } | { claimed: true; previous: string | null }> {
  const now = at.toISOString();
  const due = new Date(at.getTime() - everyMs).toISOString();
  const result = await db.execute<{ previous: string | null }>(sql`
    WITH before AS (SELECT value ->> 'mailedAt' AS mailed FROM settings WHERE key = ${SCANNER_ALERT_KEY})
    INSERT INTO settings (key, value, updated_by)
    VALUES (${SCANNER_ALERT_KEY}, jsonb_build_object('since', ${now}::text, 'mailedAt', ${now}::text), NULL)
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_build_object(
            'since', COALESCE(${storedObject} ->> 'since', ${now}::text), 'mailedAt', ${now}::text),
          updated_by = NULL, updated_at = now()
      WHERE (${storedObject} ->> 'mailedAt') IS NULL
         OR (${storedObject} ->> 'mailedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
         OR (${storedObject} ->> 'mailedAt')::timestamptz <= ${due}::timestamptz
    RETURNING (SELECT mailed FROM before) AS previous`);
  const row = result.rows[0];
  return row ? { claimed: true, previous: row.previous ?? null } : { claimed: false };
}

/** A claim whose mail reached nobody is given back: the next dead letter tries again. */
export async function releaseScannerDownMail(
  db: Executor,
  claimedAt: Date,
  previous: string | null,
): Promise<void> {
  if (previous === null) {
    await db.execute(sql`
      DELETE FROM settings WHERE key = ${SCANNER_ALERT_KEY} AND value ->> 'mailedAt' = ${claimedAt.toISOString()}`);
    return;
  }
  await db.execute(sql`
    UPDATE settings SET value = jsonb_set(value, '{mailedAt}', to_jsonb(${previous}::text)), updated_at = now()
    WHERE key = ${SCANNER_ALERT_KEY} AND value ->> 'mailedAt' = ${claimedAt.toISOString()}`);
}

/**
 * The scanner answered: the alert's state is over. One statement, nothing when no alert is
 * recorded. Returns when the episode began (null: there was none).
 */
export async function clearScannerDown(db: Executor): Promise<{ since: string | null } | null> {
  const result = await db.execute<{ since: string | null }>(sql`
    DELETE FROM settings WHERE key = ${SCANNER_ALERT_KEY} RETURNING value ->> 'since' AS since`);
  const row = result.rows[0];
  return row ? { since: row.since ?? null } : null;
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
