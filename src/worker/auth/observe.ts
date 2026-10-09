// THE exits from the auth layer to anything that is kept: Sentry, the metrics dataset, the audit
// log. (The fourth, the Worker's log, is ./logger.ts — the only file here that names `console`.)
//
// Nothing else in the auth layer imports `../sentry`, `../services/metrics` or `../services/audit`
// — a unit test scans the sources for it (tests/unit/auth/observability.test.ts), and each
// function below reduces what it is given before it passes it on:
//
//   reportError   an error            → `safeError`: its class, its code, its scanned message, its
//                                       stack frames. Never the object itself, its `cause`, its
//                                       `response` / `request` / `config`, or any other field.
//                 tags                → `safeTag` each
//   count / countFor  metric tags     → `safeTag` each (a constant, a template name, a status,
//                                       an error code — or "other")
//   record        audit meta          → flat; a string is scanned as free text, a number or a
//                                       boolean is kept, anything else is dropped
//   guard         a route handler     → an error that is not an AppError is reported here, as
//                                       above, and answered with the 500 envelope; it never
//                                       reaches the app's error handler as the raw object
//
// A URL never goes to any of them. Where a request's path is recorded (a refused admin-plugin
// call), it is `sinkPath`: the pathname alone — no query at all — scanned.

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { INTERNAL_ERROR } from "../../shared/errors";
import { QueryError } from "../db/errors";
import { captureError } from "../sentry";
import { audit, type AuditOptions, type AuditTarget } from "../services/audit";
import { AppError } from "../services/errors";
import { metric, writeMetric, type MetricName, type MetricTags } from "../services/metrics";
import type { AppEnv, ServiceDeps } from "../services/request-context";
import { safeError, scrubText } from "./redact";

const TAG = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,95}$/;

/** A tag value: kept when it reads as an identifier and a scan leaves it alone, else "other". */
export function safeTag(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || value === "") return "";
  return TAG.test(value) && scrubText(value) === value ? value : "other";
}

function safeTags<T extends Record<string, unknown>>(tags: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    out[key] = safeTag(value);
  }
  return out;
}

/** An error to Sentry: a sanitised copy, never the object that was caught. Never throws. */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  try {
    captureError(safeError(error), safeTags(tags));
  } catch {
    // Reporting must never break the thing being reported on.
  }
}

function metricTags(tags: MetricTags): MetricTags {
  const { ms, ...rest } = tags;
  const safe: MetricTags = safeTags(rest);
  if (typeof ms === "number" && Number.isFinite(ms)) safe.ms = ms;
  return safe;
}

/** One data point, with the Worker's own env. */
export function count(name: MetricName, tags: MetricTags = {}): void {
  metric(name, metricTags(tags));
}

/** One data point, against an explicit env (code that also runs outside a request). */
export function countFor(
  env: Parameters<typeof writeMetric>[0],
  name: MetricName,
  tags: MetricTags = {},
): void {
  writeMetric(env, name, metricTags(tags));
}

/** Audit meta as it may be stored: flat, strings scanned, nothing nested. */
export function safeMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") out[key] = scrubText(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

/** One audit row. The action and the target are ours (constants and ids); the meta is reduced. */
export function record(
  source: Context<AppEnv> | ServiceDeps,
  action: string,
  target: AuditTarget,
  meta: Record<string, unknown> | null = null,
  options: AuditOptions = {},
): void {
  audit(source, action, target, safeMeta(meta), options);
}

/**
 * The path of a request, for a sink: the pathname alone — the query is dropped whole, whatever
 * is in it — with token-bearing segments replaced and the rest scanned. Capped.
 */
export function sinkPath(urlOrPath: string): string {
  let pathname = urlOrPath;
  try {
    pathname = new URL(urlOrPath, "http://x").pathname;
  } catch {
    pathname = urlOrPath.split(/[?#]/)[0] ?? "";
  }
  return scrubText(pathname).slice(0, 200);
}

/**
 * The errors the app's error handler turns into an ANSWER (a 4xx with our envelope) without
 * reporting them — the same four classes as `asAppError` in services/errors.ts. They carry what
 * our own code put in them (a code, a reason, a field path), and they are not faults.
 */
export function isAnswer(error: unknown): boolean {
  return (
    error instanceof AppError ||
    error instanceof QueryError ||
    error instanceof ZodError ||
    error instanceof HTTPException
  );
}

/**
 * Wraps a route handler of the auth layer. An answer (see `isAnswer`) passes. Anything else — a database error, a failure inside a library — is reported here as
 * a sanitised copy and answered with the 500 envelope: the caught object is never rethrown, so
 * the app's error handler never sees it.
 */
export function guard<C extends Context<AppEnv>>(
  kind: string,
  handler: (c: C) => Response | Promise<Response>,
): (c: C) => Promise<Response> {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      if (isAnswer(error)) throw error;
      reportError(error, { kind });
      count("error", { kind: "auth_route", reason: kind });
      let requestId = "";
      try {
        requestId = c.get("requestId") ?? "";
      } catch {
        requestId = "";
      }
      return c.json({ error: INTERNAL_ERROR, message: "Something went wrong.", requestId }, 500);
    }
  };
}
