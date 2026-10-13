// Upload sessions.

import { z } from "zod";
import { MAX_PARTS } from "../constants";
import { Bytes, NodeId, NodeName, RowId, Sha256, Timestamp } from "./common";
import { NodeDto } from "./node";

/**
 * `mimeDeclared` is what the browser says the file is: recorded, never served.
 * `fileLastModified` identifies the same local file again when an upload is resumed.
 * `replaceNodeId` goes with `onConflict: "replace"`.
 */
export const InitUploadBody = z.strictObject({
  parentId: NodeId.nullable(),
  name: NodeName,
  size: Bytes,
  mimeDeclared: z.string().max(255),
  fileLastModified: Timestamp,
  onConflict: z.enum(["fail", "rename", "replace"]),
  replaceNodeId: NodeId.optional(),
  purpose: z.enum(["file", "avatar"]),
});
export type InitUploadBody = z.infer<typeof InitUploadBody>;

export const UploadedPart = z.strictObject({
  n: z.number().int().min(1).max(MAX_PARTS),
  etag: z.string().min(1).max(256),
});
export type UploadedPart = z.infer<typeof UploadedPart>;

/** `resumedParts`: parts the server already has. `finalName`: the name after a rename on conflict. */
export const InitUploadResponse = z.object({
  uploadId: RowId,
  mode: z.enum(["single", "multipart"]),
  partBytes: Bytes,
  partCount: z.number().int().min(1).max(MAX_PARTS),
  resumedParts: z.array(UploadedPart),
  finalName: z.string(),
  expiresAt: Timestamp,
});
export type InitUploadResponse = z.infer<typeof InitUploadResponse>;

export const PartResponse = z.object({ n: z.number().int().min(1).max(MAX_PARTS), etag: z.string() });
export type PartResponse = z.infer<typeof PartResponse>;

/** `PUT /api/uploads/:id/single` — the whole file in one request, for a session of mode `single`. */
export const SinglePutResponse = z.object({ etag: z.string() });
export type SinglePutResponse = z.infer<typeof SinglePutResponse>;

/** `sha256` is of the whole file, computed by the client. Answered with the new `NodeDto`. */
export const CompleteUploadBody = z.strictObject({
  sha256: Sha256,
  parts: z.array(UploadedPart).max(MAX_PARTS),
});
export type CompleteUploadBody = z.infer<typeof CompleteUploadBody>;

export const CompleteUploadResponse = NodeDto;
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;

export const UploadSessionDto = z.object({
  uploadId: RowId,
  parentId: NodeId.nullable(),
  name: z.string(),
  size: Bytes,
  partBytes: Bytes,
  partCount: z.number().int().min(1),
  uploadedParts: z.number().int().nonnegative(),
  fileLastModified: Timestamp.nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
export type UploadSessionDto = z.infer<typeof UploadSessionDto>;

/** `GET /api/uploads/open` → the caller's own open sessions, as a bare array (for resume matching). */
export const OpenUploadsResponse = z.array(UploadSessionDto);
export type OpenUploadsResponse = z.infer<typeof OpenUploadsResponse>;
