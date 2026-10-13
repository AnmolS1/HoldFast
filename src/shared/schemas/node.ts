// Files and folders.

import { z } from "zod";
import { ZIP_MAX_ENTRIES, ZIP_URL_BATCH } from "../constants";
import {
  Bytes,
  ErrorCode,
  MimeCategory,
  NodeId,
  NodeName,
  Page,
  Role,
  ScanReason,
  ScanStatus,
  Sha256,
  Timestamp,
  UserRef,
} from "./common";

/** For a body of optional fields: true when at least one is given. An empty change is refused. */
export const hasAField = (body: Record<string, unknown>): boolean =>
  Object.values(body).some((value) => value !== undefined);
export const NOTHING_TO_CHANGE = { message: "Nothing to change." };

export const NodeKind = z.enum(["file", "folder"]);
export type NodeKind = z.infer<typeof NodeKind>;

/** How a node is shared, as its OWNER sees it. All "none" / 0 for anyone else. */
export const NodeSharing = z.object({
  people: z.number().int().nonnegative(),
  link: z.enum(["none", "active", "paused", "expired"]),
  summary: z.enum(["none", "people", "link", "both"]),
});
export type NodeSharing = z.infer<typeof NodeSharing>;

/**
 * A file or a folder. Never the object key, never an email address.
 * `etag` is the opaque version id: it changes when the content is replaced.
 * `thumb` says whether a thumbnail may be asked for. `deletedAt` / `purgeAfter` are set only in
 * trash listings. `pathHint` is set in search results.
 */
export const NodeDto = z.object({
  id: NodeId,
  parentId: NodeId.nullable(),
  kind: NodeKind,
  name: z.string(),
  ext: z.string(),
  size: Bytes,
  mimeCategory: MimeCategory,
  mimeSniffed: z.string().nullable(),
  etag: z.string(),
  sha256: Sha256.nullable(),
  scanStatus: ScanStatus,
  scanReason: ScanReason.nullable(),
  pua: z.array(z.string()),
  thumb: z.boolean(),
  starred: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastAccessedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  purgeAfter: Timestamp.nullable(),
  owner: UserRef,
  createdBy: UserRef.nullable(),
  role: Role,
  sharing: NodeSharing,
  pathHint: z.string().optional(),
});
export type NodeDto = z.infer<typeof NodeDto>;

/** `GET /api/nodes/:id/children` (and the root listing) → `Page<NodeDto>`. */
export const ListChildrenQuery = z.strictObject({
  sort: z.enum(["name", "size", "updated", "kind"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  kind: NodeKind.optional(),
});
export type ListChildrenQuery = z.infer<typeof ListChildrenQuery>;

export const NodePage = Page(NodeDto);
export type NodePage = z.infer<typeof NodePage>;

export const BreadcrumbDto = z.object({ id: NodeId, name: z.string() });
export type BreadcrumbDto = z.infer<typeof BreadcrumbDto>;

/** `breadcrumbs` stop at the share root for anyone but the owner. */
export const NodeDetailDto = z.object({ node: NodeDto, breadcrumbs: z.array(BreadcrumbDto) });
export type NodeDetailDto = z.infer<typeof NodeDetailDto>;

export const CreateFolderBody = z.strictObject({ parentId: NodeId.nullable(), name: NodeName });
export type CreateFolderBody = z.infer<typeof CreateFolderBody>;

/** At least one of the two. */
export const RenameBody = z
  .strictObject({ name: NodeName.optional(), starred: z.boolean().optional() })
  .refine(hasAField, NOTHING_TO_CHANGE);
export type RenameBody = z.infer<typeof RenameBody>;

export const MoveBody = z.strictObject({ parentId: NodeId.nullable() });
export type MoveBody = z.infer<typeof MoveBody>;

/** The `202` body of `DELETE /api/trash` (`204` when nothing is left). */
export const EmptyTrashResponse = z.object({ remaining: z.number().int().nonnegative() });
export type EmptyTrashResponse = z.infer<typeof EmptyTrashResponse>;

// ── download and thumbnail URLs ─────────────────────────────────────────────────────────────

/** `inline` is granted for media a browser renders and for the PDF and text the viewers fetch. */
export const DownloadUrlBody = z.strictObject({ kind: z.enum(["download", "inline"]) });
export type DownloadUrlBody = z.infer<typeof DownloadUrlBody>;

/** `expiresAt`: refresh an inline URL BEFORE it (a seek in long media is a new request). */
export const DownloadUrlResponse = z.object({
  url: z.string(),
  expiresAt: Timestamp,
  warning: z.literal("unscanned").optional(),
});
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponse>;

export const ThumbUrlResponse = z.object({ url: z.string(), expiresAt: Timestamp });
export type ThumbUrlResponse = z.infer<typeof ThumbUrlResponse>;

// ── zip (signed-in) ─────────────────────────────────────────────────────────────────────────
// The client builds the archive. It asks for a manifest, then mints download URLs LAZILY — a
// window of at most `ZIP_URL_BATCH` files just ahead of the stream, never the whole manifest up
// front. A fetch that still meets an expired token re-mints that one node once.

/**
 * `POST /api/nodes/zip-manifest`. Either a list of 1–100 nodes, or `allOwned: true` — the
 * caller's whole tree ("Download everything") — and then NO list: the two are not combined.
 */
export const ZipManifestBody = z.union([
  z.strictObject({ nodeIds: z.array(NodeId).min(1).max(100), allOwned: z.literal(false).optional() }),
  z.strictObject({ allOwned: z.literal(true) }),
]);
export type ZipManifestBody = z.infer<typeof ZipManifestBody>;

/** `path` is relative and sanitised. */
export const ZipEntry = z.object({
  nodeId: NodeId,
  path: z.string(),
  size: Bytes,
  etag: z.string(),
  modifiedAt: Timestamp,
});
export type ZipEntry = z.infer<typeof ZipEntry>;

/** Why an entry is left out — for the owner and for people it is shared with only. */
export const ZipSkipped = z.object({
  nodeId: NodeId,
  path: z.string(),
  reason: z.enum(["scan_pending", "scan_blocked", "unscanned"]),
});
export type ZipSkipped = z.infer<typeof ZipSkipped>;

/** No URLs. At most `ZIP_MAX_ENTRIES` entries; `truncated` when there were more. */
export const ZipManifest = z.object({
  entries: z.array(ZipEntry).max(ZIP_MAX_ENTRIES),
  totalBytes: Bytes,
  skipped: z.array(ZipSkipped),
  truncated: z.boolean(),
});
export type ZipManifest = z.infer<typeof ZipManifest>;

/** `POST /api/nodes/download-urls`. */
export const BatchDownloadUrlsBody = z.strictObject({ nodeIds: z.array(NodeId).min(1).max(ZIP_URL_BATCH) });
export type BatchDownloadUrlsBody = z.infer<typeof BatchDownloadUrlsBody>;

export const BatchDownloadUrlItem = z.union([
  z.object({ nodeId: NodeId, url: z.string(), expiresAt: Timestamp }),
  z.object({ nodeId: NodeId, error: ErrorCode }),
]);
export type BatchDownloadUrlItem = z.infer<typeof BatchDownloadUrlItem>;

export const BatchDownloadUrlsResponse = z.object({ items: z.array(BatchDownloadUrlItem) });
export type BatchDownloadUrlsResponse = z.infer<typeof BatchDownloadUrlsResponse>;
