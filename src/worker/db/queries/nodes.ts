// Nodes: listings, the tree mutations, and the helpers that carry cross-task invariants
// (visibility, the rescan throttle, the verdict writer, the guarded Replace).
//
// Visibility. Every listing here excludes system nodes (avatars), taken-down nodes and trashed
// rows, and takes a MANDATORY `visibleStatuses`: the owner's view passes every status except
// `suspected_csam`, link and share views pass `['clean']`. A folder's own status is `clean`.

import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { extOf, nameKeyOf, sanitizeName } from "../../services/filename";
import type { Executor } from "../client";
import { decodeCursor, encodeCursor, isCursorTimestamp } from "../cursor";
import { isUniqueViolation, LegalHoldError, QueryError } from "../errors";
import { isUuid } from "../ids";
import {
  type Node,
  nodes,
  nodeVersions,
  type ScanDetail,
  type ScanReason,
  type ScanStatus,
  shareLinks,
  shares,
  uploads,
  user,
} from "../schema";
import { lostByLeaving } from "./holds";
import {
  effectiveHidden,
  isDescendantOrSelf,
  lockOwnerTree,
  NO_SUCH_OWNER_ID,
  nodeVisibility,
  notEffectivelyTrashedOrHidden,
  notHiddenRow,
} from "./tree";

export type NodeSort = "name" | "size" | "updated" | "kind";
export type SortDir = "asc" | "desc";
type Kind = "file" | "folder";

/** The owner's view: everything except `suspected_csam`. */
export const OWNER_VISIBLE_STATUSES: ScanStatus[] = [
  "pending",
  "clean",
  "infected",
  "skipped",
  "error",
  "under_review",
];

/**
 * WHAT ANYONE BUT THE OWNER SEES OF A FILE — the one definition, for the listings and for the
 * by-id answer (`permissions.getAccess`) alike. A share partner and a link visitor are both
 * "not the owner".
 *
 * A listing for a non-owner passes `SHARED_VISIBLE_STATUSES`: scanned and clean, nothing else.
 */
export const SHARED_VISIBLE_STATUSES: readonly ScanStatus[] = ["clean"];

/**
 * BY ID only, and only for the partner who uploaded the file's CURRENT version (`created_by`,
 * which `replaceVersion` rewrites): they can watch their own upload be scanned and blocked.
 * Never `under_review` — that somebody reported a file is nobody's to learn but the owner's.
 * These are not listed for them: a non-owner's listing is `SHARED_VISIBLE_STATUSES`.
 */
export const UPLOADER_VISIBLE_STATUSES: readonly ScanStatus[] = ["pending", "infected", "skipped", "error"];

/**
 * May someone who is NOT the owner see this node by id? A folder: yes. A file: when their listing
 * would show it (`SHARED_VISIBLE_STATUSES`), or when they uploaded its current version and it is
 * in one of `UPLOADER_VISIBLE_STATUSES`. `viewerId` null = nobody in particular (a link visitor):
 * no upload is theirs, and a file whose uploader is gone (`createdBy` null) is nobody's.
 * Role, takedown, trash and the owner's own view are not decided here.
 */
export function partnerSees(
  node: { kind: Kind; scanStatus: ScanStatus; createdBy: string | null },
  viewerId: string | null,
): boolean {
  if (node.kind !== "file" || SHARED_VISIBLE_STATUSES.includes(node.scanStatus)) return true;
  return (
    viewerId !== null && node.createdBy === viewerId && UPLOADER_VISIBLE_STATUSES.includes(node.scanStatus)
  );
}

/** Replaced versions are kept this long before the purge job removes them. */
export const VERSION_RETENTION_DAYS = 30;

const MAX_PAGE = 200;
const LIVE_NAME_INDEXES = ["nodes_live_name_root_uq", "nodes_live_name_child_uq"] as const;

/** `updated_at` with its full microsecond precision; a JS `Date` would lose three digits. */
const updatedKey = sql<string>`to_char(${nodes.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function clampLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new QueryError("validation", "invalid limit");
  return Math.min(limit, max);
}

/**
 * The exclusions every listing shares — each a test of the row ITSELF. A listing that is not
 * scoped to one parent the caller has already resolved (Starred, Recent) adds the inherited
 * form, `notEffectivelyTrashedOrHidden()`: a file inside a trashed or a taken-down folder is
 * not listed either.
 */
function visible(visibleStatuses: readonly ScanStatus[]): SQL[] {
  return [
    isNull(nodes.system),
    isNull(nodes.takedownAt),
    isNull(nodes.deletedAt),
    inArray(nodes.scanStatus, [...visibleStatuses]),
  ];
}

// ── keyset listings ─────────────────────────────────────────────────────────────────────────

type KeysetCursor = {
  /** Identifies the listing: parent and owner, or the starred list. */
  scope: string;
  sort: NodeSort;
  dir: SortDir;
  kind: Kind;
  /** The sort key of the last row, then its id. */
  key: (string | number)[];
  id: string;
};

function isKeysetCursor(value: unknown): value is KeysetCursor {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.scope === "string" &&
    (c.sort === "name" || c.sort === "size" || c.sort === "updated" || c.sort === "kind") &&
    (c.dir === "asc" || c.dir === "desc") &&
    (c.kind === "file" || c.kind === "folder") &&
    Array.isArray(c.key) &&
    c.key.every((k) => typeof k === "string" || (typeof k === "number" && Number.isSafeInteger(k))) &&
    isUuid(c.id)
  );
}

/** Text a cursor may carry into a `::text` comparison: Postgres refuses a NUL byte in text. */
const isCursorText = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");

/**
 * Does a cursor's key have the types its sort compares? A cursor is unsigned base64 JSON, so
 * anyone can write one: a key that is not what the cast in `keysetPage` expects must be refused
 * here as `validation`, not reach Postgres and come back as a failed cast (a 500).
 */
function keyFitsSort(sort: NodeSort, key: readonly (string | number)[]): boolean {
  switch (sort) {
    case "name":
      return key.length === 1 && isCursorText(key[0]);
    case "size":
      return key.length === 1 && typeof key[0] === "number" && Number.isSafeInteger(key[0]) && key[0] >= 0;
    case "updated":
      return key.length === 1 && isCursorTimestamp(key[0]);
    case "kind":
      return key.length === 2 && isCursorText(key[0]) && isCursorText(key[1]);
  }
}

/** Per sort: the ordered columns (id comes last in every order) and the row → key mapping. */
function sortSpec(sort: NodeSort): {
  columns: SQL[];
  casts: string[];
  keyOf: (row: { node: Node; updatedKey: string }) => (string | number)[];
} {
  switch (sort) {
    case "name":
      return { columns: [sql`${nodes.nameKey}`], casts: ["text"], keyOf: (r) => [r.node.nameKey] };
    case "size":
      return { columns: [sql`${nodes.size}`], casts: ["bigint"], keyOf: (r) => [r.node.size] };
    case "updated":
      return { columns: [sql`${nodes.updatedAt}`], casts: ["timestamptz"], keyOf: (r) => [r.updatedKey] };
    case "kind":
      return {
        columns: [sql`${nodes.ext}`, sql`${nodes.nameKey}`],
        casts: ["text", "text"],
        keyOf: (r) => [r.node.ext, r.node.nameKey],
      };
  }
}

/**
 * One page of a keyset listing. Folders come first in every order, so the listing is read as two
 * segments, `kind = 'folder'` then `kind = 'file'`: with the kind fixed, each segment is one
 * ordered range of an index on (…, kind, <sort key>, id), in either direction.
 */
async function keysetPage(
  db: Executor,
  args: {
    scope: string;
    where: SQL[];
    sort: NodeSort;
    dir: SortDir;
    kind?: Kind;
    cursor?: string | null;
    limit: number;
  },
): Promise<{ items: Node[]; nextCursor: string | null }> {
  const { scope, sort, dir, limit } = args;
  const spec = sortSpec(sort);
  const segments: Kind[] = args.kind ? [args.kind] : ["folder", "file"];

  let after: KeysetCursor | undefined;
  if (args.cursor) {
    after = decodeCursor("nodes", args.cursor, isKeysetCursor);
    if (
      after.scope !== scope ||
      after.sort !== sort ||
      after.dir !== dir ||
      !keyFitsSort(sort, after.key) ||
      !segments.includes(after.kind)
    ) {
      throw new QueryError("validation", "cursor does not match this listing");
    }
  }

  const order = dir === "asc" ? asc : desc;
  const rows: { node: Node; updatedKey: string }[] = [];
  for (let i = after ? segments.indexOf(after.kind) : 0; i < segments.length && rows.length <= limit; i++) {
    const kind = segments[i]!;
    const conditions = [...args.where, eq(nodes.kind, kind)];
    if (after && after.kind === kind) {
      const left = sql.join([...spec.columns, sql`${nodes.id}`], sql`, `);
      const right = sql.join(
        [...after.key.map((value, n) => sql`${value}::${sql.raw(spec.casts[n]!)}`), sql`${after.id}::uuid`],
        sql`, `,
      );
      conditions.push(dir === "asc" ? sql`(${left}) > (${right})` : sql`(${left}) < (${right})`);
    }
    const segment = await db
      .select({ node: getTableColumns(nodes), updatedKey })
      .from(nodes)
      .where(and(...conditions))
      .orderBy(...spec.columns.map((column) => order(column)), order(nodes.id))
      .limit(limit + 1 - rows.length);
    rows.push(...segment);
  }

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor("nodes", {
          scope,
          sort,
          dir,
          kind: last.node.kind,
          key: spec.keyOf(last),
          id: last.node.id,
        } satisfies KeysetCursor)
      : null;
  return { items: page.map((r) => r.node), nextCursor };
}

export type ListChildrenArgs = {
  /** The tree being listed. Every row of a folder has its owner, and the top level needs it. */
  scope: { ownerId: string };
  /** Null = the owner's top level. */
  parentId: string | null;
  sort: NodeSort;
  dir: SortDir;
  cursor?: string | null;
  /** 1–200. */
  limit: number;
  kind?: Kind;
  visibleStatuses: readonly ScanStatus[];
};

/**
 * The direct children of a folder (or the top level), folders first, keyset-paginated. The cursor
 * is opaque and tied to the folder, the sort and the direction; any other cursor is `validation`.
 * Whether the folder itself may be listed (permission, trash, a takedown of it or of an ancestor)
 * is the caller's check; a taken-down CHILD is left out here, by the row's own test.
 */
export async function listChildren(
  db: Executor,
  args: ListChildrenArgs,
): Promise<{ items: Node[]; nextCursor: string | null }> {
  if (args.parentId !== null && !isUuid(args.parentId)) return { items: [], nextCursor: null };
  const limit = clampLimit(args.limit, MAX_PAGE);
  if (args.visibleStatuses.length === 0) return { items: [], nextCursor: null };
  return keysetPage(db, {
    scope: `children:${args.scope.ownerId}:${args.parentId ?? "root"}`,
    where: [
      args.parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, args.parentId),
      eq(nodes.ownerId, args.scope.ownerId),
      ...visible(args.visibleStatuses),
    ],
    sort: args.sort,
    dir: args.dir,
    kind: args.kind,
    cursor: args.cursor,
    limit,
  });
}

/**
 * The owner's starred nodes by name, folders first; nothing that sits in the trash or under a
 * taken-down folder.
 */
export async function listStarred(
  db: Executor,
  ownerId: string,
  opts: { cursor?: string | null; limit: number; visibleStatuses: readonly ScanStatus[] },
): Promise<{ items: Node[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit, MAX_PAGE);
  if (opts.visibleStatuses.length === 0) return { items: [], nextCursor: null };
  return keysetPage(db, {
    scope: `starred:${ownerId}`,
    where: [
      eq(nodes.ownerId, ownerId),
      eq(nodes.starred, true),
      ...visible(opts.visibleStatuses),
      notEffectivelyTrashedOrHidden(),
    ],
    sort: "name",
    dir: "asc",
    cursor: opts.cursor,
    limit,
  });
}

/**
 * The owner's most recently opened files (at most 50), newest first; nothing that sits in the
 * trash or under a taken-down folder.
 */
export async function listRecent(
  db: Executor,
  ownerId: string,
  opts: { limit: number; visibleStatuses: readonly ScanStatus[] },
): Promise<Node[]> {
  const limit = clampLimit(opts.limit, 50);
  if (opts.visibleStatuses.length === 0) return [];
  return db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.kind, "file"),
        isNotNull(nodes.lastAccessedAt),
        ...visible(opts.visibleStatuses),
        notEffectivelyTrashedOrHidden(),
      ),
    )
    .orderBy(sql`${nodes.lastAccessedAt} DESC NULLS LAST`, desc(nodes.updatedAt), desc(nodes.id))
    .limit(limit);
}

// ── single-node reads and writes ────────────────────────────────────────────────────────────

/** The row, whatever its state. Visibility is the caller's decision. */
export async function getNode(db: Executor, nodeId: string): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return row ?? null;
}

/** Runs a name-changing write in a savepoint and turns a live-name collision into `conflict`. */
async function withNameConflict<T>(db: Executor, write: (tx: Executor) => Promise<T>): Promise<T> {
  try {
    return await db.transaction((tx) => write(tx));
  } catch (error) {
    if (isUniqueViolation(error, LIVE_NAME_INDEXES)) {
      throw new QueryError("conflict", "a file or folder with that name already exists here");
    }
    throw error;
  }
}

/**
 * Creates a folder. `ownerId` is the owner of the tree, `createdBy` the caller (an editor inside
 * a shared folder is not the owner). `not_found` when the parent is not a live folder of that
 * owner — in the trash or hidden, itself or by a folder above it, included; `conflict` when the
 * name is taken; `validation` for an unusable name.
 *
 * The parent's state is read before the insert, not under a lock: a folder created in the
 * instant its parent is trashed or taken down is inside it, and is trashed or hidden with it.
 * Every `not_found` costs the same two reads, whatever its reason. (`conflict` is the unique
 * index's answer, and the index knows every live name in the folder — a hidden sibling's too.)
 */
export async function createFolder(
  db: Executor,
  args: { ownerId: string; createdBy: string; parentId: string | null; name: string },
): Promise<Node> {
  const name = sanitizeName(args.name);
  if (args.parentId !== null) {
    // Both reads, then the decision: a hidden parent costs what an id that was never issued costs.
    const parent = await getNode(db, args.parentId);
    const place = await nodeVisibility(db, args.parentId);
    if (
      !parent ||
      parent.kind !== "folder" ||
      parent.ownerId !== args.ownerId ||
      parent.system !== null ||
      place.trashed ||
      place.hidden
    ) {
      throw new QueryError("not_found");
    }
  }
  return withNameConflict(db, async (tx) => {
    const [row] = await tx
      .insert(nodes)
      .values({
        ownerId: args.ownerId,
        createdBy: args.createdBy,
        parentId: args.parentId,
        kind: "folder",
        name,
        nameKey: nameKeyOf(name),
        ext: "",
        scanStatus: "clean",
      })
      .returning();
    return row!;
  });
}

/**
 * Rewrites `name`, `nameKey` and `ext` together. The object key and version do not change.
 * `not_found` for an id that does not exist, a system node, and a HIDDEN node (`notHiddenRow`,
 * in the statement itself): the name of a file that is locked or taken down is not altered.
 */
export async function rename(db: Executor, nodeId: string, rawName: string): Promise<Node> {
  const name = sanitizeName(rawName);
  if (!isUuid(nodeId)) throw new QueryError("not_found");
  return withNameConflict(db, async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({
        name,
        nameKey: nameKeyOf(name),
        ext: sql`CASE WHEN ${nodes.kind} = 'file' THEN ${extOf(name)} ELSE '' END`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(nodes.id, nodeId), isNull(nodes.system), notHiddenRow()))
      .returning();
    if (!row) throw new QueryError("not_found");
    return row;
  });
}

export type Moved = {
  /** The row as it is now. */
  node: Node;
  /** Where it was, read under the tree lock: what an audit row's `from` is. */
  previousParentId: string | null;
  /** False when it already was there: nothing was written, and there is nothing to record. */
  changed: boolean;
};

/**
 * Moves a node under another folder of the same owner (null = the top level). One transaction:
 * it takes the owner's TREE LOCK first (queries/tree.ts — two concurrent moves could otherwise
 * each pass the cycle check and together build a cycle, and a purge, a hold or a takedown being
 * placed could otherwise decide on a tree that is changing), then the node and the target are
 * locked `FOR UPDATE`. `conflict` for a cycle or a name collision; `not_found` for a missing,
 * trashed (itself or under a trashed folder), system or foreign node or target.
 *
 * `not_found` as well — nothing written — for a node or a target that is HIDDEN: taken down
 * itself or by a folder above it, or locked as suspected CSAM. Decided here, under the locks,
 * not on what the caller read before: a takedown takes this tree lock (`moderation.takedownNode`
 * — the admin's and a notice's alike) and the CSAM lock and the verdict writer take the node's
 * row, so each has either committed and is seen, or waits until the move is done. Without it a
 * file moved out of a folder as that folder is taken down would come out visible.
 *
 * `LegalHoldError` — the purge gate's own error, the cause in it, and like there NEVER to be
 * shown to the caller — when the move would take the node out from under a folder that is on
 * legal hold or named by an open notice: outside it nothing would protect the node, and it
 * could be trashed and purged. Nothing is moved.
 *
 * THE SAME WORK FOR EVERY `not_found`: whatever makes it one — no such node, a foreign, system,
 * trashed or hidden node, or any of those for the target — the same statements have been sent
 * (the tree lock of an owner no account has, when there is no node to read one from), and all of
 * them are answered before the cycle is looked for: a hidden node or target is `not_found`
 * exactly as an id that was never issued, never a `conflict`. What is NOT hidden by this: the
 * name. A `conflict` on the name comes from the unique index, which knows every live name in
 * the destination — a hidden sibling's included.
 *
 * Returns where the node was as well: the caller's own earlier read of the parent is not the
 * move's (two moves racing), and `changed: false` is a move that did nothing.
 */
export async function moveNode(db: Executor, nodeId: string, newParentId: string | null): Promise<Moved> {
  if (!isUuid(nodeId) || (newParentId !== null && !isUuid(newParentId))) throw new QueryError("not_found");
  const peek = await getNode(db, nodeId);
  return withNameConflict(db, async (tx) => {
    await lockOwnerTree(tx, peek ? peek.ownerId : NO_SUCH_OWNER_ID);
    const ids = newParentId === null ? [nodeId] : [nodeId, newParentId];
    const locked = await tx
      .select()
      .from(nodes)
      .where(inArray(nodes.id, ids))
      .orderBy(nodes.id)
      .for("update");
    // Read now, under the locks — and read for every question, before anything is decided.
    // Trashed by ancestry too: moving a node out of a trashed folder would be a restore that
    // skips `restore` (and takes content out of a folder whose purge may already be requested).
    // Hidden, itself or by ancestry: at its new place it would no longer be under the folder
    // that hides it.
    const here = await nodeVisibility(tx, nodeId);
    const there = newParentId === null ? null : await nodeVisibility(tx, newParentId);
    const node = locked.find((row) => row.id === nodeId);
    if (
      !peek ||
      !node ||
      node.system !== null ||
      node.ownerId !== peek.ownerId ||
      here.trashed ||
      here.hidden
    ) {
      throw new QueryError("not_found");
    }
    if (newParentId !== null) {
      const target = locked.find((row) => row.id === newParentId);
      if (
        !target ||
        target.kind !== "folder" ||
        target.system !== null ||
        target.ownerId !== node.ownerId ||
        !there ||
        there.trashed ||
        there.hidden
      ) {
        throw new QueryError("not_found");
      }
      if (await isDescendantOrSelf(tx, newParentId, nodeId)) {
        throw new QueryError("conflict", "a folder cannot be moved into itself");
      }
    }
    if (node.parentId === newParentId) return { node, previousParentId: node.parentId, changed: false };
    // A hold or an open notice on a folder above protects this node only while it stays under
    // it: a move that would take it OUT from under one is refused. Moving within that folder, or
    // into a protected one, is fine; a hold of the node's own travels with it.
    const lost = await lostByLeaving(tx, nodeId, newParentId);
    if (lost.length > 0) throw new LegalHoldError({ [nodeId]: lost });
    const [row] = await tx
      .update(nodes)
      .set({ parentId: newParentId, updatedAt: sql`now()` })
      .where(eq(nodes.id, nodeId))
      .returning();
    return { node: row!, previousParentId: node.parentId, changed: true };
  });
}

/** `moveNode`, for a caller that only wants the row. */
export async function move(db: Executor, nodeId: string, newParentId: string | null): Promise<Node> {
  return (await moveNode(db, nodeId, newParentId)).node;
}

/** False when no such node exists — a hidden node (`notHiddenRow`) included: nothing is written. */
export async function setStar(db: Executor, nodeId: string, starred: boolean): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({ starred })
    .where(and(eq(nodes.id, nodeId), isNull(nodes.system), notHiddenRow()))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/**
 * Sets `lastAccessedAt`, at most once per 10 minutes per node. True when it wrote. Never on a
 * hidden node (`notHiddenRow`): nobody opened it.
 */
export async function touchAccessed(db: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({ lastAccessedAt: sql`now()` })
    .where(
      and(
        eq(nodes.id, nodeId),
        sql`(${nodes.lastAccessedAt} IS NULL OR ${nodes.lastAccessedAt} < now() - interval '10 minutes')`,
        notHiddenRow(),
      ),
    )
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/**
 * The owner-rescan throttle: one request per node per hour, taken atomically. False = throttled
 * (or no such node). Whether the node's status allows a rescan is the caller's check — and
 * whether it is hidden: this stamps the throttle only, and `scanning.enqueueRescan` decides on
 * the locked row and refuses a hidden node there. (No hidden test here on purpose: false means
 * "throttled" to the caller, which a node hidden in this instant must not be answered with.)
 */
export async function requestRescan(db: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({ rescanRequestedAt: sql`now()` })
    .where(
      and(
        eq(nodes.id, nodeId),
        sql`(${nodes.rescanRequestedAt} IS NULL OR ${nodes.rescanRequestedAt} < now() - interval '1 hour')`,
      ),
    )
    .returning({ id: nodes.id });
  return rows.length > 0;
}

// ── by-key and scan-result helpers ──────────────────────────────────────────────────────────

/** The node whose CURRENT version has that object key, or null. `forUpdate` locks the row. */
export async function findByR2Key(
  tx: Executor,
  r2Key: string,
  opts: { forUpdate?: boolean } = {},
): Promise<Node | null> {
  const query = tx.select().from(nodes).where(eq(nodes.r2Key, r2Key)).limit(1);
  const [row] = opts.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

export type KeyReference = {
  kind: "node" | "version" | "upload";
  /** For `upload`: the node id the session pre-allocated. */
  nodeId: string;
  versionId: string | null;
};

/**
 * What still references an object key: a node's current version, a kept old version, or an
 * `open` / `completing` upload session — in that order of precedence. Null = nothing does.
 */
export async function keyReference(db: Executor, r2Key: string): Promise<KeyReference | null> {
  const [node] = await db
    .select({ nodeId: nodes.id, versionId: nodes.versionId })
    .from(nodes)
    .where(eq(nodes.r2Key, r2Key))
    .limit(1);
  if (node) return { kind: "node", ...node };
  const [version] = await db
    .select({ nodeId: nodeVersions.nodeId, versionId: nodeVersions.versionId })
    .from(nodeVersions)
    .where(eq(nodeVersions.r2Key, r2Key))
    .limit(1);
  if (version) return { kind: "version", ...version };
  const [upload] = await db
    .select({ nodeId: uploads.nodeId, versionId: uploads.versionId })
    .from(uploads)
    .where(and(eq(uploads.r2Key, r2Key), inArray(uploads.status, ["open", "completing"])))
    .limit(1);
  if (upload) return { kind: "upload", ...upload };
  return null;
}

export type ScanResult = {
  scanStatus: ScanStatus;
  /** Absent = cleared. */
  scanReason?: ScanReason | null;
  /** Absent = cleared. */
  scanDetail?: ScanDetail | null;
  /** Absent = left as it is. */
  mimeSniffed?: string | null;
  /** Absent = left as it is. */
  sha256?: string | null;
  scannedAt: Date;
};

/**
 * The one writer of a verdict. The verdict belongs to ONE object — `r2Key`, the key that was
 * scanned — and is written only while that key is still the node's current version. A node that
 * was replaced in the meantime has a new key and a new, unscanned version: a late verdict for the
 * old object must not mark it (null is returned and the caller acknowledges the message).
 *
 * It never weakens a blocking state:
 * - a `suspected_csam` node keeps its status and reason;
 * - an `under_review` node keeps `under_review` and stores the verdict in `scanStatusPrev` (what a
 *   dismissal restores) — unless the verdict is `suspected_csam`, which replaces it;
 * - any other node takes the verdict.
 * The detail, sniffed type, hash and scan time are written in every case.
 * Returns the row as written, or null when there is no such node or `r2Key` is not (or no
 * longer) its current version.
 */
export async function setScanResult(
  tx: Executor,
  nodeId: string,
  r2Key: string,
  result: ScanResult,
): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  const next = sql`${result.scanStatus}::scan_status`;
  const reason = result.scanReason ?? null;
  const kept = sql`(${nodes.scanStatus} = 'suspected_csam' OR (${nodes.scanStatus} = 'under_review' AND ${next} <> 'suspected_csam'))`;
  const [row] = await tx
    .update(nodes)
    .set({
      scanStatus: sql`CASE WHEN ${kept} THEN ${nodes.scanStatus} ELSE ${next} END`,
      scanStatusPrev: sql`CASE
        WHEN ${nodes.scanStatus} = 'under_review' AND ${next} <> 'suspected_csam' THEN ${next}
        WHEN ${nodes.scanStatus} = 'under_review' THEN NULL
        ELSE ${nodes.scanStatusPrev} END`,
      scanReason: sql`CASE WHEN ${nodes.scanStatus} = 'suspected_csam' THEN ${nodes.scanReason} ELSE ${reason} END`,
      scanDetail: result.scanDetail ?? null,
      scannedAt: result.scannedAt,
      ...(result.mimeSniffed !== undefined ? { mimeSniffed: result.mimeSniffed } : {}),
      ...(result.sha256 !== undefined ? { sha256: result.sha256 } : {}),
    })
    .where(and(eq(nodes.id, nodeId), eq(nodes.r2Key, r2Key)))
    .returning();
  return row ?? null;
}

/**
 * Rescan: back to `pending`, the previous verdict cleared. A node that is `under_review` or
 * `suspected_csam` is left alone (false), as is an id that does not exist.
 */
export async function resetToPending(db: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({ scanStatus: "pending", scanReason: null, scanDetail: null, scannedAt: null })
    .where(and(eq(nodes.id, nodeId), sql`${nodes.scanStatus} NOT IN ('under_review', 'suspected_csam')`))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/** What `resetToPending` clears — the verdict a node carried before a rescan was asked for. */
export type ScanState = {
  scanStatus: ScanStatus;
  scanReason: ScanReason | null;
  scanDetail: ScanDetail | null;
  scannedAt: Date | null;
};

/**
 * Undoes a `resetToPending` whose scan message could not be sent: puts back the status and the
 * verdict the node had — ONLY while nothing else has happened to it since: it is still `pending`
 * and `r2Key` is still its current version. A node that was replaced, locked, put under review
 * or given a verdict in between is left as it is (false). `under_review` and `suspected_csam`
 * are never written from a caller's memory (a reset leaves those alone, so there is nothing of
 * theirs to put back).
 */
export async function restoreScanState(
  db: Executor,
  nodeId: string,
  r2Key: string,
  before: ScanState,
): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  if (before.scanStatus === "under_review" || before.scanStatus === "suspected_csam") return false;
  const rows = await db
    .update(nodes)
    .set({
      scanStatus: before.scanStatus,
      scanReason: before.scanReason,
      scanDetail: before.scanDetail,
      scannedAt: before.scannedAt,
    })
    .where(and(eq(nodes.id, nodeId), eq(nodes.r2Key, r2Key), eq(nodes.scanStatus, "pending")))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/**
 * Replace: the node keeps its id, name, shares and links and gets a new current version; the
 * previous one moves to `node_versions` for 30 days. Guarded — allowed only while the node is
 * `clean`, `skipped` or `error`, not taken down — itself or by a folder above it — and neither
 * it nor its owner is on legal hold:
 *   `scan_pending` for `pending`; `scan_blocked` for `infected` / `under_review`;
 *   `not_found` for `suspected_csam`, a held or taken-down node (also one inside a taken-down
 *   folder), a folder, or no node at all.
 * The new version starts `pending`. `createdBy` becomes the node's uploader.
 * Returns the previous `versionId`, so the caller can delete that version's thumbnails.
 * No quota arithmetic: the upload's reservation becomes the new version, and the old version
 * keeps counting until it is purged.
 */
export async function replaceVersion(
  tx: Executor,
  nodeId: string,
  next: { r2Key: string; versionId: string; size: number; sha256: string | null; createdBy: string },
): Promise<{ previousVersionId: string | null }> {
  if (!isUuid(nodeId)) throw new QueryError("not_found");
  return tx.transaction(async (sp) => {
    // Lock order: the owner's `user` row FIRST, then the node (the order of the purge, the
    // reconcile and the CSAM lock — see queries/quota.ts). Locked, not just read: a legal hold
    // being placed on the account either is seen here or waits for this Replace to commit.
    // THE SAME READS FOR EVERY `not_found` — no such node, a folder, a system node, a locked,
    // held or hidden one: all four are sent before anything is decided (the row of an owner no
    // account has, when there is no node to read one from).
    const [peek] = await sp.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId));
    const [owner] = await sp
      .select({ legalHold: user.legalHold })
      .from(user)
      .where(eq(user.id, peek ? peek.ownerId : NO_SUCH_OWNER_ID))
      .for("update");
    const [node] = await sp.select().from(nodes).where(eq(nodes.id, nodeId)).for("update");
    // By ancestry too, read with the row held: a file inside a taken-down folder is as hidden as
    // one taken down itself. (No tree lock here — the owner's row is already held, and the tree
    // lock comes before every row lock: a takedown of a folder above that commits after this
    // read is the same as the Replace having come first.)
    const hidden = await effectiveHidden(sp, nodeId);
    if (!peek || !node || node.kind !== "file" || node.system !== null || node.ownerId !== peek.ownerId) {
      throw new QueryError("not_found");
    }
    if (
      hidden ||
      node.scanStatus === "suspected_csam" ||
      node.legalHold ||
      node.takedownAt !== null ||
      !owner ||
      owner.legalHold
    ) {
      throw new QueryError("not_found");
    }
    if (node.scanStatus === "pending") throw new QueryError("scan_pending");
    if (node.scanStatus === "infected" || node.scanStatus === "under_review")
      throw new QueryError("scan_blocked");

    if (node.r2Key !== null && node.versionId !== null) {
      await sp.insert(nodeVersions).values({
        nodeId: node.id,
        versionId: node.versionId,
        r2Key: node.r2Key,
        size: node.size,
        sha256: node.sha256,
        createdBy: node.createdBy,
        purgeAfter: sql`now() + make_interval(days => ${VERSION_RETENTION_DAYS})`,
      });
    }
    await sp
      .update(nodes)
      .set({
        r2Key: next.r2Key,
        versionId: next.versionId,
        size: next.size,
        sha256: next.sha256,
        createdBy: next.createdBy,
        scanStatus: "pending",
        scanStatusPrev: null,
        scanReason: null,
        scanDetail: null,
        scannedAt: null,
        mimeSniffed: null,
        updatedAt: sql`now()`,
      })
      .where(eq(nodes.id, nodeId));
    return { previousVersionId: node.versionId };
  });
}

export type SharingSummary = {
  /** Share rows on the node itself, pending ones included. */
  people: number;
  /** The best state among the node's links that are not revoked. */
  link: "none" | "active" | "paused" | "expired";
};

/** Sharing state for a page of nodes. Every requested id is in the result. */
export async function sharingSummary(db: Executor, nodeIds: string[]): Promise<Map<string, SharingSummary>> {
  const out = new Map<string, SharingSummary>();
  const ids = [...new Set(nodeIds.filter(isUuid))];
  for (const id of ids) out.set(id, { people: 0, link: "none" });
  if (ids.length === 0) return out;

  const people = await db
    .select({ nodeId: shares.nodeId, people: sql<number>`count(*)`.mapWith(Number) })
    .from(shares)
    .where(inArray(shares.nodeId, ids))
    .groupBy(shares.nodeId);
  for (const row of people) out.get(row.nodeId)!.people = row.people;

  const expired = sql`((${shareLinks.expiresAt} IS NOT NULL AND ${shareLinks.expiresAt} <= now())
    OR (${shareLinks.maxDownloads} IS NOT NULL AND ${shareLinks.downloadCount} >= ${shareLinks.maxDownloads}))`;
  const paused = sql`(cardinality(${shareLinks.pauseReasons}) > 0 OR ${shareLinks.lockedByAdmin})`;
  const links = await db
    .select({
      nodeId: shareLinks.nodeId,
      // 3 = active, 2 = paused, 1 = expired.
      best: sql<number>`max(CASE WHEN ${expired} THEN 1 WHEN ${paused} THEN 2 ELSE 3 END)`.mapWith(Number),
    })
    .from(shareLinks)
    .where(and(inArray(shareLinks.nodeId, ids), isNull(shareLinks.revokedAt)))
    .groupBy(shareLinks.nodeId);
  for (const row of links) {
    out.get(row.nodeId)!.link = row.best === 3 ? "active" : row.best === 2 ? "paused" : "expired";
  }
  return out;
}
