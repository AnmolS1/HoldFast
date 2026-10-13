// Every request the explorer makes, each parsed with its contract schema. Nothing here is typed
// by hand: a shape the API does not answer is an `invalid_response` error, not a silent mismatch.
import {
  BatchDownloadUrlsResponse,
  DownloadUrlResponse,
  NodeDetailDto,
  NodeDto,
  NodePage,
  RestoreNodeResponse,
  ThumbUrlResponse,
  TrashNodeResponse,
  ZipManifest,
  type BatchDownloadUrlsBody,
  type CreateFolderBody,
  type DownloadUrlBody,
  type MoveBody,
  type RenameBody,
  type ZipManifestBody,
} from "../../../shared/schemas/node";
import { api, ApiError } from "../../lib/api";

export type SortKey = "name" | "size" | "updated" | "kind";
export type SortDir = "asc" | "desc";

export interface ListOptions {
  sort: SortKey;
  dir: SortDir;
  cursor?: string;
  kind?: "file" | "folder";
  signal?: AbortSignal;
}

/** The largest page the contract allows: fewer round trips in a long folder. */
export const PAGE_LIMIT = 200;

const node = (id: string) => `/api/nodes/${encodeURIComponent(id)}`;

/** `null` is the caller's own top level. */
export function listChildren(folderId: string | null, options: ListOptions): Promise<NodePage> {
  const query = new URLSearchParams({ sort: options.sort, dir: options.dir, limit: String(PAGE_LIMIT) });
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.kind) query.set("kind", options.kind);
  const path = folderId === null ? "/api/nodes/root" : `${node(folderId)}/children`;
  return api(`${path}?${query.toString()}`, { schema: NodePage, signal: options.signal });
}

export function getNode(id: string, signal?: AbortSignal): Promise<NodeDetailDto> {
  return api(node(id), { schema: NodeDetailDto, signal });
}

export function createFolder(body: CreateFolderBody): Promise<NodeDto> {
  return api("/api/nodes/folder", { method: "POST", body, schema: NodeDto });
}

export function patchNode(id: string, body: RenameBody): Promise<NodeDto> {
  return api(node(id), { method: "PATCH", body, schema: NodeDto });
}

export function moveNode(id: string, body: MoveBody): Promise<NodeDto> {
  return api(`${node(id)}/move`, { method: "POST", body, schema: NodeDto });
}

export function trashNode(id: string): Promise<TrashNodeResponse> {
  return api(`${node(id)}/trash`, { method: "POST", schema: TrashNodeResponse });
}

export function restoreNode(id: string): Promise<RestoreNodeResponse> {
  return api(`${node(id)}/restore`, { method: "POST", schema: RestoreNodeResponse });
}

export function downloadUrl(id: string, kind: DownloadUrlBody["kind"] = "download") {
  const body: DownloadUrlBody = { kind };
  return api(`${node(id)}/download-url`, { method: "POST", body, schema: DownloadUrlResponse });
}

export function thumbUrl(id: string, size: number): Promise<ThumbUrlResponse> {
  return api(`${node(id)}/thumb-url?size=${size}`, { schema: ThumbUrlResponse });
}

/** `202` with no body: an empty answer to an accepted request is the success case. */
export async function rescanNode(id: string): Promise<void> {
  try {
    await api(`${node(id)}/rescan`, { method: "POST" });
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "invalid_response" && cause.status === 202) return;
    throw cause;
  }
}

export function zipManifest(body: ZipManifestBody, signal?: AbortSignal): Promise<ZipManifest> {
  return api("/api/nodes/zip-manifest", { method: "POST", body, schema: ZipManifest, signal });
}

export function batchDownloadUrls(
  body: BatchDownloadUrlsBody,
  signal?: AbortSignal,
): Promise<BatchDownloadUrlsResponse> {
  return api("/api/nodes/download-urls", {
    method: "POST",
    body,
    schema: BatchDownloadUrlsResponse,
    signal,
  });
}
