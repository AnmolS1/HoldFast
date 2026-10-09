// Sentry for the Worker (`@sentry/cloudflare`). The DSN is the secret `SENTRY_DSN`; with no DSN
// the SDK is not initialised and every capture is a no-op (local dev, unit tests).
//
// Everything that leaves goes through `redactEvent` first — events, transactions and
// breadcrumbs — so download tokens, link tokens, invite codes, cookies and email addresses never
// reach Sentry. The wiring of `beforeSend` / `beforeBreadcrumb` to src/shared/sentry-redact.ts
// must survive any later change to this file.
//
// THE RULE: redaction that counts happens LAST. `beforeSend`, `beforeSendTransaction` and
// `beforeBreadcrumb` hand the fully assembled item to src/shared/sentry-redact.ts, which scans
// every string of it whatever field it is in. By then the SDK has copied one value into several
// fields (an error's message, the request URL, a breadcrumb, the transaction name), so redacting
// any one representation earlier cannot be what keeps a secret in.
//
// FAIL CLOSED: when an item cannot be redacted (the redactor threw, or the item is past its
// bounds) an event is replaced by the fixed `redaction_failed` marker and a breadcrumb is
// dropped — never sent as it was, never dropped without a trace: each is counted in the metric
// `error / redaction_failed`.
//
// COLLECT NOTHING FROM THE REQUEST. The SDK's defaults (@sentry/core 11.5
// utils/data-collection/resolveDataCollectionOptions.js) read up to 10 KB of every non-GET body
// before the handler runs and attach it, with every cookie, header, the query string and the
// client address, to any event of that request. A sign-up body is a password, a name and a birth
// date, and a name has no shape a scan could find. So every category is switched off here —
// `DATA_COLLECTION` — and redaction is what cleans the REST, not what keeps a body in.
// (`sendDefaultPii` no longer exists in 11.x; `dataCollection` is the only switch.)
//
// Defence in depth, relied on by nothing: `captureError` — the one explicit exit to Sentry for
// the whole Worker — never hands over the object it was given. It sends `safeError(error)`: the
// class, the code, the scanned message and the stack frames. A driver error's own fields
// (`detail`, `parameters`, `where`, `cause`, a captured `response` or `request`) stay behind.

import * as Sentry from "@sentry/cloudflare";
import {
  redactBreadcrumb,
  redactEvent,
  SENTRY_DATA_COLLECTION,
  type RedactionFailure,
} from "../shared/sentry-redact";
// A pure module (text rules only; its one import is the shared redaction above).
import { safeError } from "./auth/redact";
import { buildMeta } from "./meta";
import { writeMetric } from "./services/metrics";

type SentryEnv = Pick<Env, "SENTRY_DSN" | "SENTRY_ENVIRONMENT"> & Partial<Pick<Env, "METRICS">>;

/**
 * Every category of request-derived data the SDK can collect, off — by the option names of the
 * installed @sentry/core (types/datacollection.d.ts). With `httpBodies: []` the request body is
 * not even READ (cloudflare integrations/httpServer.js: `effectiveBodySize === "none"`), so
 * nothing is teed in front of the auth handler or an upload. What is left on an event's
 * `request` is its method and its URL without the query.
 */
export const DATA_COLLECTION = SENTRY_DATA_COLLECTION satisfies NonNullable<
  Sentry.CloudflareOptions["dataCollection"]
>;

export function sentryOptions(env: SentryEnv): Sentry.CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  const failed: RedactionFailure = (kind) =>
    writeMetric(env, "error", { kind: "redaction_failed", reason: kind });
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: buildMeta().commit,
    // Errors only. Tracing is switched on, if ever, by the observability task.
    tracesSampleRate: 0,
    dataCollection: DATA_COLLECTION,
    beforeSend: (event) => redactEvent(event, failed),
    beforeSendTransaction: (event) => redactEvent(event, failed),
    beforeBreadcrumb: (breadcrumb) => redactBreadcrumb(breadcrumb, failed),
  };
}

/** Wraps the Worker's `{ fetch, queue, scheduled }`. */
export function withSentry(handler: ExportedHandler<Env>): ExportedHandler<Env> {
  return Sentry.withSentry<Env, unknown, unknown, ExportedHandler<Env>>((env) => sentryOptions(env), handler);
}

/**
 * Report an unexpected error — as a sanitised copy (`safeError`), never the object itself. `tags` are short enums (a request id, a route pattern, a job name)
 * — never a URL, an id from a path or anything a user typed. Never throws.
 */
export function captureError(error: unknown, tags: Record<string, string> = {}): void {
  try {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
      // Never the caught object itself: see the header.
      Sentry.captureException(safeError(error));
    });
  } catch {
    // Reporting must never break the thing being reported on.
  }
}
