// `ADMIN_EMAILS`: the bootstrap admins — EXACT ADDRESSES ONLY, compared on the bytes that were proven.
//
// One parser and one matcher, used by everything that asks "is this an admin address": the role
// grant at a verified sign-in and its re-evaluation (services/signup-policy.ts, auth/hooks.ts),
// the test-mode stand-ins (auth/test-outbound.ts), the health check's configuration flag and
// scripts/check-admin-emails.ts.
//
// THE RULE.
//   - The LIST is split on commas and each entry trimmed (that is parsing the list, nothing more).
//     An entry is accepted only if it is pure printable ASCII and one plain address:
//     `local@domain`, at most 254 characters; the local part of `a-z 0-9 . _ % + -`; the domain
//     of dot-separated LDH labels (letters, digits, inner hyphens) ending in a top-level label;
//     no trailing dot. After that test it is lower-cased — ASCII letters only.
//     Anything else is IGNORED — it grants nothing — and counted (`invalid`): a wildcard
//     (`*@domain`), a pattern, a display name (`Ana <a@x>`), quotes, comments, an IP literal, a
//     non-ASCII character (full-width or "mathematical" letters, an IDN domain in Unicode form).
//   - The ADDRESS that is asked about is the user row's stored `email` of a VERIFIED account
//     (services/signup-policy.ts — never a request field, a provider's profile or a pending
//     address). It is compared as stored: EXACT string equality, after lower-casing the ASCII
//     letters A–Z of it. NOTHING ELSE is done to it: no Unicode normalisation (NFKC would fold
//     `ａｄｍｉｎ` — a mailbox somebody else can own — onto `admin`), no Unicode case folding (`İ`,
//     `ı`, `ß`, the Kelvin sign), no trimming, no removal of zero-width characters, no plus or
//     dot folding, no IDN conversion. So a stored address with any non-ASCII character, or any
//     character outside the grammar, can never match; `a+b@x` is not `a@x`; `xn--…` is only ever
//     itself.
// The admin decision is made on the same bytes whose mailbox was proven. A `*@domain` rule would
// give the role to anyone who can get a mailbox at that domain; there is none, in any mode.

const LOCAL = /^[a-z0-9._%+-]{1,64}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** Lower-cases the letters A–Z and nothing else (`String#toLowerCase` folds beyond ASCII). */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** Is `text` (already lower-case) one plain ASCII address of the conservative grammar? */
function isPlainAddress(text: string): boolean {
  if (text.length < 3 || text.length > 254 || !PRINTABLE_ASCII.test(text)) return false;
  const at = text.indexOf("@");
  if (at < 1 || at !== text.lastIndexOf("@")) return false;
  const local = text.slice(0, at);
  const labels = text.slice(at + 1).split(".");
  return LOCAL.test(local) && labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

/** A LIST ENTRY as the address it names, or null when it is not one plain ASCII address. */
export function adminListEntry(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const text = asciiLower(entry.trim());
  return isPlainAddress(text) ? text : null;
}

export type AdminList = { addresses: ReadonlySet<string>; invalid: number };

/** The valid entries of a list, and HOW MANY entries were not valid (never which). */
export function parseAdminList(list: unknown): AdminList {
  const addresses = new Set<string>();
  let invalid = 0;
  if (typeof list !== "string") return { addresses, invalid };
  for (const entry of list.split(",")) {
    if (entry.trim() === "") continue;
    const address = adminListEntry(entry);
    if (address === null) invalid += 1;
    else addresses.add(address);
  }
  return { addresses, invalid };
}

/**
 * Is the STORED address — exactly, but for the case of its ASCII letters — one of the list's?
 * Nothing is trimmed, normalised or folded: see the header.
 */
export function isListedAdmin(list: AdminList, storedEmail: unknown): boolean {
  return typeof storedEmail === "string" && list.addresses.has(asciiLower(storedEmail));
}

/** RFC 2606 / 6761: a name under these can never be anyone's real mailbox. */
export const RESERVED_TEST_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example|test)$/;
