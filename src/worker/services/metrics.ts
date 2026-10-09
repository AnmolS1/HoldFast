// Metrics → Analytics Engine (`env.METRICS`). One fixed positional layout, so no later task
// edits this file and every query can rely on the columns:
//
//   indexes: [name]
//   blobs:   [name, outcome, kind, reason, route, SENTRY_ENVIRONMENT]
//   doubles: [value, ms]
//
// Tag values are short enums. Never an id, an email, a token, a file name or a URL.
// `metric()` never throws: a missing binding or a failed write is swallowed.

import { env as workerEnv } from "cloudflare:workers";

export type MetricName =
  | "request"
  | "auth"
  | "upload"
  | "download"
  | "thumb"
  | "link"
  | "share"
  | "scan"
  | "email"
  | "ceiling"
  | "report"
  | "job"
  | "csp"
  | "error";

export type MetricTags = {
  outcome?: string;
  kind?: string;
  reason?: string;
  /** A route PATTERN (`/api/nodes/:id`), never a concrete path. */
  route?: string;
  ms?: number;
};

type MetricEnv = { METRICS?: AnalyticsEngineDataset; SENTRY_ENVIRONMENT?: string };

const MAX_TAG = 96;
const tag = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_TAG) : "");

/** The write itself, against an explicit env. `metric()` is this with the Worker's own env. */
export function writeMetric(
  env: MetricEnv | undefined,
  name: MetricName,
  tags: MetricTags = {},
  value = 1,
): void {
  try {
    const ms = typeof tags.ms === "number" && Number.isFinite(tags.ms) ? tags.ms : 0;
    env?.METRICS?.writeDataPoint({
      indexes: [name],
      blobs: [
        name,
        tag(tags.outcome),
        tag(tags.kind),
        tag(tags.reason),
        tag(tags.route),
        tag(env.SENTRY_ENVIRONMENT),
      ],
      doubles: [Number.isFinite(value) ? value : 0, ms],
    });
  } catch {
    // Metrics must never break a request.
  }
}

/** Record one data point. Callable from routes, services, the queue consumer and cron jobs. */
export function metric(name: MetricName, tags: MetricTags = {}, value = 1): void {
  let env: MetricEnv | undefined;
  try {
    env = workerEnv;
  } catch {
    env = undefined;
  }
  writeMetric(env, name, tags, value);
}
