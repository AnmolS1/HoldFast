// UI preferences: theme, density, view mode.
//
// Persistence rule: LOCAL until the account task registers a sync (`registerPrefsSync`), then
// SYNCED — on registration the server copy wins and overwrites local; afterwards each change is
// written locally at once and to the server debounced. This file makes no API call itself.
//
// Storage: density and view mode live under `hf.prefs.v1`; the theme lives under the UI library's
// own key (`mui-mode`), because `public/color-scheme-init.js` and the theme provider both read
// that key and there must be exactly one source. Nothing else is ever written to Web Storage.
import { useSyncExternalStore } from "react";
import { registerUserStatePurger } from "./contracts";

export type ThemePref = "system" | "light" | "dark";
export type Density = "compact" | "comfortable";
export type ViewMode = "list" | "grid";

export interface Prefs {
  theme: ThemePref;
  density: Density;
  viewMode: ViewMode;
}

export interface PrefsSync {
  load(): Promise<Partial<Prefs> | null>;
  save(prefs: Prefs): Promise<void>;
}

export const PREFS_KEY = "hf.prefs.v1";
export const MODE_KEY = "mui-mode";
export const SYNC_DEBOUNCE_MS = 800;

const DEFAULTS: Prefs = { theme: "system", density: "compact", viewMode: "list" };

const isTheme = (v: unknown): v is ThemePref => v === "system" || v === "light" || v === "dark";
const isDensity = (v: unknown): v is Density => v === "compact" || v === "comfortable";
const isViewMode = (v: unknown): v is ViewMode => v === "list" || v === "grid";

/** Keep only known keys with valid values; anything else in storage or from a server is ignored. */
export function sanitizePrefs(input: unknown): Partial<Prefs> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<Prefs> = {};
  if (isTheme(raw.theme)) out.theme = raw.theme;
  if (isDensity(raw.density)) out.density = raw.density;
  if (isViewMode(raw.viewMode)) out.viewMode = raw.viewMode;
  return out;
}

function readLocal(): Prefs {
  let stored: Partial<Prefs> = {};
  let theme: ThemePref = DEFAULTS.theme;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) stored = sanitizePrefs(JSON.parse(raw));
    const mode = localStorage.getItem(MODE_KEY);
    if (isTheme(mode)) theme = mode;
  } catch {
    // Storage blocked or corrupt: defaults.
  }
  return {
    ...DEFAULTS,
    density: stored.density ?? DEFAULTS.density,
    viewMode: stored.viewMode ?? DEFAULTS.viewMode,
    theme,
  };
}

function writeLocal(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ density: prefs.density, viewMode: prefs.viewMode }));
    // The theme is written by the theme provider when PrefsEffects calls setMode; writing it here
    // too keeps the key right when no provider is mounted (tests, the first paint script).
    localStorage.setItem(MODE_KEY, prefs.theme);
  } catch {
    // Storage blocked: the preference lasts for this page only.
  }
}

let state: Prefs = typeof localStorage === "undefined" ? DEFAULTS : readLocal();
let sync: PrefsSync | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function applyDensity(): void {
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-density", state.density);
}

function scheduleSave(): void {
  if (!sync) return;
  clearTimeout(timer);
  const target = sync;
  timer = setTimeout(() => {
    void target.save(state).catch(() => {
      // The local copy stays authoritative for this device; the next change retries.
    });
  }, SYNC_DEBOUNCE_MS);
}

export function getPrefs(): Prefs {
  return state;
}

export function setPrefs(patch: Partial<Prefs>, options: { fromServer?: boolean } = {}): void {
  const clean = sanitizePrefs(patch);
  const next = { ...state, ...clean };
  if (next.theme === state.theme && next.density === state.density && next.viewMode === state.viewMode)
    return;
  state = next;
  writeLocal(state);
  applyDensity();
  emit();
  if (!options.fromServer) scheduleSave();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Called once by the account task after sign-in. The server copy wins: it is loaded and written
 * over the local one. Returns a function that removes the sync (sign-out).
 */
export async function registerPrefsSync(next: PrefsSync): Promise<() => void> {
  sync = next;
  try {
    const remote = await next.load();
    if (sync === next && remote) setPrefs(remote, { fromServer: true });
  } catch {
    // Offline or failing: stay on the local copy; changes are still pushed.
  }
  return () => {
    if (sync === next) {
      sync = null;
      clearTimeout(timer);
    }
  };
}

/** Re-read storage and drop any sync. Tests only. */
export function resetPrefsForTests(): void {
  sync = null;
  clearTimeout(timer);
  state = readLocal();
  applyDensity();
  emit();
}

export interface UsePrefs extends Prefs {
  setTheme(theme: ThemePref): void;
  setDensity(density: Density): void;
  setViewMode(viewMode: ViewMode): void;
}

const setTheme = (theme: ThemePref) => setPrefs({ theme });
const setDensity = (density: Density) => setPrefs({ density });
const setViewMode = (viewMode: ViewMode) => setPrefs({ viewMode });

export function usePrefs(): UsePrefs {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
  return { ...prefs, setTheme, setDensity, setViewMode };
}

applyDensity();

// The sync is bound to one account's prefs API: an identity change or sign-out removes it, and a
// pending save for the previous account is dropped. The local values are device UI preferences.
registerUserStatePurger(() => {
  sync = null;
  clearTimeout(timer);
});
