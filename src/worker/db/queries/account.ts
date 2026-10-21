// The account's own reads and writes (routes/account.ts is the only caller): the profile on
// `user`, the preferences in `user_prefs`, the caller's sessions, their sign-in activity, and what
// the data export reads.
//
// Nothing here reads or writes a hold. The export's node set is the owner's own nodes WITHOUT
// three kinds, each of which would tell a held account from an unheld one or show what the owner
// may no longer see:
//   - system nodes (the avatar);
//   - hidden nodes — `suspected_csam`, and a takedown of the node or of ANY folder above it
//     (`tree.notHiddenRow`);
//   - a root whose permanent deletion was asked for, and everything under it
//     (`trash.notPurgeRequested`): an unheld root's rows are gone once the purge job has run, a
//     held root keeps them — to its owner both are "deleted for good".
// The shares and links of the export are the ones on that same node set.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import {
  auditLog,
  type Node,
  nodes,
  session,
  type Share,
  shareLinks,
  type ShareLink,
  shares,
  user,
  userPrefs,
  type UserPrefs,
} from "../schema";
import { notPurgeRequested } from "./trash";
import { notEffectivelyTrashedOrHidden, notHiddenRow } from "./tree";
import { ownerIsActive } from "./users";

export type SessionRow = typeof session.$inferSelect;

// ── profile ─────────────────────────────────────────────────────────────────────────────────

/** A node id no row has: what a read is made with when there is no id to read. */
const NO_NODE_ID = "00000000-0000-0000-0000-000000000000";

export type ProfileRow = {
  name: string;
  email: string;
  timezone: string | null;
  locale: string;
  /** The current avatar, only while it is a clean, visible avatar node of this user. */
  avatar: { nodeId: string; versionId: string | null } | null;
};

/** Null when there is no such user. */
export async function getProfile(db: Executor, userId: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select({
      name: user.name,
      email: user.email,
      timezone: user.timezone,
      locale: user.locale,
      avatarNodeId: user.avatarNodeId,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) return null;
  const avatar = row.avatarNodeId ? await currentAvatar(db, userId, row.avatarNodeId) : null;
  return {
    name: row.name,
    email: row.email,
    timezone: row.timezone,
    locale: row.locale,
    avatar: avatar ? { nodeId: avatar.id, versionId: avatar.versionId } : null,
  };
}

/**
 * The user's avatar node, when `nodeId` is one that may be shown: an avatar (`system = 'avatar'`)
 * of THIS user, clean, not taken down and not locked. Null otherwise.
 */
export async function currentAvatar(
  db: Executor,
  userId: string,
  nodeId: string | null,
): Promise<Node | null> {
  // One primary-key read in every case — an id that is not a node id included.
  const id = isUuid(nodeId) ? nodeId : NO_NODE_ID;
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, id),
        eq(nodes.ownerId, userId),
        eq(nodes.system, "avatar"),
        eq(nodes.scanStatus, "clean"),
        isNull(nodes.deletedAt),
        notHiddenRow(),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * True when the two accounts have an ACTIVE share relationship, in either direction: an activated
 * share from one to the other on a node that is still there for its grantee — not a system node,
 * not in the trash or taken down (itself or by a folder above), not locked, not deleted for good —
 * of an owner whose shares still work (not banned, suspended or in the deletion window). A legal
 * hold changes nothing here: it must not be observable. (Avatar visibility; T05's
 * `hasShareBetween` counts any activated row — T23 review m3.)
 */
export async function activeShareBetween(db: Executor, userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return true;
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM shares s JOIN nodes ON nodes.id = s.node_id
      WHERE s.activated_at IS NOT NULL
        AND ((nodes.owner_id = ${userA} AND s.grantee_user_id = ${userB})
          OR (nodes.owner_id = ${userB} AND s.grantee_user_id = ${userA}))
        AND nodes.system IS NULL
        AND ${notEffectivelyTrashedOrHidden("nodes")}
        AND nodes.scan_status <> 'suspected_csam'
        AND ${notPurgeRequested("nodes")}
        AND ${ownerIsActive(sql`nodes.owner_id`)}
    ) AS found`);
  return result.rows[0]?.found === true;
}

/** The id of the user's current avatar node, or null (no avatar, or no such user). */
export async function avatarNodeIdOf(db: Executor, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ avatarNodeId: user.avatarNodeId })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.avatarNodeId ?? null;
}

export type ProfilePatch = { name?: string; timezone?: string; locale?: string };

/** False when there is no such user. */
export async function updateProfile(db: Executor, userId: string, patch: ProfilePatch): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning({ id: user.id });
  return rows.length > 0;
}

// ── preferences ─────────────────────────────────────────────────────────────────────────────

export type PrefsPatch = Partial<
  Pick<UserPrefs, "density" | "theme" | "viewMode" | "emailShares" | "emailLinkDigest">
>;

/** The user's preferences; the defaults of the table when the row is missing. */
export async function getPrefs(db: Executor, userId: string): Promise<UserPrefs> {
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
  if (row) return row;
  // Every account gets its row at sign-up (auth-lifecycle `ensureUserPrefs`); one made before
  // that existed reads as the defaults, and the first write creates it.
  const [made] = await db.insert(userPrefs).values({ userId }).onConflictDoNothing().returning();
  if (made) return made;
  const [again] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
  return again!;
}

/** Writes the given fields (the row is created when missing). `emailSecurity` is never written. */
export async function updatePrefs(db: Executor, userId: string, patch: PrefsPatch): Promise<UserPrefs> {
  const values = { ...patch, updatedAt: new Date() };
  const [row] = await db
    .insert(userPrefs)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userPrefs.userId, set: values })
    .returning();
  return row!;
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────

/**
 * The caller's own sessions — the ones they made: an operator's impersonation session of the
 * account is not one of them. Unexpired ones only, most recently active first. (`expires_at` is
 * a zone-less column read as UTC by Drizzle: compared here, not in SQL.)
 */
export async function ownSessions(db: Executor, userId: string, at: Date): Promise<SessionRow[]> {
  const rows = await db
    .select()
    .from(session)
    .where(and(eq(session.userId, userId), isNull(session.impersonatedBy)))
    .orderBy(desc(session.updatedAt), session.id);
  return rows.filter((row) => row.expiresAt.getTime() > at.getTime());
}

/** Deletes one of the caller's own sessions. False when no such session is theirs. */
export async function deleteOwnSession(db: Executor, userId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .delete(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), isNull(session.impersonatedBy)))
    .returning({ id: session.id });
  return rows.length > 0;
}

/** Deletes every session of the caller's own but `keepId`; returns how many went. */
export async function deleteOtherSessions(db: Executor, userId: string, keepId: string): Promise<number> {
  const rows = await db
    .delete(session)
    .where(and(eq(session.userId, userId), isNull(session.impersonatedBy), sql`${session.id} <> ${keepId}`))
    .returning({ id: session.id });
  return rows.length;
}

// ── sign-in activity ────────────────────────────────────────────────────────────────────────

/**
 * The audit actions the account holder is shown about their own account — an ALLOW-list
 * (auth/audit.ts holds the vocabulary). Never a node action: a held "delete forever" writes no
 * `node.purge` and an unheld one does. Never an operator's action on the account.
 */
export const ACTIVITY_ACTIONS: readonly string[] = [
  "auth.sign_in",
  "auth.failed",
  "auth.sign_out",
  "auth.password_changed",
  "auth.2fa_enabled",
  "auth.2fa_disabled",
  "auth.totp_secret_viewed",
  "auth.backup_codes_regenerated",
  "auth.second_factor_refused",
  "auth.passkey_added",
  "auth.passkey_removed",
  "auth.email_changed",
];

/** The actions shown as a failure. */
export const FAILED_ACTIVITY_ACTIONS: ReadonlySet<string> = new Set([
  "auth.failed",
  "auth.second_factor_refused",
]);

export const ACTIVITY_LIMIT = 20;

export type ActivityRow = {
  id: string;
  at: Date;
  action: string;
  ua: string | null;
  country: string | null;
  meta: Record<string, unknown> | null;
};

/**
 * The newest rows ABOUT the account (`target` = the user) — a failed sign-in by somebody else
 * is written with no actor and the account as its target, and belongs here.
 */
export async function recentActivity(
  db: Executor,
  userId: string,
  limit: number = ACTIVITY_LIMIT,
): Promise<ActivityRow[]> {
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      ua: auditLog.ua,
      country: auditLog.country,
      meta: auditLog.meta,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "user"),
        eq(auditLog.targetId, userId),
        inArray(auditLog.action, [...ACTIVITY_ACTIONS]),
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);
}

// ── the data export ─────────────────────────────────────────────────────────────────────────

export type ExportUserRow = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  timezone: string | null;
  locale: string;
  quotaBytes: number;
  usedBytes: number;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
};

export async function exportUser(db: Executor, userId: string): Promise<ExportUserRow | null> {
  const [row] = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      timezone: user.timezone,
      locale: user.locale,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
      termsAcceptedAt: user.termsAcceptedAt,
      termsVersion: user.termsVersion,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

/** The export's node set, as a predicate over `nodes` (see the header). */
function exportable(userId: string) {
  return and(eq(nodes.ownerId, userId), isNull(nodes.system), notHiddenRow(), notPurgeRequested());
}

export type ExportNodeRow = Pick<
  Node,
  | "id"
  | "parentId"
  | "kind"
  | "name"
  | "size"
  | "mimeSniffed"
  | "sha256"
  | "scanStatus"
  | "starred"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

/** Read in pages of this many rows (keyset on the id). */
export const EXPORT_PAGE = 2_000;

/**
 * One page of the export's nodes, in id order, after `after` (null: the first page). The export
 * reads them one page at a time as its body is read (T23 review M3): never the whole tree.
 */
export async function exportNodePage(
  db: Executor,
  userId: string,
  after: string | null,
  limit: number = EXPORT_PAGE,
): Promise<ExportNodeRow[]> {
  return db
    .select({
      id: nodes.id,
      parentId: nodes.parentId,
      kind: nodes.kind,
      name: nodes.name,
      size: nodes.size,
      mimeSniffed: nodes.mimeSniffed,
      sha256: nodes.sha256,
      scanStatus: nodes.scanStatus,
      starred: nodes.starred,
      createdAt: nodes.createdAt,
      updatedAt: nodes.updatedAt,
      deletedAt: nodes.deletedAt,
    })
    .from(nodes)
    .where(and(exportable(userId), after === null ? undefined : sql`${nodes.id} > ${after}::uuid`))
    .orderBy(nodes.id)
    .limit(limit);
}

// ── the export limiter ──────────────────────────────────────────────────────────────────────
// An export reads the whole account, so an account runs ONE at a time and at most
// EXPORT_DAILY_LIMIT a day (T23 review M3). Both budgets are rows of `rate_limit` (Better Auth's
// table, the second-factor budget's too): `last_request` is when a window began, by the
// database's clock. The running slot is given back when the stream ends; one a crashed stream
// never gave back frees itself after EXPORT_RUNNING_MAX_S.

/** Exports per account in a day. */
export const EXPORT_DAILY_LIMIT = 10;
const EXPORT_DAY_S = 86_400;
/** How long an export may run: it ends itself then (routes/account.ts). */
export const EXPORT_MAX_RUNTIME_S = 25 * 60;
/**
 * How long a running slot is held at most (a stream that never ended frees it then) — longer than
 * an export may run, so a slot is never taken over from an export still running.
 */
export const EXPORT_RUNNING_MAX_S = 30 * 60;

export const exportSlotKeys = (userId: string) => ({
  running: `account-export-running:${userId}`,
  day: `account-export-day:${userId}`,
});

/** Counts one use of `key` in its window unless `cap` is reached; refused: seconds until it ends. */
async function admitWindow(
  db: Executor,
  key: string,
  cap: number,
  windowSeconds: number,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const windowMs = windowSeconds * 1000;
  const result = await db.execute<{ admitted: number | null; wait_ms: string | number | null }>(sql`
    WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms),
    held AS (
      SELECT r.last_request + ${windowMs} - clock.ms AS wait_ms FROM rate_limit r, clock WHERE r.key = ${key}
    ),
    admitted AS (
      INSERT INTO rate_limit AS r (id, key, count, last_request)
      SELECT gen_random_uuid()::text, ${key}, 1, clock.ms FROM clock
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN r.last_request <= (SELECT ms FROM clock) - ${windowMs} THEN 1 ELSE r.count + 1 END,
        last_request =
          CASE WHEN r.last_request <= (SELECT ms FROM clock) - ${windowMs} THEN (SELECT ms FROM clock)
               ELSE r.last_request END
      WHERE r.last_request <= (SELECT ms FROM clock) - ${windowMs} OR r.count < ${cap}
      RETURNING r.count
    )
    SELECT (SELECT count FROM admitted) AS admitted, (SELECT wait_ms FROM held) AS wait_ms`);
  const row = result.rows[0];
  if (row && row.admitted !== null) return { ok: true };
  const waitMs = row?.wait_ms != null ? Number(row.wait_ms) : windowMs;
  return { ok: false, retryAfterSeconds: Math.min(windowSeconds, Math.max(1, Math.ceil(waitMs / 1000))) };
}

/**
 * The account's running slot, held under `token`: taken when free or when the holder's time ran
 * out (EXPORT_RUNNING_MAX_S) — a slot taken over that way carries the new token, so the old
 * holder's late release frees nothing (Addendum 4).
 */
async function takeRunningSlot(
  db: Executor,
  key: string,
  token: string,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const windowMs = EXPORT_RUNNING_MAX_S * 1000;
  const result = await db.execute<{ taken: string | null; wait_ms: string | number | null }>(sql`
    WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms),
    held AS (
      SELECT r.last_request + ${windowMs} - clock.ms AS wait_ms FROM rate_limit r, clock WHERE r.key = ${key}
    ),
    taken AS (
      INSERT INTO rate_limit AS r (id, key, count, last_request)
      SELECT ${token}, ${key}, 1, clock.ms FROM clock
      ON CONFLICT (key) DO UPDATE SET id = ${token}, count = 1, last_request = (SELECT ms FROM clock)
      WHERE r.last_request <= (SELECT ms FROM clock) - ${windowMs}
      RETURNING r.id
    )
    SELECT (SELECT id FROM taken) AS taken, (SELECT wait_ms FROM held) AS wait_ms`);
  const row = result.rows[0];
  if (row?.taken === token) return { ok: true };
  const waitMs = row?.wait_ms != null ? Number(row.wait_ms) : windowMs;
  return {
    ok: false,
    retryAfterSeconds: Math.min(EXPORT_RUNNING_MAX_S, Math.max(1, Math.ceil(waitMs / 1000))),
  };
}

/**
 * Takes the account's running slot, then counts the export on its day. Admitted: the token of
 * THIS admission, which `releaseExport` needs. Refused (the other export is still running, or the
 * day's budget is spent): seconds to wait, and nothing is held.
 */
export async function admitExport(
  db: Executor,
  userId: string,
): Promise<{ ok: true; token: string } | { ok: false; retryAfterSeconds: number }> {
  const keys = exportSlotKeys(userId);
  const token = crypto.randomUUID();
  const running = await takeRunningSlot(db, keys.running, token);
  if (!running.ok) return running;
  const day = await admitWindow(db, keys.day, EXPORT_DAILY_LIMIT, EXPORT_DAY_S);
  if (!day.ok) {
    await releaseExport(db, userId, token);
    return day;
  }
  return { ok: true, token };
}

/** Gives the day's count back for an export that failed on our side (nothing was handed over). */
export async function refundExportDay(db: Executor, userId: string): Promise<void> {
  await db.execute(
    sql`UPDATE rate_limit SET count = greatest(count - 1, 0) WHERE key = ${exportSlotKeys(userId).day}`,
  );
}

/** Gives back the running slot THIS admission took (`token`) — never one another export holds now. */
export async function releaseExport(db: Executor, userId: string, token: string): Promise<void> {
  await db.execute(
    sql`DELETE FROM rate_limit WHERE key = ${exportSlotKeys(userId).running} AND id = ${token}`,
  );
}

/** The shares the user gave, pending ones included, on nodes of the export's set. */
export async function exportSharesGiven(
  db: Executor,
  userId: string,
): Promise<Array<Pick<Share, "nodeId" | "granteeEmail" | "role" | "canUpload" | "createdAt">>> {
  return db
    .select({
      nodeId: shares.nodeId,
      granteeEmail: shares.granteeEmail,
      role: shares.role,
      canUpload: shares.canUpload,
      createdAt: shares.createdAt,
    })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(exportable(userId))
    .orderBy(shares.createdAt, shares.id);
}

/** The user's links on nodes of the export's set. Never a token (hash or sealed), never a password hash. */
export async function exportLinks(
  db: Executor,
  userId: string,
): Promise<
  Array<
    Pick<
      ShareLink,
      | "id"
      | "nodeId"
      | "expiresAt"
      | "maxDownloads"
      | "downloadCount"
      | "createdAt"
      | "revokedAt"
      | "pauseReasons"
      | "lockedByAdmin"
    > & { hasPassword: boolean }
  >
> {
  return db
    .select({
      id: shareLinks.id,
      nodeId: shareLinks.nodeId,
      expiresAt: shareLinks.expiresAt,
      maxDownloads: shareLinks.maxDownloads,
      downloadCount: shareLinks.downloadCount,
      createdAt: shareLinks.createdAt,
      revokedAt: shareLinks.revokedAt,
      pauseReasons: shareLinks.pauseReasons,
      lockedByAdmin: shareLinks.lockedByAdmin,
      hasPassword: sql<boolean>`(${shareLinks.passwordHash} IS NOT NULL)`,
    })
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(and(eq(shareLinks.createdBy, userId), exportable(userId)))
    .orderBy(shareLinks.createdAt, shareLinks.id);
}
