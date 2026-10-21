// The admin console's own queries (T25): the listings, searches, counts and the few writes only
// this console makes. PLAN §6 query-module rule: nothing here is called by another task, and no
// state that has an owner elsewhere is written here — suspension, bans, deletion (account-state),
// review and takedown (moderation), links' pause set (links), strikes (strikes), blocklist
// (blocklist) all go through their owners. What IS written here:
//   - `user.quota_bytes` (the console's own quota route; the plugin's update-user is not allowed);
//   - `share_links.locked_by_admin` (its one writer);
//   - `reports.status / assigned_to / resolution / ncmec_*` for the console's report actions
//     (Dismiss, Action, assign, the NCMEC steps) — always after the report's NODE row is locked;
//   - `dmca_notices` / `dmca_notice_nodes` (the notice workflow) — each transaction that writes
//     them takes the tree lock of every owner the notice names first (PLAN §6 rule 15);
//   - `invites` (create, revoke).
//
// Cursors are opaque: base64url of the sort key of the last row returned.

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { STRIKE_WINDOW_DAYS } from "../../../shared/constants";
import { BA_ID } from "../../../shared/ids";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import {
  auditLog,
  dmcaNoticeNodes,
  dmcaNotices,
  hashBlocklist,
  invites,
  nodes,
  nodeVersions,
  reports,
  session,
  shareLinks,
  strikes,
  uploads,
  user,
  type DmcaNotice,
  type Invite,
  type Node,
  type Report,
  type ShareLink,
  type Strike,
  type Upload,
} from "../schema";
import { inheritedCauses, ownCauses } from "./holds";
import { OPEN_NOTICE_STATUSES } from "./moderation";
import { lockOwnerTree } from "./tree";

// ── cursors ─────────────────────────────────────────────────────────────────────────────────

type Key = { at: string; id: string };

function encodeCursor(key: Key): string {
  return btoa(JSON.stringify(key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The sort key a cursor names; null for anything that is not one of ours (the list starts over). */
function decodeCursor(cursor: string | undefined): Key | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as Partial<Key>;
    if (typeof value.at !== "string" || typeof value.id !== "string") return null;
    if (Number.isNaN(Date.parse(value.at))) return null;
    return { at: value.at, id: value.id };
  } catch {
    return null;
  }
}

/** `(at, id) < cursor` for a list ordered newest first. */
function before(at: SQL, id: SQL, key: Key | null): SQL | undefined {
  if (!key) return undefined;
  return sql`(${at}, ${id}::text) < (${key.at}::timestamptz, ${key.id})`;
}

function page<T>(rows: T[], limit: number, keyOf: (row: T) => Key) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(keyOf(last)) : null };
}

const iso = (value: Date) => value.toISOString();

// ── users ───────────────────────────────────────────────────────────────────────────────────

/** A user row as the console lists it: `used_bytes` is the TRUE counter (not the holder's figure). */
export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  role: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean | null;
  createdAt: Date;
  quotaBytes: number;
  usedBytes: number;
  banned: boolean | null;
  banReason: string | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  deleteScheduledAt: Date | null;
  legalHold: boolean;
  activeStrikes: number;
  lastActiveAt: Date | null;
};

const activeStrikesOf = sql<number>`(SELECT count(*)::int FROM strikes s
  WHERE s.user_id = "user".id AND s.lifted_at IS NULL
    AND s.at > now() - make_interval(days => ${STRIKE_WINDOW_DAYS}))`;
const lastActiveOf = sql<Date | null>`(SELECT max(se.updated_at) FROM session se WHERE se.user_id = "user".id)`;

const userColumns = {
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  emailVerified: user.emailVerified,
  twoFactorEnabled: user.twoFactorEnabled,
  createdAt: user.createdAt,
  quotaBytes: user.quotaBytes,
  usedBytes: user.usedBytes,
  banned: user.banned,
  banReason: user.banReason,
  suspendedAt: user.suspendedAt,
  suspendedReason: user.suspendedReason,
  deleteScheduledAt: user.deleteScheduledAt,
  legalHold: user.legalHold,
  activeStrikes: activeStrikesOf,
  lastActiveAt: lastActiveOf,
};

function normalizeUser(row: AdminUserRow): AdminUserRow {
  return {
    ...row,
    activeStrikes: Number(row.activeStrikes),
    // The aggregate comes back as text from a raw subquery.
    lastActiveAt: row.lastActiveAt === null ? null : new Date(row.lastActiveAt),
  };
}

export type UserListFilter = {
  q?: string;
  state?: "active" | "suspended" | "banned" | "deletion" | "held";
  cursor?: string;
  limit: number;
};

/**
 * Search by email, name or id — an id routes on its shape: a Better Auth id is the user; a uuid
 * is a NODE id, and finds that node's owner. Anything else matches the email or the name.
 */
export async function listUsers(db: Executor, filter: UserListFilter) {
  const q = filter.q?.trim();
  let match: SQL | undefined;
  if (q && BA_ID.test(q)) match = eq(user.id, q);
  else if (q && isUuid(q.toLowerCase())) {
    match = sql`${user.id} = (SELECT n.owner_id FROM nodes n WHERE n.id = ${q.toLowerCase()})`;
  } else if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    match = or(sql`${user.email} ILIKE ${like}`, sql`${user.name} ILIKE ${like}`);
  }
  const state: Record<NonNullable<UserListFilter["state"]>, SQL> = {
    active: sql`${user.suspendedAt} IS NULL AND NOT COALESCE(${user.banned}, false) AND ${user.deleteScheduledAt} IS NULL`,
    suspended: sql`${user.suspendedAt} IS NOT NULL`,
    banned: sql`COALESCE(${user.banned}, false)`,
    deletion: sql`${user.deleteScheduledAt} IS NOT NULL`,
    held: sql`${user.legalHold}`,
  };
  const key = decodeCursor(filter.cursor);
  const rows = (await db
    .select(userColumns)
    .from(user)
    .where(
      and(
        match,
        filter.state ? state[filter.state] : undefined,
        before(sql`${user.createdAt}::timestamptz`, sql`${user.id}`, key),
      ),
    )
    .orderBy(desc(user.createdAt), desc(user.id))
    .limit(filter.limit + 1)) as AdminUserRow[];
  return page(rows.map(normalizeUser), filter.limit, (row) => ({ at: iso(row.createdAt), id: row.id }));
}

export async function adminUser(db: Executor, userId: string): Promise<AdminUserRow | null> {
  if (!BA_ID.test(userId)) return null;
  const [row] = (await db.select(userColumns).from(user).where(eq(user.id, userId))) as AdminUserRow[];
  return row ? normalizeUser(row) : null;
}

/** The counts the user detail shows beside the account: sessions, links, shares it granted. */
export async function userCounts(db: Executor, userId: string) {
  const result = await db.execute<{ sessions: number; live: number; paused: number; shares: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM session s WHERE s.user_id = ${userId}) AS sessions,
      (SELECT count(*)::int FROM share_links l
         WHERE l.created_by = ${userId} AND l.revoked_at IS NULL AND cardinality(l.pause_reasons) = 0) AS live,
      (SELECT count(*)::int FROM share_links l
         WHERE l.created_by = ${userId} AND l.revoked_at IS NULL AND cardinality(l.pause_reasons) > 0) AS paused,
      (SELECT count(*)::int FROM shares sh WHERE sh.granted_by = ${userId}) AS shares`);
  const row = result.rows[0]!;
  return {
    sessions: Number(row.sessions),
    links: { live: Number(row.live), paused: Number(row.paused) },
    shares: Number(row.shares),
  };
}

/** Every strike of the user, newest first. */
export async function strikesOf(db: Executor, userId: string): Promise<Strike[]> {
  if (!BA_ID.test(userId)) return [];
  return db
    .select()
    .from(strikes)
    .where(eq(strikes.userId, userId))
    .orderBy(desc(strikes.at), desc(strikes.id));
}

export async function strikeById(db: Executor, strikeId: string): Promise<Strike | null> {
  if (!isUuid(strikeId)) return null;
  const [row] = await db.select().from(strikes).where(eq(strikes.id, strikeId));
  return row ?? null;
}

/** The uploader's unlifted malware strike for this node, if any (offered after a false positive). */
export async function malwareStrikeFor(
  db: Executor,
  userId: string | null,
  nodeId: string,
): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await db
    .select({ id: strikes.id })
    .from(strikes)
    .where(
      and(
        eq(strikes.userId, userId),
        eq(strikes.kind, "malware"),
        eq(strikes.nodeId, nodeId),
        isNull(strikes.liftedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Was the user's legal hold set BY HAND? The newest of the user's `admin.legal_hold_set` /
 * `admin.legal_hold_cleared` audit rows is a set. ("Release holds" keeps such a hold.)
 */
export async function legalHoldSetByHand(db: Executor, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "user"),
        eq(auditLog.targetId, userId),
        inArray(auditLog.action, ["admin.legal_hold_set", "admin.legal_hold_cleared"]),
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(1);
  return row?.action === "admin.legal_hold_set";
}

/** Sets the account's quota. Returns the value before and after, or null for no such user. */
export async function setQuota(db: Executor, userId: string, quotaBytes: number) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ quotaBytes: user.quotaBytes })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!row) return null;
    await tx.update(user).set({ quotaBytes }).where(eq(user.id, userId));
    return { before: row.quotaBytes, after: quotaBytes };
  });
}

/** The countries the user's sessions came from (the evidence step). */
export async function signInCountries(db: Executor, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ country: session.country })
    .from(session)
    .where(and(eq(session.userId, userId), isNotNull(session.country)));
  return rows.map((row) => row.country!).sort();
}

/** `settings.orphanDeleteEnabled` as the table has it NOW (default on), past the 60 s cache. */
export async function orphanDeleteSetting(db: Executor): Promise<boolean> {
  const result = await db.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = 'orphanDeleteEnabled'`,
  );
  return result.rows[0]?.value !== false;
}

/** Accounts a terms bump would ask again: every account not on its way out. */
export async function termsAccounts(db: Executor): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(isNull(user.deleteScheduledAt));
  return Number(row?.n ?? 0);
}

// ── dashboard ───────────────────────────────────────────────────────────────────────────────

export async function dashboardCounts(db: Executor) {
  const result = await db.execute<{
    users: number;
    new7d: number;
    storage: string;
    uploads24h: number;
    downloads: number;
    download_bytes: string;
    in_error: number;
    open_reports: number;
    oldest_open: string | null;
    strikes7d: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM "user") AS users,
      (SELECT count(*)::int FROM "user" u WHERE u.created_at > now() - interval '7 days') AS new7d,
      (SELECT COALESCE(sum(u.used_bytes), 0)::bigint FROM "user" u) AS storage,
      (SELECT count(*)::int FROM uploads up WHERE up.status = 'done' AND up.completed_at > now() - interval '24 hours') AS uploads24h,
      (SELECT COALESCE(sum(d.count), 0)::int FROM download_ledger d
         WHERE d.subject_type = 'user' AND d.day >= (now() AT TIME ZONE 'UTC')::date - 1) AS downloads,
      (SELECT COALESCE(sum(d.bytes), 0)::bigint FROM download_ledger d
         WHERE d.subject_type = 'user' AND d.day >= (now() AT TIME ZONE 'UTC')::date - 1) AS download_bytes,
      (SELECT count(*)::int FROM nodes n WHERE n.scan_status = 'error' AND n.system IS NULL) AS in_error,
      (SELECT count(*)::int FROM reports r WHERE r.status = 'open') AS open_reports,
      (SELECT min(r.created_at) FROM reports r WHERE r.status = 'open') AS oldest_open,
      (SELECT count(*)::int FROM strikes s WHERE s.at > now() - interval '7 days') AS strikes7d`);
  const row = result.rows[0]!;
  const scans = await db.execute<{ verdict: string; n: number }>(sql`
    SELECT COALESCE(j.verdict ->> 'status', j.status::text) AS verdict, count(*)::int AS n
    FROM scan_jobs j WHERE j.finished_at > now() - interval '24 hours' GROUP BY 1`);
  const paused = await db.execute<{ reason: string; n: number }>(sql`
    SELECT r.reason, count(*)::int AS n
    FROM share_links l, unnest(l.pause_reasons) AS r(reason)
    WHERE l.revoked_at IS NULL GROUP BY r.reason`);
  return {
    users: { total: Number(row.users), new7d: Number(row.new7d) },
    storageBytes: Number(row.storage),
    uploads24h: Number(row.uploads24h),
    downloads24h: { count: Number(row.downloads), bytes: Number(row.download_bytes) },
    scans24h: Object.fromEntries(scans.rows.map((r) => [r.verdict, Number(r.n)])),
    nodesInError: Number(row.in_error),
    reports: {
      open: Number(row.open_reports),
      oldestOpenAt: row.oldest_open === null ? null : new Date(row.oldest_open).toISOString(),
    },
    strikes7d: Number(row.strikes7d),
    linksPaused: Object.fromEntries(paused.rows.map((r) => [r.reason, Number(r.n)])),
  };
}

// ── quarantine ──────────────────────────────────────────────────────────────────────────────

const QUARANTINED: Node["scanStatus"][] = ["infected", "suspected_csam", "under_review", "error", "skipped"];

export type QuarantineFilter = {
  status?: "infected" | "suspected_csam" | "under_review" | "error" | "skipped" | "taken_down";
  cursor?: string;
  limit: number;
};

/**
 * Nodes the console must look at: one of the five statuses, or taken down. A taken-down folder
 * is ONE row (its subtree is not expanded). Never a system node. Newest change first.
 */
export async function listQuarantine(db: Executor, filter: QuarantineFilter) {
  const which =
    filter.status === "taken_down"
      ? isNotNull(nodes.takedownAt)
      : filter.status
        ? eq(nodes.scanStatus, filter.status)
        : or(inArray(nodes.scanStatus, QUARANTINED), isNotNull(nodes.takedownAt));
  const key = decodeCursor(filter.cursor);
  const rows = await db
    .select()
    .from(nodes)
    .where(and(isNull(nodes.system), which, before(sql`${nodes.updatedAt}`, sql`${nodes.id}`, key)))
    .orderBy(desc(nodes.updatedAt), desc(nodes.id))
    .limit(filter.limit + 1);
  return page(rows, filter.limit, (row) => ({ at: iso(row.updatedAt), id: row.id }));
}

/** The node row, system rows included (the caller decides), or null. */
export async function nodeRow(db: Executor, nodeId: string): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  return row ?? null;
}

/** The node row locked `FOR UPDATE` (call after the tree lock and the user rows it needs). */
export async function lockNodeRow(tx: Executor, nodeId: string): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  const [row] = await tx.select().from(nodes).where(eq(nodes.id, nodeId)).for("update");
  return row ?? null;
}

export type ConsoleHoldCause =
  | "node_legal_hold"
  | "owner_legal_hold"
  | "suspected_csam"
  | "under_review"
  | "open_notice"
  | "inherited_legal_hold"
  | "inherited_open_notice";

/**
 * What holds this node where it stands — its own five causes and the two that reach down from a
 * folder above, apart (the console shows the folder's cause). The same SQL as the purge gate
 * (queries/holds.ts). A display only: the gate itself decides under the tree lock.
 */
export async function holdCausesOf(db: Executor, nodeId: string): Promise<ConsoleHoldCause[]> {
  if (!isUuid(nodeId)) return [];
  const own = ownCauses(sql`n`, sql`u`);
  const inherited = inheritedCauses(sql`n`);
  const result = await db.execute<Record<ConsoleHoldCause, boolean>>(sql`
    SELECT ${own.node_legal_hold} AS node_legal_hold, ${own.owner_legal_hold} AS owner_legal_hold,
           ${own.suspected_csam} AS suspected_csam, ${own.under_review} AS under_review,
           ${own.open_notice} AS open_notice,
           ${inherited.node_legal_hold} AS inherited_legal_hold,
           ${inherited.open_notice} AS inherited_open_notice
    FROM nodes n JOIN "user" u ON u.id = n.owner_id WHERE n.id = ${nodeId}`);
  const row = result.rows[0];
  if (!row) return [];
  return (Object.keys(row) as ConsoleHoldCause[]).filter((cause) => row[cause] === true);
}

/**
 * Mark false positive: `infected` → `clean`, with its own guard in the statement — only an
 * `infected` node that is not taken down (the caller has locked the row and checked it too).
 * The verdict's detail is kept: the console still shows what had been found. Null: not written.
 */
export async function markClean(tx: Executor, nodeId: string): Promise<Node | null> {
  const [row] = await tx
    .update(nodes)
    .set({ scanStatus: "clean", scanReason: null, scannedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(nodes.id, nodeId), eq(nodes.scanStatus, "infected"), isNull(nodes.takedownAt)))
    .returning();
  return row ?? null;
}

// ── links ───────────────────────────────────────────────────────────────────────────────────

export type AdminLinkRow = ShareLink & { nodeName: string; nodeKind: "file" | "folder"; nodeOwnerId: string };

const linkColumns = {
  link: shareLinks,
  nodeName: nodes.name,
  nodeKind: nodes.kind,
  nodeOwnerId: nodes.ownerId,
};

function flattenLink(row: {
  link: ShareLink;
  nodeName: string;
  nodeKind: "file" | "folder";
  nodeOwnerId: string;
}) {
  return { ...row.link, nodeName: row.nodeName, nodeKind: row.nodeKind, nodeOwnerId: row.nodeOwnerId };
}

export type LinkFilter = {
  ownerId?: string;
  nodeId?: string;
  paused?: "true" | "false";
  cursor?: string;
  limit: number;
};

/** Links by owner or by node (tokens are only stored hashed: there is no token search). */
export async function listLinks(db: Executor, filter: LinkFilter) {
  const key = decodeCursor(filter.cursor);
  const rows = await db
    .select(linkColumns)
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(
      and(
        filter.ownerId ? eq(shareLinks.createdBy, filter.ownerId) : undefined,
        filter.nodeId ? eq(shareLinks.nodeId, filter.nodeId) : undefined,
        filter.paused === "true" ? sql`cardinality(${shareLinks.pauseReasons}) > 0` : undefined,
        filter.paused === "false" ? sql`cardinality(${shareLinks.pauseReasons}) = 0` : undefined,
        before(sql`${shareLinks.createdAt}`, sql`${shareLinks.id}`, key),
      ),
    )
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))
    .limit(filter.limit + 1);
  return page(rows.map(flattenLink), filter.limit, (row) => ({ at: iso(row.createdAt), id: row.id }));
}

export async function linkRow(db: Executor, linkId: string): Promise<AdminLinkRow | null> {
  if (!isUuid(linkId)) return null;
  const [row] = await db
    .select(linkColumns)
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(eq(shareLinks.id, linkId));
  return row ? flattenLink(row) : null;
}

/** Links ON this node (the quarantine detail). */
export async function linksOnNode(db: Executor, nodeId: string): Promise<AdminLinkRow[]> {
  if (!isUuid(nodeId)) return [];
  const rows = await db
    .select(linkColumns)
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(eq(shareLinks.nodeId, nodeId))
    .orderBy(desc(shareLinks.createdAt));
  return rows.map(flattenLink);
}

/** `lockedByAdmin` — this module is its one writer. False when there is no such link. */
export async function setLinkLocked(db: Executor, linkId: string, locked: boolean): Promise<boolean> {
  if (!isUuid(linkId)) return false;
  const rows = await db
    .update(shareLinks)
    .set({ lockedByAdmin: locked })
    .where(eq(shareLinks.id, linkId))
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

/** Live and paused (not revoked) links an owner has: what "bulk revoke" would revoke. */
export async function unrevokedLinkIds(db: Executor, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: shareLinks.id })
    .from(shareLinks)
    .where(and(eq(shareLinks.createdBy, ownerId), isNull(shareLinks.revokedAt)));
  return rows.map((row) => row.id);
}

/** A node's links in sum — the report detail's and the evidence step's link activity. */
export async function linkSummary(db: Executor, nodeId: string) {
  const result = await db.execute<{
    count: number;
    downloads: number;
    bytes: string;
    last: string | null;
    ever_public: boolean;
  }>(sql`
    SELECT count(*)::int AS count, COALESCE(sum(l.download_count), 0)::int AS downloads,
           COALESCE(sum(l.bytes_served), 0)::bigint AS bytes, max(l.last_access_at) AS last,
           EXISTS (SELECT 1 FROM link_access_log a WHERE a.node_id = ${nodeId}) AS ever_public
    FROM share_links l WHERE l.node_id = ${nodeId}`);
  const row = result.rows[0]!;
  return {
    count: Number(row.count),
    downloads: Number(row.downloads),
    bytesServed: Number(row.bytes),
    lastAccessAt: row.last === null ? null : new Date(row.last).toISOString(),
    everPublic: row.ever_public === true || Number(row.count) > 0,
  };
}

// ── reports ─────────────────────────────────────────────────────────────────────────────────

export type ReportFilter = {
  status?: Report["status"];
  category?: Report["category"];
  source?: Report["source"];
  olderThanHours?: number;
  cursor?: string;
  limit: number;
};

export async function listReports(db: Executor, filter: ReportFilter) {
  const key = decodeCursor(filter.cursor);
  const rows = await db
    .select()
    .from(reports)
    .where(
      and(
        filter.status ? eq(reports.status, filter.status) : undefined,
        filter.category ? eq(reports.category, filter.category) : undefined,
        filter.source ? eq(reports.source, filter.source) : undefined,
        filter.olderThanHours
          ? lt(reports.createdAt, sql`now() - make_interval(hours => ${filter.olderThanHours})`)
          : undefined,
        before(sql`${reports.createdAt}`, sql`${reports.id}`, key),
      ),
    )
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(filter.limit + 1);
  return page(rows, filter.limit, (row) => ({ at: iso(row.createdAt), id: row.id }));
}

export async function reportRow(db: Executor, reportId: string): Promise<Report | null> {
  if (!isUuid(reportId)) return null;
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId));
  return row ?? null;
}

/**
 * THE ORDER OF EVERY REPORT STATUS CHANGE (PLAN §6 rule 15, H1): the report's NODE row first
 * (`FOR UPDATE`), then the report. The report is read once unlocked to learn its node; the node is
 * locked; then the report is locked and read again — a report whose node changed meanwhile (it
 * cannot: `node_id` is only ever set null by a purge) is answered as it now is. `node` is null
 * when the report names no node or the node is gone.
 */
export async function lockReportAndNode(
  tx: Executor,
  reportId: string,
): Promise<{ report: Report; node: Node | null } | null> {
  const seen = await reportRow(tx, reportId);
  if (!seen) return null;
  const node = seen.nodeId ? await lockNodeRow(tx, seen.nodeId) : null;
  const [report] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
  if (!report) return null;
  return { report, node };
}

/** Writes a report's status and what goes with it. Call holding the node row, then the report. */
export async function setReportStatus(
  tx: Executor,
  reportId: string,
  patch: Partial<
    Pick<Report, "status" | "resolution" | "assignedTo" | "ncmecStartedAt" | "ncmecFiledAt" | "ncmecReportId">
  > & { resolved?: boolean },
): Promise<Report> {
  const { resolved, ...columns } = patch;
  const [row] = await tx
    .update(reports)
    .set({ ...columns, ...(resolved ? { resolvedAt: sql`now()` } : {}) })
    .where(eq(reports.id, reportId))
    .returning();
  return row!;
}

/** Open or reviewing reports on the node, other than `exceptId`, and how many distinct reporters. */
export async function openReportsOn(db: Executor, nodeId: string, exceptId?: string) {
  const result = await db.execute<{ open: number; reporters: number }>(sql`
    SELECT count(*)::int AS open,
           count(DISTINCT COALESCE(r.reporter_ip_hash_stable, r.reporter_user_id, r.reporter_email::text, r.id::text))::int AS reporters
    FROM reports r
    WHERE r.node_id = ${nodeId} AND r.status IN ('open', 'reviewing')
      ${exceptId ? sql`AND r.id <> ${exceptId}` : sql``}`);
  const row = result.rows[0]!;
  return { open: Number(row.open), reporters: Number(row.reporters) };
}

/** The `csam` reports on a node, ascending — "Release holds" decides on them. */
export async function csamReportsOn(db: Executor, nodeId: string): Promise<Report[]> {
  return db
    .select()
    .from(reports)
    .where(and(eq(reports.nodeId, nodeId), eq(reports.category, "csam")))
    .orderBy(asc(reports.id));
}

/**
 * The OTHER `csam` reports (not `exceptId`; every one for null) whose state in the release table is "never" or "not
 * yet": open, reviewing, or filed less than a year ago (and an `actioned` one with no filing —
 * which cannot exist; treated as "never"). With their node ids — a user named among that node's
 * subjects stays held.
 */
export async function unreleasableCsamReports(
  db: Executor,
  exceptId: string | null,
  nowAt: Date,
): Promise<{ id: string; nodeId: string | null }[]> {
  return db
    .select({ id: reports.id, nodeId: reports.nodeId })
    .from(reports)
    .where(
      and(
        eq(reports.category, "csam"),
        exceptId ? sql`${reports.id} <> ${exceptId}` : undefined,
        or(
          inArray(reports.status, ["open", "reviewing"]),
          and(eq(reports.status, "actioned"), isNull(reports.ncmecFiledAt)),
          and(
            isNotNull(reports.ncmecFiledAt),
            gt(sql`${reports.ncmecFiledAt} + interval '1 year'`, sql`${nowAt.toISOString()}::timestamptz`),
          ),
        ),
      ),
    );
}

/** Nodes other than `nodeId` that are `suspected_csam` right now. (Their subjects stay held.) */
export async function otherLockedNodes(db: Executor, nodeId: string): Promise<string[]> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.scanStatus, "suspected_csam"), sql`${nodes.id} <> ${nodeId}`));
  return rows.map((row) => row.id);
}

/**
 * Does any node in `nodeIds` name `userId` among its CSAM subjects (owner, or uploader of any
 * version: `nodes.created_by`, `node_versions.created_by`, `upload_ips.uploader_id`) — the same
 * derivation as `moderation.csamSubjects`, asked for many nodes at once.
 */
export async function subjectOfAny(
  db: Executor,
  userId: string,
  nodeIds: readonly string[],
): Promise<boolean> {
  const ids = nodeIds.filter(isUuid);
  if (ids.length === 0) return false;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM nodes n WHERE n.id IN (${list}) AND (
        n.owner_id = ${userId} OR n.created_by = ${userId}
        OR EXISTS (SELECT 1 FROM node_versions v WHERE v.node_id = n.id AND v.created_by = ${userId})
        OR EXISTS (SELECT 1 FROM upload_ips i WHERE i.node_id = n.id AND i.uploader_id = ${userId}))
    ) AS found`);
  return result.rows[0]?.found === true;
}

/** Locks the users' rows, ascending by id (PLAN §6 rule 15: user rows before the node). */
export async function lockUsers(tx: Executor, userIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for("update");
  }
}

/** Is the user a subject of any `csam` report whose holds may not be released yet ("never" / "not yet")? */
export async function userIsUnreleasableSubject(db: Executor, userId: string, nowAt: Date): Promise<boolean> {
  const rows = await unreleasableCsamReports(db, null, nowAt);
  return subjectOfAny(
    db,
    userId,
    rows.flatMap((row) => (row.nodeId ? [row.nodeId] : [])),
  );
}

/** When the node was locked (the `scan.suspected_csam` rows) and each time operators were told. */
export async function lockRecord(db: Executor, nodeId: string, reportId: string) {
  const rows = await db
    .select({ at: auditLog.at, action: auditLog.action, meta: auditLog.meta })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, ["scan.suspected_csam", "scan.csam_alert_sent"]),
        or(
          and(eq(auditLog.targetType, "node"), eq(auditLog.targetId, nodeId)),
          and(eq(auditLog.targetType, "report"), eq(auditLog.targetId, reportId)),
        ),
        sql`${auditLog.meta} ->> 'reportId' = ${reportId}`,
      ),
    )
    .orderBy(asc(auditLog.at));
  const lock = rows.find((row) => row.action === "scan.suspected_csam");
  return {
    locked: lock ? { at: iso(lock.at), source: (lock.meta?.source as string | undefined) ?? null } : null,
    alerts: rows
      .filter((row) => row.action === "scan.csam_alert_sent")
      .map((row) => ({
        at: iso(row.at),
        via: (row.meta?.via as string | undefined) ?? null,
        recipients: Number(row.meta?.recipients ?? 0),
      })),
  };
}

/** A node's versions, the current one included (the evidence step). */
export async function versionsOf(db: Executor, node: Node) {
  const kept = await db
    .select({
      versionId: nodeVersions.versionId,
      at: nodeVersions.createdAt,
      createdBy: nodeVersions.createdBy,
    })
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, node.id))
    .orderBy(asc(nodeVersions.createdAt));
  const current = node.versionId
    ? [{ versionId: node.versionId, at: node.updatedAt, createdBy: node.createdBy, current: true }]
    : [];
  return [...kept.map((version) => ({ ...version, current: false })), ...current];
}

// ── uploads kept under "keep and alert" ─────────────────────────────────────────────────────

/** The route owed a locked node for this session: it proved the bytes csam (T22, Addendum 2). */
const owedRowOf = (id: SQL) => sql`EXISTS (SELECT 1 FROM audit_log a
  WHERE a.action = 'upload.csam_node_owed' AND a.target_type = 'upload' AND a.target_id = ${id}::text)`;

export type KeptUploadRow = Upload & {
  listedAs: (typeof hashBlocklist.reason.enumValues)[number] | null;
  owedAt: Date;
};

/**
 * Uploads kept under "keep and alert": `completing`, the route proved them csam (the owed row),
 * and the hash on the session is NOT listed as csam any more — the repair sweep leaves such a
 * session untouched and alerts once (it decides on the stored bytes; this list on the session's
 * hash, which is the server's for an owed session). Oldest first.
 */
export async function listKeptUploads(db: Executor, cursor: string | undefined, limit: number) {
  const key = decodeCursor(cursor);
  const result = await db.execute<{ id: string; created_at: string }>(sql`
    SELECT u.id, u.created_at FROM uploads u
    WHERE u.status = 'completing' AND ${owedRowOf(sql`u.id`)}
      AND NOT EXISTS (SELECT 1 FROM hash_blocklist b WHERE b.sha256 = u.expected_sha256 AND b.reason = 'csam')
      ${key ? sql`AND (u.created_at, u.id::text) < (${key.at}::timestamptz, ${key.id})` : sql``}
    ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit + 1}`);
  const rows: KeptUploadRow[] = [];
  for (const { id } of result.rows) {
    const row = await keptUpload(db, id);
    if (row) rows.push(row);
  }
  return page(rows, limit, (row) => ({ at: iso(row.createdAt), id: row.id }));
}

/** One kept upload — with its hash's blocklist reason and when it was owed — or null. */
export async function keptUpload(db: Executor, uploadId: string): Promise<KeptUploadRow | null> {
  if (!isUuid(uploadId)) return null;
  const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
  if (!row) return null;
  const [owed] = await db
    .select({ at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "upload.csam_node_owed"),
        eq(auditLog.targetType, "upload"),
        eq(auditLog.targetId, uploadId),
      ),
    )
    .orderBy(asc(auditLog.at))
    .limit(1);
  if (!owed) return null;
  const listed = row.expectedSha256
    ? (
        await db
          .select({ reason: hashBlocklist.reason })
          .from(hashBlocklist)
          .where(eq(hashBlocklist.sha256, row.expectedSha256))
      )[0]
    : undefined;
  return { ...row, listedAs: listed?.reason ?? null, owedAt: owed.at };
}

/**
 * Locks a kept session — still `completing`, still owed — or null. Call after the `user` rows the
 * transaction needs (lock order).
 */
export async function lockKeptSession(tx: Executor, uploadId: string): Promise<Upload | null> {
  if (!isUuid(uploadId)) return null;
  const [row] = await tx
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, "completing"), owedRowOf(sql`${uploads.id}`)))
    .for("update");
  return row ?? null;
}

// ── copyright notices ───────────────────────────────────────────────────────────────────────

export type NoticeWithNodes = DmcaNotice & {
  nodes: { nodeId: string; nodeName: string | null; sha256: string | null }[];
};

async function withNodes(db: Executor, notices: DmcaNotice[]): Promise<NoticeWithNodes[]> {
  if (notices.length === 0) return [];
  const rows = await db
    .select()
    .from(dmcaNoticeNodes)
    .where(
      inArray(
        dmcaNoticeNodes.noticeId,
        notices.map((notice) => notice.id),
      ),
    );
  return notices.map((notice) => ({
    ...notice,
    nodes: rows
      .filter((row) => row.noticeId === notice.id)
      .map((row) => ({ nodeId: row.nodeId, nodeName: row.nodeName, sha256: row.sha256 })),
  }));
}

export async function listNotices(
  db: Executor,
  filter: { status?: DmcaNotice["status"]; cursor?: string; limit: number },
) {
  const key = decodeCursor(filter.cursor);
  const rows = await db
    .select()
    .from(dmcaNotices)
    .where(
      and(
        filter.status ? eq(dmcaNotices.status, filter.status) : undefined,
        before(sql`${dmcaNotices.receivedAt}`, sql`${dmcaNotices.id}`, key),
      ),
    )
    .orderBy(desc(dmcaNotices.receivedAt), desc(dmcaNotices.id))
    .limit(filter.limit + 1);
  const paged = page(rows, filter.limit, (row) => ({ at: iso(row.receivedAt), id: row.id }));
  return { items: await withNodes(db, paged.items), nextCursor: paged.nextCursor };
}

export async function noticeById(db: Executor, noticeId: string): Promise<NoticeWithNodes | null> {
  if (!isUuid(noticeId)) return null;
  const [row] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, noticeId));
  return row ? ((await withNodes(db, [row]))[0] ?? null) : null;
}

/** The distinct owners of a notice's nodes, ascending (whose tree locks a notice write takes). */
export async function noticeOwners(db: Executor, noticeId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ ownerId: nodes.ownerId })
    .from(dmcaNoticeNodes)
    .innerJoin(nodes, eq(nodes.id, dmcaNoticeNodes.nodeId))
    .where(eq(dmcaNoticeNodes.noticeId, noticeId));
  return rows.map((row) => row.ownerId).sort();
}

/** `lockOwnerTree` for each owner, ascending — FIRST in the transaction (PLAN §6 rule 15). */
export async function lockOwnerTrees(tx: Executor, ownerIds: readonly string[]): Promise<void> {
  for (const ownerId of [...new Set(ownerIds)].sort()) await lockOwnerTree(tx, ownerId);
}

export type NewNotice = Omit<
  typeof dmcaNotices.$inferInsert,
  "id" | "status" | "handledBy" | "createdAt" | "updatedAt"
>;

/**
 * Inserts one notice and snapshots its nodes into `dmca_notice_nodes` (name and hash as they are
 * now). The caller holds the tree locks of the nodes' owners: an open notice protects what it names.
 */
export async function insertNotice(
  tx: Executor,
  notice: NewNotice,
  nodeRows: readonly Pick<Node, "id" | "name" | "sha256">[],
  handledBy: string,
): Promise<DmcaNotice> {
  const [row] = await tx
    .insert(dmcaNotices)
    .values({ ...notice, handledBy })
    .returning();
  if (nodeRows.length > 0) {
    await tx.insert(dmcaNoticeNodes).values(
      nodeRows.map((node) => ({
        noticeId: row!.id,
        nodeId: node.id,
        nodeName: node.name,
        sha256: node.sha256,
      })),
    );
  }
  return row!;
}

/**
 * A notice's transition as a CONDITIONAL write: only from one of `from`. Null when the notice is
 * not in such a state (already moved — a double-click, a retry — or never allowed it).
 */
export async function transitionNotice(
  tx: Executor,
  noticeId: string,
  from: readonly DmcaNotice["status"][],
  patch: Partial<typeof dmcaNotices.$inferInsert>,
): Promise<DmcaNotice | null> {
  if (!isUuid(noticeId)) return null;
  const [row] = await tx
    .update(dmcaNotices)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(dmcaNotices.id, noticeId), inArray(dmcaNotices.status, [...from])))
    .returning();
  return row ?? null;
}

/** Writes columns of a notice that change no status (`ownerNotifiedAt`, `strikeId`, the counter fields). */
export async function updateNotice(
  tx: Executor,
  noticeId: string,
  patch: Partial<typeof dmcaNotices.$inferInsert>,
): Promise<DmcaNotice | null> {
  const [row] = await tx
    .update(dmcaNotices)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(dmcaNotices.id, noticeId))
    .returning();
  return row ?? null;
}

/**
 * Claims the notice's owner mail: sets `ownerNotifiedAt` if it is not set yet. True for the one
 * call that set it — so a repeated or concurrent takedown sends no second mail.
 */
export async function claimOwnerNotified(db: Executor, noticeId: string): Promise<boolean> {
  const rows = await db
    .update(dmcaNotices)
    .set({ ownerNotifiedAt: sql`now()` })
    .where(and(eq(dmcaNotices.id, noticeId), isNull(dmcaNotices.ownerNotifiedAt)))
    .returning({ id: dmcaNotices.id });
  return rows.length > 0;
}

export const NOTICE_OPEN: readonly DmcaNotice["status"][] = OPEN_NOTICE_STATUSES;

// ── invites ─────────────────────────────────────────────────────────────────────────────────

export async function listInvites(db: Executor, filter: { cursor?: string; limit: number }) {
  const key = decodeCursor(filter.cursor);
  const rows = await db
    .select()
    .from(invites)
    .where(before(sql`${invites.createdAt}`, sql`${invites.code}`, key))
    .orderBy(desc(invites.createdAt), desc(invites.code))
    .limit(filter.limit + 1);
  return page(rows, filter.limit, (row) => ({ at: iso(row.createdAt), id: row.code }));
}

/** Every invite, newest first (the CSV export). */
export async function allInvites(db: Executor): Promise<Invite[]> {
  return db.select().from(invites).orderBy(desc(invites.createdAt), desc(invites.code));
}

// No 0/O/1/I/L: codes are read aloud and typed by hand (the same alphabet as scripts/create-invite.ts).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
  let out = "";
  while (out.length < 20) {
    for (const value of crypto.getRandomValues(new Uint8Array(32))) {
      // Rejection sampling keeps the characters uniform (248 = 8 × 31).
      if (value < 248 && out.length < 20) out += ALPHABET[value % ALPHABET.length];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

export async function createInvites(
  db: Executor,
  input: { count: number; maxUses: number; expiresAt: Date | null; note: string | null; createdBy: string },
): Promise<Invite[]> {
  return db
    .insert(invites)
    .values(
      Array.from({ length: input.count }, () => ({
        code: newCode(),
        createdBy: input.createdBy,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt,
        note: input.note,
      })),
    )
    .returning();
}

/** Revokes an invite. Null when there is no such code; the row as it now is otherwise. */
export async function revokeInvite(
  db: Executor,
  code: string,
): Promise<{ invite: Invite; changed: boolean } | null> {
  const changed = await db
    .update(invites)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(invites.code, code), isNull(invites.revokedAt)))
    .returning();
  if (changed[0]) return { invite: changed[0], changed: true };
  const [row] = await db.select().from(invites).where(eq(invites.code, code));
  return row ? { invite: row, changed: false } : null;
}

// ── audit ───────────────────────────────────────────────────────────────────────────────────

export type AuditFilter = {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

function auditWhere(filter: Omit<AuditFilter, "limit">): SQL | undefined {
  const key = decodeCursor(filter.cursor);
  return and(
    filter.actorUserId ? eq(auditLog.actorUserId, filter.actorUserId) : undefined,
    filter.action ? eq(auditLog.action, filter.action) : undefined,
    filter.targetType ? eq(auditLog.targetType, filter.targetType) : undefined,
    filter.targetId ? eq(auditLog.targetId, filter.targetId) : undefined,
    filter.from ? sql`${auditLog.at} >= ${filter.from}::timestamptz` : undefined,
    filter.to ? sql`${auditLog.at} <= ${filter.to}::timestamptz` : undefined,
    before(sql`${auditLog.at}`, sql`${auditLog.id}`, key),
  );
}

/** Columns the console reads: never the daily IP hash. */
const auditColumns = {
  id: auditLog.id,
  at: auditLog.at,
  actorUserId: auditLog.actorUserId,
  actorType: auditLog.actorType,
  action: auditLog.action,
  targetType: auditLog.targetType,
  targetId: auditLog.targetId,
  ua: auditLog.ua,
  country: auditLog.country,
  requestId: auditLog.requestId,
  meta: auditLog.meta,
};
export type AuditViewRow = {
  id: string;
  at: Date;
  actorUserId: string | null;
  actorType: "user" | "admin" | "system" | "link";
  action: string;
  targetType: string | null;
  targetId: string | null;
  ua: string | null;
  country: string | null;
  requestId: string | null;
  meta: Record<string, unknown> | null;
};

export async function listAudit(db: Executor, filter: AuditFilter) {
  const rows = (await db
    .select(auditColumns)
    .from(auditLog)
    .where(auditWhere(filter))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(filter.limit + 1)) as AuditViewRow[];
  return page(rows, filter.limit, (row) => ({ at: iso(row.at), id: row.id }));
}

/** One batch of the CSV export, after `cursor`. */
export async function auditBatch(db: Executor, filter: Omit<AuditFilter, "limit">, limit: number) {
  return listAudit(db, { ...filter, limit });
}

/**
 * Who each actor id is. An id with no `user` row any more maps to null ("deleted account"): the
 * audit row stays, and is never joined away.
 */
export async function actorsOf(db: Executor, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null && BA_ID.test(id)))];
  const found =
    wanted.length === 0
      ? []
      : await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, wanted));
  const names = new Map(found.map((row) => [row.id, row.name]));
  return Object.fromEntries(
    wanted.map((id) => {
      const name = names.get(id);
      return [id, name === undefined ? null : { id, displayName: name }];
    }),
  );
}

// ── kept for the DTOs ───────────────────────────────────────────────────────────────────────

/** The display names of these users (absent: no account). */
export async function namesOf(db: Executor, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].filter((id) => BA_ID.test(id));
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}
