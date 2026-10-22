// A tab left open across a deploy asks for page chunks the new deploy no longer has (their names
// are content hashes). Vite reports that as `vite:preloadError`; the answer is to reload the page
// at the same address, once, so the new build is loaded.
//   - Once: the reload is stamped on the current history entry (history.state survives a reload;
//     Web Storage is not used — the client writes nothing there but the UI preferences). A second
//     failure on the same entry within RELOAD_WINDOW_MS does not reload again: the error goes on to
//     the route's error page, as it would without this handler.
//   - A transfer in progress (an upload, a zip — anything on the transfer ribbon) is not thrown
//     away by a reload: the user is asked instead, and decides when.
// The event is never cancelled: the import still fails, so the error page shows until the reload
// lands (or for good, when there is no reload). A failure recovered from (reload or prompt) is not
// an error report (lib/sentry.ts `markRecovered`); one that is not recovered from is reported.
import { getRibbonSnapshot } from "../components/TransferRibbon";
import { toast } from "../components/Toaster";
import { t } from "./i18n";
import { markRecovered } from "./sentry";

export const RELOAD_STAMP = "hfChunkReloadAt";
export const RELOAD_WINDOW_MS = 30_000;
export const NEW_VERSION_TOAST = "new-version";
/** The prompt stays until it is acted on. */
const PROMPT_DURATION_MS = 24 * 60 * 60 * 1000;

export interface StaleChunkDeps {
  now(): number;
  reload(): void;
  /** True while a transfer that a reload would lose is open. */
  busy(): boolean;
}

const defaults: StaleChunkDeps = {
  now: () => Date.now(),
  reload: () => window.location.reload(),
  busy: () => getRibbonSnapshot().openCount > 0,
};

function stampedAt(): number | null {
  const state: unknown = window.history.state;
  if (typeof state !== "object" || state === null) return null;
  const at = (state as Record<string, unknown>)[RELOAD_STAMP];
  return typeof at === "number" ? at : null;
}

/** Stamp the current entry. False when it could not be written: then no reload (no loop guard). */
function stamp(at: number): boolean {
  try {
    const state: unknown = window.history.state;
    const base = typeof state === "object" && state !== null ? state : {};
    window.history.replaceState({ ...base, [RELOAD_STAMP]: at }, "");
    return stampedAt() === at;
  } catch {
    return false;
  }
}

export type StaleChunkOutcome = "reloaded" | "prompted" | "left";

export function onStaleChunk(overrides: Partial<StaleChunkDeps> = {}): StaleChunkOutcome {
  const deps = { ...defaults, ...overrides };
  if (deps.busy()) {
    toast({
      key: NEW_VERSION_TOAST,
      message: t("app.newVersion"),
      action: { label: t("app.reload"), onClick: () => deps.reload() },
      duration: PROMPT_DURATION_MS,
    });
    return "prompted";
  }
  const now = deps.now();
  const last = stampedAt();
  if (last !== null && now - last >= 0 && now - last < RELOAD_WINDOW_MS) return "left";
  if (!stamp(now)) return "left";
  deps.reload();
  return "reloaded";
}

/** Listen for Vite's chunk-load failures. Returns the function that stops listening. */
export function installStaleChunkReload(deps: Partial<StaleChunkDeps> = {}): () => void {
  const listener = (event: Event) => {
    // Vite's preload helper puts the failure on the event and then throws that same object.
    if (onStaleChunk(deps) !== "left") markRecovered((event as Event & { payload?: unknown }).payload);
  };
  window.addEventListener("vite:preloadError", listener);
  return () => window.removeEventListener("vite:preloadError", listener);
}
