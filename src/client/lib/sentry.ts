// Browser error reporting. Initialised only after the public config has loaded and only when it
// carries a DSN. The SDK is loaded on demand, so a build without a DSN never downloads it.
// Every event and breadcrumb passes through the shared redaction as the last step before it is
// sent. It fails closed: an event that cannot be redacted is replaced by the fixed
// `redaction_failed` marker (so the failure is visible), a breadcrumb is dropped — never sent raw.
import { redactBreadcrumb, redactEvent, SENTRY_DATA_COLLECTION } from "../../shared/sentry-redact";
import type { PublicConfig } from "./contracts";

type SentryModule = typeof import("@sentry/react");

let sdk: SentryModule | null = null;
let started: Promise<boolean> | null = null;

let failures = 0;
/** How many items could not be redacted since the page loaded (the marker event says so too). */
export const redactionFailures = (): number => failures;
const failed = (): void => {
  failures += 1;
};

/**
 * The redacted event, or the `redaction_failed` marker. The shared function does not throw; were
 * it ever to, the event is dropped rather than sent as it is. Exported for the unit test.
 */
export function redactOrDrop<T>(item: T): T | null {
  try {
    return redactEvent(item, failed);
  } catch {
    failed();
    return null;
  }
}

/**
 * A click or key-press crumb (`ui.click`, `ui.input`, …) is never kept: the SDK describes the
 * element by its `aria-label`, `title`, `name` and `alt` (@sentry/browser-utils htmlTreeAsString),
 * and the app labels rows, previews and upload buttons with file names — user content that no
 * redaction can tell from an ordinary word (R1 legal-7).
 */
const isDomCrumb = (item: unknown): boolean => {
  const category = (item as { category?: unknown } | null)?.category;
  return typeof category === "string" && category.startsWith("ui.");
};

/** The redacted breadcrumb, or null: a DOM crumb, or one that cannot be redacted, is dropped. */
export function redactCrumbOrDrop<T>(item: T): T | null {
  if (isDomCrumb(item)) return null;
  try {
    return redactBreadcrumb(item, failed);
  } catch {
    failed();
    return null;
  }
}

// Errors the app has already recovered from, so not reported: a page chunk that a stale tab could
// not fetch and that a reload (or the reload prompt) replaces (lib/stale-chunk.ts decides which).
// By object identity, never by message: the same failure when it is NOT recovered is reported.
const recovered = new WeakSet<object>();

/** Do not report this error object: the app recovered from it. */
export function markRecovered(error: unknown): void {
  if (typeof error === "object" && error !== null) recovered.add(error);
}

function isRecovered(error: unknown): boolean {
  return typeof error === "object" && error !== null && recovered.has(error);
}

export function initSentry(
  config: Pick<PublicConfig, "sentryDsnWeb" | "sentryEnvironment" | "release">,
  load: () => Promise<SentryModule> = () => import("@sentry/react"),
): Promise<boolean> {
  if (!config.sentryDsnWeb) return Promise.resolve(false);
  const dsn = config.sentryDsnWeb;
  started ??= load()
    .then((module) => {
      module.init({
        dsn,
        environment: config.sentryEnvironment,
        release: config.release,
        // Nothing user- or request-derived is collected: no cookies, headers, bodies or query
        // strings, and — `userInfo: false` — Sentry is told NEVER to infer the client's IP
        // address from the connection (`sdk.settings.infer_ip`), which no `beforeSend` could
        // remove afterwards. No replay, feedback or HTTP-client integration is added either:
        // the SDK's defaults only — and their click and key-press crumbs are dropped (below).
        dataCollection: SENTRY_DATA_COLLECTION,
        beforeSend: (event, hint) => (isRecovered(hint?.originalException) ? null : redactOrDrop(event)),
        beforeBreadcrumb: (breadcrumb) => redactCrumbOrDrop(breadcrumb),
      });
      sdk = module;
      return true;
    })
    .catch(() => {
      started = null;
      return false;
    });
  return started;
}

/** Report an error if reporting is on; otherwise a no-op. Never throws. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  try {
    sdk?.captureException(error, context ? { extra: context } : undefined);
  } catch {
    // Reporting must never break the page.
  }
}

/** Tests only. */
export function resetSentryForTests(): void {
  sdk = null;
  started = null;
}
