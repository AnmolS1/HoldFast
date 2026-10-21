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
import { notHiddenRow } from "./tree";

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

/**
 * The bytes `used_bytes` still counts for roots whose permanent deletion was asked for and that a
 * hold kept: the files of those subtrees and their kept old versions — exactly what the purge
 * would have given back (trash.ts `DeletedRows.freedBytes`; an unheld root is purged at once by
 * the request, so for it this is 0). The export answers `usedBytes` without them: to its owner
 * such a root is deleted, and a figure that still counted it would tell a held account apart.
 */
export async function purgeRequestedBytes(db: Executor, userId: string): Promise<number> {
  const result = await db.execute<{ bytes: string }>(sql`
    WITH RECURSIVE asked(id) AS (
      SELECT n.id FROM nodes n
      WHERE n.owner_id = ${userId} AND n.purge_requested_at IS NOT NULL
      UNION
      SELECT c.id FROM nodes c JOIN asked ON c.parent_id = asked.id
    )
    SELECT (
      (SELECT COALESCE(SUM(n.size), 0) FROM nodes n JOIN asked a ON a.id = n.id
       WHERE n.kind = 'file' AND n.system IS NULL)
      + (SELECT COALESCE(SUM(v.size), 0) FROM node_versions v JOIN asked a ON a.id = v.node_id)
    )::bigint AS bytes`);
  return Number(result.rows[0]?.bytes ?? 0);
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

/** Every node of the export, in id order, read a page at a time. */
export async function exportNodes(db: Executor, userId: string): Promise<ExportNodeRow[]> {
  const all: ExportNodeRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page: ExportNodeRow[] = await db
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
      .limit(EXPORT_PAGE);
    all.push(...page);
    if (page.length < EXPORT_PAGE) return all;
    after = page[page.length - 1]!.id;
  }
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
