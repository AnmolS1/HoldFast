// Sentry for the Worker (`@sentry/cloudflare`). The DSN is the secret `SENTRY_DSN`; with no DSN
// the SDK is not initialised and every capture is a no-op (local dev, unit tests).
//
// Everything that leaves goes through `redactEvent` first — events, transactions and
// breadcrumbs — so download tokens, link tokens, invite codes, cookies and email addresses never
// reach Sentry. The wiring of `beforeSend` / `beforeBreadcrumb` to src/shared/sentry-redact.ts
// must survive any later change to this file.
//
// THE RULE: redaction that counts happens LAST. `beforeSend`, `beforeSendTransaction` and
// `beforeBreadcrumb` hand the fully assembled item to `redactEvent`, a generic walk that scans
// every string in it whatever field it is in. By then the SDK has copied one value into several
// fields (an error's message, the request URL, a breadcrumb, the transaction name), so redacting
// any one representation earlier cannot be what keeps a secret in.
//
// Defence in depth, relied on by nothing: `captureError` — the one explicit exit to Sentry for
// the whole Worker — never hands over the object it was given. It sends `safeError(error)`: the
// class, the code, the scanned message and the stack frames. A driver error's own fields
// (`detail`, `parameters`, `where`, `cause`, a captured `response` or `request`) stay behind.

import * as Sentry from "@sentry/cloudflare";
import { redactEvent } from "../shared/sentry-redact";
// A pure module (text rules only; its one import is the shared redaction above).
import { safeError } from "./auth/redact";
import { buildMeta } from "./meta";

type SentryEnv = Pick<Env, "SENTRY_DSN" | "SENTRY_ENVIRONMENT">;

export function sentryOptions(env: SentryEnv): Sentry.CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: buildMeta().commit,
    // Errors only. Tracing is switched on, if ever, by the observability task.
    tracesSampleRate: 0,
    beforeSend: (event) => redactEvent(event),
    beforeSendTransaction: (event) => redactEvent(event),
    beforeBreadcrumb: (breadcrumb) => redactEvent(breadcrumb),
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
