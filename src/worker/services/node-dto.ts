// Node row → `NodeDto`: the ONE place that decides which fields of a file an API answer carries.
// Every route that answers a node (listings, details, upload complete, trash, restore, search,
// recent, starred) maps through here; no route builds a `NodeDto` of its own.
//
// THE RULES
//  - The output is written field by field. Nothing is copied from the row wholesale, so a column
//    added to `nodes` reaches no answer until it is named here. Never the object key, never the
//    version id except as the opaque `etag`, never a hold or takedown column, never the scan
//    detail except its `pua` list.
//  - `owner` and `createdBy` are `{ id, displayName }` — never an email. `createdBy` is null for
//    an anonymised uploader (the column is null, or the account is gone).
//  - WHO IS LOOKING is decided from the row: the viewer is the owner when `row.ownerId` is
//    `view.viewerId`, and the role the caller passes must agree with that (it throws otherwise).
//    Only the owner receives `sharing`, `starred`, `lastAccessedAt`, `sha256`, `scanReason` and
//    `pua`; anyone else gets the zero value of each.
//  - A grantee's share root does not say where it sits in the owner's tree: for anyone but the
//    owner the row that is `view.shareRootId` goes out with `parentId: null` (rows deeper in the
//    share keep theirs — it is inside the share), and so does a search hit without a path hint.
//  - `thumb` is `mime.thumbEligible`: false for anything but a clean image within the size limit.
//  - `deletedAt` / `purgeAfter` are null except in the trash variants, which require both.
//  - A row that no account holder may ever see — `suspected_csam`, taken down, a system node —
//    is refused with a plain `Error`: the caller's listing or `requireRole` should have dropped
//    it, so its arrival here is a programming error and must not become an answer. (A takedown
//    inherited from a folder above cannot be seen on the row; that stays the caller's check.)
//  - Nothing is parsed here; the tests check every output against the shared schemas.
//
// BATCHED. A page costs one names read and one `sharingSummary` call (none when the viewer owns
// no row of the page), whatever its length.

import type { Role } from "../../shared/schemas/common";
import type { NodeDto, NodeSharing, TrashItemDto } from "../../shared/schemas/node";
import type { SearchResultDto } from "../../shared/schemas/search";
import type { Executor } from "../db/client";
import { displayNames } from "../db/queries/node-dto";
import { sharingSummary, type SharingSummary } from "../db/queries/nodes";
import type { Node } from "../db/schema";
import { categoryOf, thumbEligible } from "./mime";

/**
 * What the mapper reads of a `nodes` row. Every T05 query that returns a `Node` satisfies it
 * (`listChildren`, `listStarred`, `listRecent`, `getNode`, `createFolder`, `rename`, `move`,
 * `listTrash`, a search hit's `node`).
 */
export type NodeRow = Pick<
  Node,
  | "id"
  | "ownerId"
  | "createdBy"
  | "parentId"
  | "kind"
  | "name"
  | "ext"
  | "system"
  | "size"
  | "mimeSniffed"
  | "versionId"
  | "sha256"
  | "scanStatus"
  | "scanReason"
  | "scanDetail"
  | "deletedAt"
  | "purgeAfter"
  | "takedownAt"
  | "starred"
  | "createdAt"
  | "updatedAt"
  | "lastAccessedAt"
>;

/**
 * Who the answer is for. `role` is the viewer's role on each row — one value for the page, or a
 * function of the row. `"owner"` exactly when `row.ownerId === viewerId`: a mismatch throws.
 */
export type NodeView<R extends NodeRow = NodeRow> = {
  viewerId: string;
  role: Role | ((row: R) => Role);
  /**
   * The node that grants a non-owner their role (`Access.shareRootId`). That row goes out with
   * `parentId: null` — the folder above it is the owner's own. Ignored for the owner.
   */
  shareRootId?: string | null;
};

/** A search hit as T05 `searchNames` returns it: the role comes with the row. */
export type SearchHitRow = { node: NodeRow; pathHint: string | null; role: Role };

const NOT_SHARED: NodeSharing = { people: 0, link: "none", summary: "none" };

function sharingOf(summary: SharingSummary | undefined): NodeSharing {
  if (!summary) return { ...NOT_SHARED };
  const linked = summary.link !== "none";
  return {
    people: summary.people,
    link: summary.link,
    summary: summary.people > 0 ? (linked ? "both" : "people") : linked ? "link" : "none",
  };
}

type Lookups = { names: Map<string, string>; sharing: Map<string, SharingSummary> };

type Viewer = { viewerId: string; role: Role; isShareRoot: boolean };

function mapRow(row: NodeRow, viewer: Viewer, lookups: Lookups): NodeDto {
  const { viewerId, role } = viewer;
  const { scanStatus } = row;
  if (scanStatus === "suspected_csam" || row.takedownAt !== null || row.system !== null) {
    throw new Error("node-dto: a hidden or system node was handed to the mapper");
  }
  const isOwner = row.ownerId === viewerId;
  if (isOwner !== (role === "owner")) {
    throw new Error("node-dto: the role does not agree with the node's owner");
  }
  const ownerName = lookups.names.get(row.ownerId);
  if (ownerName === undefined) throw new Error("node-dto: the node's owner has no user row");
  const creatorName = row.createdBy === null ? undefined : lookups.names.get(row.createdBy);
  const isFile = row.kind === "file";
  return {
    id: row.id,
    parentId: isOwner || !viewer.isShareRoot ? row.parentId : null,
    kind: row.kind,
    name: row.name,
    ext: row.ext,
    size: row.size,
    mimeCategory: isFile ? categoryOf(row.mimeSniffed, row.ext) : "other",
    mimeSniffed: row.mimeSniffed,
    etag: row.versionId ?? "",
    sha256: isOwner ? row.sha256 : null,
    scanStatus,
    scanReason: isOwner ? row.scanReason : null,
    pua: isOwner ? [...(row.scanDetail?.pua ?? [])] : [],
    thumb: isFile && thumbEligible(row),
    starred: isOwner && row.starred,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAccessedAt: isOwner && row.lastAccessedAt ? row.lastAccessedAt.toISOString() : null,
    deletedAt: null,
    purgeAfter: null,
    owner: { id: row.ownerId, displayName: ownerName },
    createdBy:
      row.createdBy === null || creatorName === undefined
        ? null
        : { id: row.createdBy, displayName: creatorName },
    role,
    sharing: isOwner ? sharingOf(lookups.sharing.get(row.id)) : { ...NOT_SHARED },
  };
}

/** The two reads of a page: the names of everyone it mentions, and the sharing of what the viewer owns. */
async function lookupsFor(db: Executor, rows: readonly NodeRow[], viewerId: string): Promise<Lookups> {
  const userIds: string[] = [];
  const owned: string[] = [];
  for (const row of rows) {
    userIds.push(row.ownerId);
    if (row.createdBy !== null) userIds.push(row.createdBy);
    if (row.ownerId === viewerId) owned.push(row.id);
  }
  // One after the other: `db` may be a transaction, which has one connection.
  const names = await displayNames(db, userIds);
  const sharing = owned.length > 0 ? await sharingSummary(db, owned) : new Map<string, SharingSummary>();
  return { names, sharing };
}

/** A page of rows as `NodeDto`s, in the order given. */
export async function toNodeDtos<R extends NodeRow>(
  db: Executor,
  rows: readonly R[],
  view: NodeView<R>,
): Promise<NodeDto[]> {
  if (rows.length === 0) return [];
  const lookups = await lookupsFor(db, rows, view.viewerId);
  const { role } = view;
  return rows.map((row) =>
    mapRow(
      row,
      {
        viewerId: view.viewerId,
        role: typeof role === "function" ? role(row) : role,
        isShareRoot: view.shareRootId != null && row.id === view.shareRootId,
      },
      lookups,
    ),
  );
}

export async function toNodeDto<R extends NodeRow>(
  db: Executor,
  row: R,
  view: NodeView<R>,
): Promise<NodeDto> {
  const [dto] = await toNodeDtos(db, [row], view);
  return dto!;
}

/**
 * A page of trashed roots as `TrashItemDto`s, in the order given. Every row must carry
 * `deletedAt` and `purgeAfter` (`trash()` sets them together): a row without is not in the
 * trash, and handing it here throws.
 */
export async function toTrashItemDtos<R extends NodeRow>(
  db: Executor,
  rows: readonly R[],
  view: NodeView<R>,
): Promise<TrashItemDto[]> {
  const stamps = rows.map((row) => {
    if (row.deletedAt === null || row.purgeAfter === null) {
      throw new Error("node-dto: a node that is not in the trash was handed to the trash mapper");
    }
    return { deletedAt: row.deletedAt.toISOString(), purgeAfter: row.purgeAfter.toISOString() };
  });
  const dtos = await toNodeDtos(db, rows, view);
  return dtos.map((dto, index) => ({ ...dto, ...stamps[index]! }));
}

export async function toTrashItemDto<R extends NodeRow>(
  db: Executor,
  row: R,
  view: NodeView<R>,
): Promise<TrashItemDto> {
  const [dto] = await toTrashItemDtos(db, [row], view);
  return dto!;
}

/**
 * A page of search hits as `SearchResultDto`s, in the order given. Each hit carries its own role
 * (T05 `searchNames`); `pathHint` null — a top-level hit, or the root of a share — goes out as `""`,
 * and for anyone but the owner such a hit has `parentId: null` as well.
 */
export async function toSearchResultDtos(
  db: Executor,
  hits: readonly SearchHitRow[],
  view: { viewerId: string },
): Promise<SearchResultDto[]> {
  if (hits.length === 0) return [];
  const lookups = await lookupsFor(
    db,
    hits.map((hit) => hit.node),
    view.viewerId,
  );
  return hits.map((hit) => ({
    // No path hint for a shared hit = the folder above it is not shared with the viewer.
    ...mapRow(
      hit.node,
      { viewerId: view.viewerId, role: hit.role, isShareRoot: hit.pathHint === null },
      lookups,
    ),
    pathHint: hit.pathHint ?? "",
  }));
}
