// The avatar upload, on T12's path: `POST /api/uploads` with `purpose: "avatar"`, the bytes in one
// `PUT …/single`, then `complete` — which answers the avatar node at once (its scan is synchronous).
// The uploader feature exposes no avatar call of its own and features import nothing of each other
// beyond the slots, so the three requests are made here, through `api()`.
//
// Outcomes: "ok" — the picture is the avatar now; "not_image" — the server's image service did not
// take it ("An avatar is an image."); "unchecked" — the scanner could not check it: either the
// complete failed (`5xx`, no scanner at all) or it answered a node that is not clean (stored with
// its verdict, never made the avatar) — ONE message for both; "too_large"; "failed" otherwise.
import { AVATAR_MAX_BYTES } from "../../../shared/constants";
import { NodeDto } from "../../../shared/schemas/node";
import { InitUploadResponse, SinglePutResponse } from "../../../shared/schemas/upload";
import { api, ApiError } from "../../lib/api";

export type AvatarOutcome = "ok" | "not_image" | "unchecked" | "too_large" | "failed";

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Uploads `file` as the avatar. Never throws. `signal`: the page went away. */
export async function uploadAvatar(file: File, signal?: AbortSignal): Promise<AvatarOutcome> {
  if (file.size > AVATAR_MAX_BYTES) return "too_large";
  if (!file.type.toLowerCase().startsWith("image/")) return "not_image";
  const silent = ["validation", "file_too_large"] as const;
  try {
    const started = await api("/api/uploads", {
      method: "POST",
      body: {
        parentId: null,
        name: file.name || "avatar",
        size: file.size,
        mimeDeclared: file.type,
        fileLastModified: new Date(file.lastModified || Date.now()).toISOString(),
        onConflict: "fail",
        purpose: "avatar",
      },
      schema: InitUploadResponse,
      signal,
      silent,
    });
    const sha256 = await sha256Hex(file);
    await api(`/api/uploads/${started.uploadId}/single`, {
      method: "PUT",
      body: file,
      headers: { "content-type": "application/octet-stream" },
      schema: SinglePutResponse,
      signal,
      silent,
    });
    let node: NodeDto;
    try {
      node = await api(`/api/uploads/${started.uploadId}/complete`, {
        method: "POST",
        body: { sha256, parts: [] },
        schema: NodeDto,
        signal,
        silent: [...silent, "internal", "http_error"],
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "validation") return "not_image";
      if (cause instanceof ApiError && (cause.status >= 500 || cause.status === 0)) return "unchecked";
      throw cause;
    }
    return node.scanStatus === "clean" ? "ok" : "unchecked";
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "file_too_large") return "too_large";
    if (cause instanceof ApiError && cause.code === "validation") return "not_image";
    return "failed";
  }
}
