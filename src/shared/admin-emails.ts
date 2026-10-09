// `ADMIN_EMAILS`: the bootstrap admins — EXACT ADDRESSES ONLY.
//
// One parser and one matcher, used by everything that asks "is this an admin address": the role
// grant at a verified sign-in (services/signup-policy.ts), the test-mode stand-ins
// (auth/test-outbound.ts), the health check's configuration flag and scripts/check-admin-emails.ts.
//
// THE RULE.
//   - The list is split on commas; each entry is trimmed and canonicalised: NFKC, lower case.
//   - An entry must then be ONE plain address: `local@domain`, the local part of letters, digits
//     and `. _ + -` (starting and ending with a letter or digit), the domain of dot-separated
//     labels of letters, digits and hyphens with at least one dot. ASCII only. Nothing else: no
//     wildcard (`*@domain`, `?`), no glob or regex character, no display name (`Ana <a@x>`), no
//     quotes, no spaces, no IP literal.
//   - An entry that is not such an address is IGNORED — it grants nothing — and counted
//     (`invalid`); it never widens what the valid entries grant.
//   - Matching is EXACT EQUALITY of canonical forms. Case is folded (`Ana@X.com` is `ana@x.com`).
//     Nothing else is: `a+b@x.com` is not `a@x.com`, `a.b@gmail.com` is not `ab@gmail.com`, and
//     an address with a non-ASCII character matches nothing (it is not a valid entry, and a
//     non-ASCII sign-in address has no canonical form here).
// A `*@domain` rule would give the admin role to anyone who can get a mailbox — or a verified
// Google identity — at that domain. There is no such rule, in any mode.

const ADDRESS =
  /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** The canonical form of an address for the admin list, or null when it is not one plain address. */
export function canonicalAdminAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim().toLowerCase();
  if (text.length < 3 || text.length > 254 || !ADDRESS.test(text) || text.includes("..")) return null;
  return text;
}

export type AdminList = { addresses: ReadonlySet<string>; invalid: number };

/** The valid entries of a list, and HOW MANY entries were not valid (never which). */
export function parseAdminList(list: unknown): AdminList {
  const addresses = new Set<string>();
  let invalid = 0;
  if (typeof list !== "string") return { addresses, invalid };
  for (const entry of list.split(",")) {
    if (entry.trim() === "") continue;
    const address = canonicalAdminAddress(entry);
    if (address === null) invalid += 1;
    else addresses.add(address);
  }
  return { addresses, invalid };
}

/** Is `email` — exactly, in canonical form — one of the list's valid addresses? */
export function isListedAdmin(list: AdminList, email: unknown): boolean {
  const address = canonicalAdminAddress(email);
  return address !== null && list.addresses.has(address);
}

/** RFC 2606 / 6761: a name under these can never be anyone's real mailbox. */
export const RESERVED_TEST_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:example|test)$/;
