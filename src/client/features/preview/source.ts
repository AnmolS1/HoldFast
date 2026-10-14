// The two places a preview gets its metadata and URLs from: the authenticated API ("owner"), or
// whatever a public page hands in. Every renderer goes through these three functions, so with a
// public source no authenticated endpoint is ever touched.
import {
  DownloadUrlResponse,
  NodeDetailDto,
  NodePage,
  ThumbUrlResponse,
  type DownloadUrlBody,
  type NodeDto,
} from "../../../shared/schemas/node";
import type { PreviewItem, PublicPreviewSource } from "../../components/slots";
import type { ScanStatus } from "../../components/types";
import { api } from "../../lib/api";
import type { ViewScope } from "./scope";

export type PreviewSource = "owner" | PublicPreviewSource;

/** What the dialog shows: the public item's fields, plus what only a node says. */
export interface LoadedItem extends PreviewItem {
  /** Absent in the source = `clean`. */
  scanStatus: ScanStatus;
  scanReason: string | null;
  /** Absent in the source = `false`. */
  thumb: boolean;
  /** Cache key for thumbnails: the node's etag, or the id when the source has none. */
  versionKey: string;
  /** Owner source only. */
  node: NodeDto | null;
}

export type UrlKind = "inline" | "thumb" | "download";

export interface MintedUrl {
  url: string;
  expiresAt: string;
}

const nodePath = (nodeId: string) => `/api/nodes/${encodeURIComponent(nodeId)}`;

export async function loadItem(
  source: PreviewSource,
  nodeId: string,
  signal?: AbortSignal,
): Promise<LoadedItem> {
  if (source === "owner") {
    const { node } = await api(nodePath(nodeId), { schema: NodeDetailDto, signal });
    return {
      id: node.id,
      name: node.name,
      size: node.size,
      mimeCategory: node.mimeCategory,
      ext: node.ext,
      mimeSniffed: node.mimeSniffed,
      scanStatus: node.scanStatus,
      scanReason: node.scanReason,
      thumb: node.thumb,
      versionKey: node.etag,
      node,
    };
  }
  const item = await source.getItem(nodeId);
  return {
    ...item,
    scanStatus: item.scanStatus ?? "clean",
    scanReason: null,
    thumb: item.thumb === true,
    versionKey: item.id,
    node: null,
  };
}

/**
 * Mint a short-lived files-host URL. The URL is a bearer token: callers keep it in component
 * state only and never log it. A public source has no `download` kind (its page owns Download).
 */
export async function mintUrl(
  source: PreviewSource,
  nodeId: string,
  kind: UrlKind,
  size?: number,
): Promise<MintedUrl> {
  if (source === "owner") {
    if (kind === "thumb") {
      return api(`${nodePath(nodeId)}/thumb-url?size=${size ?? 320}`, { schema: ThumbUrlResponse });
    }
    return api(`${nodePath(nodeId)}/download-url`, {
      method: "POST",
      body: { kind } satisfies DownloadUrlBody,
      schema: DownloadUrlResponse,
    });
  }
  if (kind === "download") throw new Error("a public preview source mints no download URL");
  return source.getUrl(nodeId, kind, size);
}

/** At most this many files are walked by prev/next on a cold link. */
export const SIBLING_LIMIT = 1000;
const SIBLING_PAGE = 200;

/** The files next to a node, in the folder's default order — for prev/next on a cold link. */
export async function listSiblingIds(
  parentId: string | null,
  scope: Pick<ViewScope, "signal" | "alive">,
): Promise<string[]> {
  const base = parentId === null ? "/api/nodes/root" : `${nodePath(parentId)}/children`;
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    // The next page is asked for only while the view that wanted the list is still there (its
    // scope ends with the view and with the account — the account already when the purge starts,
    // before the purger has aborted the signal).
    if (!scope.alive()) return [];
    const query = new URLSearchParams({ kind: "file", limit: String(SIBLING_PAGE) });
    if (cursor) query.set("cursor", cursor);
    const page: NodePage = await api(`${base}?${query.toString()}`, {
      schema: NodePage,
      signal: scope.signal,
    });
    for (const node of page.items) ids.push(node.id);
    cursor = page.nextCursor;
    pages += 1;
    // Bounded by pages as well as by ids: a run of empty pages that each carry a cursor ends.
  } while (cursor && ids.length < SIBLING_LIMIT && pages < SIBLING_LIMIT / SIBLING_PAGE);
  return ids;
}
