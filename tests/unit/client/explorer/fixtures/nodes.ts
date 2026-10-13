// Contract-shaped fixtures of the explorer's tests (jsdom and Playwright). Every builder parses
// what it returns with the schema from src/shared, so a fixture cannot drift from the contract.
import {
  BatchDownloadUrlsResponse,
  NodeDetailDto,
  NodeDto,
  NodePage,
  TrashNodeResponse,
  ZipManifest,
  type BreadcrumbDto,
} from "../../../../../src/shared/schemas/node";

export const AT = "2026-10-02T12:00:00.000Z";
/** A made-up account; the id has the auth library's shape (32 alphanumerics). */
export const OWNER = { id: "a".repeat(32), displayName: "Ada Lovelace" };
export const OTHER = { id: "b".repeat(32), displayName: "Grace Hopper" };

/** A deterministic node id: a well-formed UUID v7 ending in `n`. */
export function nodeId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

const base = {
  parentId: null,
  ext: "",
  size: 0,
  mimeCategory: "other",
  mimeSniffed: null,
  etag: "v1",
  sha256: null,
  scanStatus: "clean",
  scanReason: null,
  pua: [],
  thumb: false,
  starred: false,
  createdAt: AT,
  updatedAt: AT,
  lastAccessedAt: null,
  deletedAt: null,
  purgeAfter: null,
  owner: OWNER,
  createdBy: OWNER,
  role: "owner",
  sharing: { people: 0, link: "none", summary: "none" },
} as const;

export function fileNode(n: number, patch: Partial<NodeDto> = {}): NodeDto {
  const name = patch.name ?? `file-${n}.pdf`;
  const dot = name.lastIndexOf(".");
  return NodeDto.parse({
    ...base,
    id: nodeId(n),
    kind: "file",
    name,
    ext: dot > 0 ? name.slice(dot + 1) : "",
    size: 1000 * n,
    mimeCategory: "pdf",
    mimeSniffed: "application/pdf",
    // While a scan is pending the API shows no hash (the scanner has not computed it yet).
    sha256: patch.scanStatus === "pending" ? null : n.toString(16).padStart(64, "0"),
    ...patch,
  });
}

export function folderNode(n: number, patch: Partial<NodeDto> = {}): NodeDto {
  return NodeDto.parse({ ...base, id: nodeId(n), kind: "folder", name: `Folder ${n}`, ...patch });
}

export function pageOf(items: NodeDto[], nextCursor: string | null = null): NodePage {
  return NodePage.parse({ items, nextCursor });
}

export function detailOf(node: NodeDto, breadcrumbs: BreadcrumbDto[] = []): NodeDetailDto {
  return NodeDetailDto.parse({ node, breadcrumbs });
}

export function trashedOf(node: NodeDto): TrashNodeResponse {
  return TrashNodeResponse.parse({ ...node, deletedAt: AT, purgeAfter: "2026-11-01T12:00:00.000Z" });
}

export function manifestOf(
  entries: Array<{ node: NodeDto; path?: string }>,
  skipped: ZipManifest["skipped"] = [],
  truncated = false,
): ZipManifest {
  return ZipManifest.parse({
    entries: entries.map(({ node, path }) => ({
      nodeId: node.id,
      path: path ?? node.name,
      size: node.size,
      etag: node.etag,
      modifiedAt: node.updatedAt,
    })),
    totalBytes: entries.reduce((sum, { node }) => sum + node.size, 0),
    skipped,
    truncated,
  });
}

export function urlsOf(items: BatchDownloadUrlsResponse["items"]): BatchDownloadUrlsResponse {
  return BatchDownloadUrlsResponse.parse({ items });
}

/** `count` items for a long folder: two folders first, then files. */
export function manyNodes(count: number, parentId: string | null = null): NodeDto[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return n <= 2
      ? folderNode(n, { parentId, name: `Folder ${String(n).padStart(4, "0")}` })
      : fileNode(n, { parentId, name: `file-${String(n).padStart(4, "0")}.pdf` });
  });
}
