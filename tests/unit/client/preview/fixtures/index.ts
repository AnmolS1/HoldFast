// Fixtures of the preview tests (unit and e2e). Every object is parsed by the contract's own
// schema here, so a fixture cannot drift from the API's shape.
import {
  DownloadUrlResponse,
  NodeDetailDto,
  NodeDto,
  NodePage,
  ThumbUrlResponse,
} from "../../../../../src/shared/schemas/node";

/** Where the mocked files host lives in unit tests. */
export const FILES_ORIGIN = "http://files.localhost:3000";

/** UUID v7-shaped ids, made up. */
export const ID = {
  folder: "01920000-0000-7000-8000-0000000000f0",
  png: "01920000-0000-7000-8000-000000000001",
  pdf: "01920000-0000-7000-8000-000000000002",
  ts: "01920000-0000-7000-8000-000000000003",
  mp4: "01920000-0000-7000-8000-000000000004",
  svg: "01920000-0000-7000-8000-000000000005",
  html: "01920000-0000-7000-8000-000000000006",
  heic: "01920000-0000-7000-8000-000000000007",
  m4a: "01920000-0000-7000-8000-000000000008",
  other: "01920000-0000-7000-8000-000000000009",
} as const;

const OWNER = { id: "a".repeat(32), displayName: "Ada Lovelace" };

const BASE: NodeDto = NodeDto.parse({
  id: ID.png,
  parentId: ID.folder,
  kind: "file",
  name: "sample.png",
  ext: "png",
  size: 6464,
  mimeCategory: "image",
  mimeSniffed: "image/png",
  etag: "etag-1",
  sha256: null,
  scanStatus: "clean",
  scanReason: null,
  pua: [],
  thumb: true,
  starred: false,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  lastAccessedAt: null,
  deletedAt: null,
  purgeAfter: null,
  owner: OWNER,
  createdBy: OWNER,
  role: "owner",
  sharing: { people: 0, link: "none", summary: "none" },
});

/** A file node; `patch` changes fields. */
export function nodeOf(patch: Partial<NodeDto> = {}): NodeDto {
  return NodeDto.parse({ ...BASE, ...patch });
}

/** `GET /api/nodes/:id`. */
export function detailOf(node: NodeDto): NodeDetailDto {
  return NodeDetailDto.parse({
    node,
    breadcrumbs: node.parentId ? [{ id: node.parentId, name: "Photos" }] : [],
  });
}

export function pageOf(nodes: NodeDto[], nextCursor: string | null = null): NodePage {
  return NodePage.parse({ items: nodes, nextCursor });
}

export const NODES = {
  png: nodeOf(),
  pdf: nodeOf({
    id: ID.pdf,
    name: "three-pages.pdf",
    ext: "pdf",
    size: 1367,
    mimeCategory: "pdf",
    mimeSniffed: "application/pdf",
    thumb: false,
  }),
  ts: nodeOf({
    id: ID.ts,
    name: "sample.ts",
    ext: "ts",
    size: 234,
    mimeCategory: "code",
    mimeSniffed: "text/plain",
    thumb: false,
  }),
  mp4: nodeOf({
    id: ID.mp4,
    name: "sample.mp4",
    ext: "mp4",
    size: 56221,
    mimeCategory: "video",
    mimeSniffed: "video/mp4",
    thumb: false,
  }),
  m4a: nodeOf({
    id: ID.m4a,
    name: "voice.m4a",
    ext: "m4a",
    size: 40000,
    mimeCategory: "audio",
    mimeSniffed: "audio/x-m4a",
    thumb: false,
  }),
  svg: nodeOf({
    id: ID.svg,
    name: "sample.svg",
    ext: "svg",
    size: 193,
    mimeCategory: "image",
    mimeSniffed: "image/svg+xml",
    thumb: false,
  }),
  html: nodeOf({
    id: ID.html,
    name: "sample.html",
    ext: "html",
    size: 130,
    mimeCategory: "code",
    mimeSniffed: "text/html",
    thumb: false,
  }),
  heic: nodeOf({
    id: ID.heic,
    name: "IMG_0042.HEIC",
    ext: "heic",
    size: 13_700_000,
    mimeCategory: "image",
    mimeSniffed: "image/heic",
    thumb: true,
  }),
} as const;

/** The files-host URL a mint answers: `/i/` inline, `/d/` download, `/t/…/<size>/` thumbnail. */
export function filesUrl(kind: "inline" | "download" | "thumb", nodeId: string, token: string, size = 320) {
  if (kind === "thumb") return `${FILES_ORIGIN}/t/${nodeId}/${size}/${token}`;
  return `${FILES_ORIGIN}/${kind === "inline" ? "i" : "d"}/${nodeId}/${token}`;
}

/** `POST /api/nodes/:id/download-url`. `now` is the clock the test runs on. */
export function downloadUrlOf(url: string, now: number, lifetimeSec: number): DownloadUrlResponse {
  return DownloadUrlResponse.parse({ url, expiresAt: new Date(now + lifetimeSec * 1000).toISOString() });
}

/** `GET /api/nodes/:id/thumb-url`. */
export function thumbUrlOf(url: string, now: number, lifetimeSec = 600): ThumbUrlResponse {
  return ThumbUrlResponse.parse({ url, expiresAt: new Date(now + lifetimeSec * 1000).toISOString() });
}
