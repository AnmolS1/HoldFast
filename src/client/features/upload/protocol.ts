// The requests of an upload. JSON calls go through the shell's API client (re-auth, terms gate,
// envelope parsing); the bodies go through `XMLHttpRequest`, the only way to get upload progress,
// and fail with the same `ApiError`.
import type { ZodType } from "zod";
import { UsageDto } from "../../../shared/schemas/account";
import { NodeId } from "../../../shared/schemas/common";
import { NodeDetailDto, NodeDto, type CreateFolderBody } from "../../../shared/schemas/node";
import {
  CompleteUploadResponse,
  InitUploadResponse,
  OpenUploadsResponse,
  PartResponse,
  SinglePutResponse,
  type CompleteUploadBody,
  type InitUploadBody,
} from "../../../shared/schemas/upload";
import { api, ApiError, apiErrorOf } from "../../lib/api";
import { t } from "./strings";

export function initUpload(body: InitUploadBody, signal?: AbortSignal): Promise<InitUploadResponse> {
  // The daily ceiling is said by the ribbon and the row ("Daily upload limit reached…"): no toast.
  return api("/api/uploads", {
    method: "POST",
    body,
    schema: InitUploadResponse,
    signal,
    silent: ["ceiling_exceeded"],
  });
}

export function completeUpload(
  uploadId: string,
  body: CompleteUploadBody,
  signal?: AbortSignal,
): Promise<CompleteUploadResponse> {
  return api(`/api/uploads/${uploadId}/complete`, {
    method: "POST",
    body,
    schema: CompleteUploadResponse,
    signal,
  });
}

/** Abort the session and release what it reserved. */
export function abortUpload(uploadId: string): Promise<void> {
  return api(`/api/uploads/${uploadId}`, { method: "DELETE" });
}

export function openUploads(signal?: AbortSignal): Promise<OpenUploadsResponse> {
  return api("/api/uploads/open", { schema: OpenUploadsResponse, signal });
}

export function getUsage(signal?: AbortSignal): Promise<UsageDto> {
  return api("/api/account/usage", { schema: UsageDto, signal });
}

/** Only for a well-formed id: the id becomes part of the request path. */
export function getNode(nodeId: string, signal?: AbortSignal): Promise<NodeDetailDto> {
  if (!NodeId.safeParse(nodeId).success) {
    return Promise.reject(new ApiError({ status: 404, code: "not_found", message: t("row.failed") }));
  }
  return api(`/api/nodes/${nodeId}`, { schema: NodeDetailDto, signal });
}

export function createFolder(body: CreateFolderBody, signal?: AbortSignal): Promise<NodeDto> {
  return api("/api/nodes/folder", { method: "POST", body, schema: NodeDto, signal });
}

export interface PutOptions {
  /** Bytes of this body the browser has sent so far. */
  onProgress?(loaded: number): void;
  signal?: AbortSignal;
}

export type PutBody = <T>(path: string, body: Blob, schema: ZodType<T>, options?: PutOptions) => Promise<T>;

function abortError(): DOMException {
  return new DOMException("The upload was stopped.", "AbortError");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The failure of a body request: the ApiError the API client throws for the same answer. */
function errorOf(xhr: XMLHttpRequest): ApiError {
  return apiErrorOf(
    { status: xhr.status, body: xhr.responseText, retryAfter: xhr.getResponseHeader("retry-after") },
    t("row.failed"),
  );
}

/**
 * `PUT` a blob. The browser sets `Content-Length` for a `Blob` body, so the request is never sent
 * chunked (the server refuses a body of unknown length).
 */
export const putBody: PutBody = (path, body, schema, options = {}) =>
  new Promise((resolve, reject) => {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const stop = () => xhr.abort();
    const settle = () => signal?.removeEventListener("abort", stop);
    xhr.open("PUT", path);
    xhr.responseType = "text";
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded);
    xhr.onload = () => {
      settle();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(errorOf(xhr));
        return;
      }
      const parsed = schema.safeParse(parseJson(xhr.responseText));
      if (parsed.success) resolve(parsed.data);
      else reject(new ApiError({ status: xhr.status, code: "invalid_response", message: t("row.failed") }));
    };
    xhr.onerror = xhr.ontimeout = () => {
      settle();
      reject(new ApiError({ status: 0, code: "network", message: t("row.failed") }));
    };
    xhr.onabort = () => {
      settle();
      reject(abortError());
    };
    signal?.addEventListener("abort", stop);
    xhr.send(body);
  });

export function putPart(
  put: PutBody,
  uploadId: string,
  n: number,
  body: Blob,
  options?: PutOptions,
): Promise<PartResponse> {
  return put(`/api/uploads/${uploadId}/parts/${n}`, body, PartResponse, options);
}

export function putSingle(
  put: PutBody,
  uploadId: string,
  body: Blob,
  options?: PutOptions,
): Promise<SinglePutResponse> {
  return put(`/api/uploads/${uploadId}/single`, body, SinglePutResponse, options);
}
