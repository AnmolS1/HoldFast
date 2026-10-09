// Reading a request body. Routes use these, never `c.req.json()` directly (lint enforces it).
//
// `c.req.json()` throws the parser's own SyntaxError for a body that is not JSON. Left alone it
// is an "unexpected" error: a 500, and an error report for every malformed request anyone sends.
// The error handler cannot tell that SyntaxError from one of the server's own, so the mapping to
// `400 validation` is made here, where the body is read.

import type { Context } from "hono";
import { AppError } from "./errors";
import type { AppEnv } from "./request-context";

/**
 * The request body parsed as JSON — `unknown`: validate it with a zod schema (a ZodError is
 * answered as `400 validation` too). Throws `400 validation` (`details.reason: "malformed_json"`)
 * for an empty body or one that is not JSON.
 */
export async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new AppError("validation", "The request body could not be read.", { reason: "malformed_json" });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("validation", "The request body is not valid JSON.", { reason: "malformed_json" });
  }
}
