// Sentry for the Worker (`@sentry/cloudflare`). The DSN is the secret `SENTRY_DSN`; with no DSN
// the SDK is not initialised and every capture is a no-op (local dev, unit tests).
//
// Everything that leaves goes through `redactEvent` first — events, transactions and
// breadcrumbs — so download tokens, link tokens, invite codes, cookies and email addresses never
// reach Sentry. The wiring of `beforeSend` / `beforeBreadcrumb` to src/shared/sentry-redact.ts
// must survive any later change to this file.

import * as Sentry from "@sentry/cloudflare";
import { redactEvent } from "../shared/sentry-redact";
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
 * Report an unexpected error. `tags` are short enums (a request id, a route pattern, a job name)
 * — never a URL, an id from a path or anything a user typed. Never throws.
 */
export function captureError(error: unknown, tags: Record<string, string> = {}): void {
  try {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
      Sentry.captureException(error);
    });
  } catch {
    // Reporting must never break the thing being reported on.
  }
}
