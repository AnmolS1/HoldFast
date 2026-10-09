// CONTRACT STUB (contracts-0). Owner: T05 (database), which replaces this file with the real
// queries against the `settings` table. Until then these are signatures only.

import type { Db } from "../client";

/**
 * The keys of the `settings` table. Every key is optional: a row may be absent, and this module
 * takes no `env`, so it cannot fill in the defaults that come from vars.
 */
export type Settings = {
  signupMode?: "invite" | "open";
  uploadsEnabled?: boolean;
  linksEnabled?: boolean;
  readOnly?: boolean;
  /** Partial overrides, keyed by var name plus the four sign-up velocity keys. */
  ceilings?: Record<string, number>;
  termsVersion?: string;
  orphanDeleteEnabled?: boolean;
  /** Internal to the reconcile job; never in a DTO. */
  reconcileCursor?: unknown;
  dmcaAutoCloseDays?: number | null;
};

export async function getSettings(db: Db): Promise<Settings> {
  void db;
  throw new Error("not implemented: T05");
}

export async function setSetting<K extends keyof Settings>(
  db: Db,
  key: K,
  value: Exclude<Settings[K], undefined>,
  actor: string | null,
): Promise<void> {
  void db;
  void key;
  void value;
  void actor;
  throw new Error("not implemented: T05");
}
