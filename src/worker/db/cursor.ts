// Opaque keyset cursors: base64url of a small JSON value. A cursor is bound to the listing it
// came from (its `tag`), so one from another listing, sort or direction is rejected.

import { QueryError } from "./errors";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export function encodeCursor(tag: string, value: unknown): string {
  return toBase64Url(JSON.stringify({ t: tag, v: value }));
}

/**
 * Returns the value of a cursor issued for `tag`. Throws `validation` for anything else:
 * garbage, a cursor of another listing, or one whose value fails `check`.
 */
export function decodeCursor<T>(tag: string, cursor: string, check: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new QueryError("validation", "invalid cursor");
  }
  if (!parsed || typeof parsed !== "object") throw new QueryError("validation", "invalid cursor");
  const { t, v } = parsed as { t?: unknown; v?: unknown };
  if (t !== tag) throw new QueryError("validation", "cursor does not match this listing");
  if (!check(v)) throw new QueryError("validation", "invalid cursor");
  return v;
}

/** `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`: the only form a listing writes a timestamp into a cursor in. */
const CURSOR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;

/**
 * True for a cursor timestamp that Postgres will accept in a `::timestamptz` cast: the exact
 * form above, naming a real calendar date and time. Anything else (a cursor is client-writable)
 * must be refused as `validation` before it reaches a query.
 */
export function isCursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = CURSOR_TIMESTAMP.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
