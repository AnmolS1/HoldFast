// Answers of the upload API, for the uploader's unit tests and its mocked e2e spec. Every builder
// parses what it returns with the contract's own schema, so a fixture cannot drift from it.
// No DOM and no Node API here: the module is loaded by jsdom tests and by Playwright alike.
import { UsageDto } from "../../../../../src/shared/schemas/account";
import { NodeDetailDto, NodeDto } from "../../../../../src/shared/schemas/node";
import {
  InitUploadResponse,
  OpenUploadsResponse,
  PartResponse,
  SinglePutResponse,
  UploadSessionDto,
} from "../../../../../src/shared/schemas/upload";

/** `mockShell`'s and the unit helpers' signed-in user ("a" × 32). */
export const USER_ID = "a".repeat(32);
export const OTHER_USER_ID = "b".repeat(32);

export const AT = "2026-10-13T09:00:00.000Z";
/**
 * When a stand-in session ends: far ahead, never a date the calendar reaches. (It was a day after
 * `AT`, and once that day had passed every restored row was dropped as expired.) A test about
 * expiry sets its own time relative to now.
 */
export const EXPIRES = "2099-01-01T00:00:00.000Z";
export const FOLDER_ID = "0199d3c2-7a10-7000-8000-0000000000f1";
export const SUBFOLDER_ID = "0199d3c2-7a10-7000-8000-0000000000f2";
export const EXISTING_ID = "0199d3c2-7a10-7000-8000-0000000000e1";
export const SHA_OF_NOTHING = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A row id of ours, different for every `index`. */
export function rowId(index: number): string {
  return `0199d3c2-7a10-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function nodeDto(patch: Partial<NodeDto> = {}): NodeDto {
  const name = patch.name ?? "notes.txt";
  return NodeDto.parse({
    id: rowId(0xa1),
    parentId: null,
    kind: "file",
    name,
    ext: extOf(name),
    size: 1024,
    mimeCategory: "document",
    mimeSniffed: "text/plain",
    etag: "v1",
    sha256: null,
    scanStatus: "pending",
    scanReason: null,
    pua: [],
    thumb: false,
    starred: false,
    createdAt: AT,
    updatedAt: AT,
    lastAccessedAt: null,
    deletedAt: null,
    purgeAfter: null,
    owner: { id: USER_ID, displayName: "Ada Lovelace" },
    createdBy: { id: USER_ID, displayName: "Ada Lovelace" },
    role: "owner",
    sharing: { people: 0, link: "none", summary: "none" },
    ...patch,
  });
}

export function folderDto(patch: Partial<NodeDto> = {}): NodeDto {
  return nodeDto({
    id: FOLDER_ID,
    kind: "folder",
    name: "Projects",
    size: 0,
    mimeCategory: "other",
    mimeSniffed: null,
    scanStatus: "clean",
    ...patch,
  });
}

/** `GET /api/nodes/:id`: the node sits under `node` — the scan state is `.node.scanStatus`. */
export function nodeDetail(patch: Partial<NodeDto> = {}): NodeDetailDto {
  return NodeDetailDto.parse({ node: nodeDto(patch), breadcrumbs: [] });
}

export function usageDto(patch: Partial<UsageDto> = {}): UsageDto {
  return UsageDto.parse({
    usedBytes: 1_000_000_000,
    quotaBytes: 5_000_000_000,
    filesBytes: 1_000_000_000,
    trashBytes: 0,
    versionsBytes: 0,
    reservedBytes: 0,
    ...patch,
  });
}

/**
 * `POST /api/uploads`. The mode, the part size and the part count are the SERVER's: these tests
 * hand out sizes no client would compute, to show the client only follows.
 */
export function initResponse(
  size: number,
  patch: Partial<InitUploadResponse> & { partBytes?: number } = {},
): InitUploadResponse {
  const partBytes = patch.partBytes ?? 67_108_864;
  const multipart = size > partBytes;
  return InitUploadResponse.parse({
    uploadId: rowId(0xb1),
    mode: multipart ? "multipart" : "single",
    partBytes,
    partCount: multipart ? Math.ceil(size / partBytes) : 1,
    resumedParts: [],
    finalName: "notes.txt",
    expiresAt: EXPIRES,
    ...patch,
  });
}

export function partResponse(n: number): PartResponse {
  return PartResponse.parse({ n, etag: `etag-${n}` });
}

export function singleResponse(): SinglePutResponse {
  return SinglePutResponse.parse({ etag: "etag-single" });
}

export function uploadSession(patch: Partial<UploadSessionDto> = {}): UploadSessionDto {
  return UploadSessionDto.parse({
    uploadId: rowId(0xb1),
    parentId: null,
    name: "notes.txt",
    size: 1024,
    partBytes: 67_108_864,
    partCount: 1,
    uploadedParts: 0,
    fileLastModified: AT,
    createdAt: AT,
    expiresAt: EXPIRES,
    ...patch,
  });
}

export function openUploadsResponse(sessions: UploadSessionDto[] = []): OpenUploadsResponse {
  return OpenUploadsResponse.parse(sessions);
}

/** The app host's error body. */
export function errorBody(error: string, message: string, details?: Record<string, unknown>) {
  return { error, message, requestId: "req-upload", ...(details ? { details } : {}) };
}
