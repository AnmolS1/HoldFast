// Reading a request body. Routes use these, never `c.req.json()` directly (lint enforces it).
//
// `c.req.json()` throws the parser's own SyntaxError for a body that is not JSON. Left alone it
// is an "unexpected" error: a 500, and an error report for every malformed request anyone sends.
// The error handler cannot tell that SyntaxError from one of the server's own, so the mapping to
// `400 validation` is made here, where the body is read.
//
// A body is read up to a byte cap (R1 secweb-1): a declared `Content-Length` over it is refused
// unread, and the stream is counted as it is read, so no sender decides how much memory a request
// costs. The precedent is auth/preflight.ts `readBody`.

import type { Context } from "hono";
import { AppError } from "./errors";
import type { AppEnv } from "./request-context";

/** The byte cap of a JSON body, unless the route asks for another. Every anonymous route fits it. */
export const JSON_BODY_MAX_BYTES = 64 * 1024;
/** `POST /api/uploads/:id/complete`: up to `MAX_PARTS` (10,000) parts of about 50 bytes each. */
export const UPLOAD_COMPLETE_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** Admin DMCA notice and counter-notice: 200,000 + 2 × 20,000 characters of text at most. */
export const DMCA_NOTICE_BODY_MAX_BYTES = 1024 * 1024;

const tooLarge = (maxBytes: number) => new AppError("body_too_large", undefined, { maxBytes });

/** The body's bytes as text — or `body_too_large` past `maxBytes`, with the rest left unread. */
async function readCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw tooLarge(maxBytes);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The request body parsed as JSON — `unknown`: validate it with a zod schema (a ZodError is
 * answered as `400 validation` too). Throws `413 body_too_large` (`details.maxBytes`) for a body
 * over `maxBytes`, and `400 validation` (`details.reason: "malformed_json"`) for an empty body or
 * one that is not JSON.
 */
export async function jsonBody(c: Context<AppEnv>, maxBytes: number = JSON_BODY_MAX_BYTES): Promise<unknown> {
  let text: string;
  try {
    text = await readCapped(c.req.raw, maxBytes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("validation", "The request body could not be read.", { reason: "malformed_json" });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("validation", "The request body is not valid JSON.", { reason: "malformed_json" });
  }
}
