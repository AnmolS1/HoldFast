// File and folder names: the stored form, the uniqueness key and the extension.
//
// STUB, owned by the database task until the hardening task replaces the bodies with the full
// sanitiser. The three signatures stay, and so does the meaning of every `nameKey` and `ext`
// value already stored.

import { QueryError } from "../db/errors";

// Unicode categories Cc (control characters) and Cf (format characters: zero-width characters,
// bidi embeddings / overrides / isolates, the BOM). Written as categories so that this file
// contains no invisible character.
const STRIP = /[\p{Cc}\p{Cf}]/gu;

const MAX_NAME_LENGTH = 255;

function clean(raw: string): string {
  return raw.normalize("NFC").replace(STRIP, "").trim();
}

/** The name as stored. Throws `validation` for a name that cannot be used. */
export function sanitizeName(raw: string): string {
  const name = clean(raw);
  if (name === "" || name === "." || name === "..") throw new QueryError("validation", "invalid name");
  if (name.includes("/") || name.includes("\\")) throw new QueryError("validation", "invalid name");
  if (name.length > MAX_NAME_LENGTH) throw new QueryError("validation", "name too long");
  return name;
}

/** What uniqueness within a folder and ordering by name compare. */
export function nameKeyOf(name: string): string {
  return clean(name).toLocaleLowerCase("en");
}

/** Lower-case extension without the dot; '' when there is none (also for ".gitignore"). */
export function extOf(name: string): string {
  const cleaned = clean(name);
  const dot = cleaned.lastIndexOf(".");
  if (dot <= 0 || dot === cleaned.length - 1) return "";
  const ext = cleaned.slice(dot + 1).toLocaleLowerCase("en");
  return /^[a-z0-9_+-]{1,16}$/.test(ext) ? ext : "";
}
