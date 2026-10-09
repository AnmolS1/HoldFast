// Runtime settings: the `settings` table, one row per key, read through a 60 s in-isolate cache.
//
// This module takes no `env`, so it cannot fill in the defaults that come from vars
// (`signupMode`, `termsVersion`, the ceilings): a key with no row is simply absent, and the
// caller merges with its own defaults.

import { sql } from "drizzle-orm";
import type { Executor } from "../client";
import { settings } from "../schema";

export type Settings = {
  signupMode?: "invite" | "open";
  uploadsEnabled?: boolean;
  linksEnabled?: boolean;
  readOnly?: boolean;
  /** Partial overrides, keyed by var name plus the four sign-up velocity keys. */
  ceilings?: Record<string, number>;
  /** The source of the current terms version; the `TERMS_VERSION` var is only its default. */
  termsVersion?: string;
  /** The reconcile job deletes orphaned objects only while this is true (default true). */
  orphanDeleteEnabled?: boolean;
  /** Internal to the reconcile job; never in a DTO. */
  reconcileCursor?: unknown;
  /** Reserved. No job reads it in v1; null = off. */
  dmcaAutoCloseDays?: number | null;
};

const CACHE_MS = 60_000;

// A resolved value and the time it was read — never a promise: a promise created inside one
// request must not be awaited by another.
let cache: { value: Settings; at: number } | null = null;

/** Drops the cached value. `setSetting` calls it; tests call it between cases. */
export function clearSettingsCache(): void {
  cache = null;
}

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

/** Rows → `Settings`. An unknown key or a value of the wrong type is ignored, never trusted. */
function parse(rows: { key: string; value: unknown }[]): Settings {
  const out: Settings = {};
  for (const { key, value } of rows) {
    switch (key) {
      case "signupMode":
        if (value === "invite" || value === "open") out.signupMode = value;
        break;
      case "uploadsEnabled":
        if (isBoolean(value)) out.uploadsEnabled = value;
        break;
      case "linksEnabled":
        if (isBoolean(value)) out.linksEnabled = value;
        break;
      case "readOnly":
        if (isBoolean(value)) out.readOnly = value;
        break;
      case "orphanDeleteEnabled":
        if (isBoolean(value)) out.orphanDeleteEnabled = value;
        break;
      case "termsVersion":
        if (typeof value === "string" && value !== "") out.termsVersion = value;
        break;
      case "ceilings":
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const ceilings: Record<string, number> = {};
          for (const [name, n] of Object.entries(value)) {
            if (typeof n === "number" && Number.isFinite(n) && n >= 0) ceilings[name] = n;
          }
          out.ceilings = ceilings;
        }
        break;
      case "reconcileCursor":
        out.reconcileCursor = value;
        break;
      case "dmcaAutoCloseDays":
        if (value === null || (typeof value === "number" && Number.isInteger(value) && value > 0)) {
          out.dmcaAutoCloseDays = value;
        }
        break;
    }
  }
  return out;
}

/**
 * Every setting that has a row. Cached in the isolate for 60 s, so a change made by another
 * isolate is seen within a minute; `{ fresh: true }` reads the table.
 */
export async function getSettings(db: Executor, opts?: { fresh?: boolean }): Promise<Settings> {
  const now = Date.now();
  if (!opts?.fresh && cache && now - cache.at < CACHE_MS) return cache.value;
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  const value = parse(rows);
  cache = { value, at: now };
  return value;
}

/** Upserts one key. `actor` is the admin's user id, or null for a system write. */
export async function setSetting<K extends keyof Settings>(
  db: Executor,
  key: K,
  value: Exclude<Settings[K], undefined>,
  actor: string | null,
): Promise<void> {
  // `sql` with an explicit jsonb cast: the driver would send a bare JSON string or `null` as a
  // text / SQL NULL parameter otherwise.
  const json = sql`${JSON.stringify(value)}::jsonb`;
  await db
    .insert(settings)
    .values({ key, value: json, updatedBy: actor })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: json, updatedBy: actor, updatedAt: sql`now()` },
    });
  clearSettingsCache();
}
