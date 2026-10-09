// Browser error reporting. Initialised only after the public config has loaded and only when it
// carries a DSN. The SDK is loaded on demand, so a build without a DSN never downloads it.
// Every event and breadcrumb passes through the shared redaction as the last step before it is
// sent. It fails closed: an event that cannot be redacted is replaced by the fixed
// `redaction_failed` marker (so the failure is visible), a breadcrumb is dropped — never sent raw.
import { redactBreadcrumb, redactEvent } from "../../shared/sentry-redact";
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

/** The redacted breadcrumb, or null: a breadcrumb that cannot be redacted is dropped. */
export function redactCrumbOrDrop<T>(item: T): T | null {
  try {
    return redactBreadcrumb(item, failed);
  } catch {
    failed();
    return null;
  }
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
        beforeSend: (event) => redactOrDrop(event),
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
