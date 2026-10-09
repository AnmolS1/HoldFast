// One strict reading of the Cookie header, before anything else reads it.
//
// WHY. A cookie is looked up by name, and every parser has its own idea of "the cookie named N"
// when a header is unusual. Better Auth's (better-call/dist/cookies.mjs `parseCookies`, used by
// `ctx.getCookie` / `ctx.getSignedCookie`): the name is the text before the first `=`, TRIMMED,
// compared exactly, and of two cookies with one name the FIRST wins; values are unquoted and
// percent-decoded. Ours (auth/signed-cookie.ts `readCookie`) refuses a name sent twice. A
// browser, a proxy or an attacker's script on a sibling site may order, pad, encode or case a
// name differently — and whoever can add a cookie to a request (a sibling subdomain of the
// shared parent domain, a network attacker on plain http) then decides which value a parser
// picks: a planted session, sign-up intent, two-factor challenge or OAuth state instead of the
// real one.
//
// THE RULE, for every cookie of this app (Better Auth's `hf.*` and our `hf_*`, whatever prefix
// they are written with): group the header's cookies by FAMILY — the name trimmed,
// percent-decoded, lower-cased, without a `__Host-` / `__Secure-` prefix. A family is kept only
// when the header holds exactly ONE member of it and that member's name is, byte for byte, the
// name this origin sets (`__Host-hf.…` on https, `hf.…` on plain http). Otherwise EVERY member
// of the family is removed from the request — it then has no such cookie at all (fail closed) —
// and the event is counted and audited (`auth.cookie_ambiguous`: family names only, no values).
// So: a duplicate (in either order), a case variant, an encoded or padded name, and a
// prefix-less or `__Secure-` variant on https are never read by anything behind this.
//
// It runs for every /api/* request, in front of the session read, the routes and Better Auth's
// handler — which all then see the same, unambiguous header.

import type { MiddlewareHandler } from "hono";
import { countFor, record } from "../auth/observe";
import { COOKIE_HOST_PREFIX } from "../auth/signed-cookie";
import type { AppEnv } from "../services/request-context";

const APP_FAMILY = /^hf[._]/;
const PREFIXES = ["__host-", "__secure-"];

/** The family of a cookie name as written (see the header), or null when it is not one of ours. */
export function cookieFamily(rawName: string): string | null {
  let name = rawName.trim();
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(name); round++) {
    try {
      name = decodeURIComponent(name);
    } catch {
      break;
    }
  }
  name = name.trim().toLowerCase();
  for (const prefix of PREFIXES) if (name.startsWith(prefix)) name = name.slice(prefix.length);
  return APP_FAMILY.test(name) ? name : null;
}

export type GuardedCookies = {
  /** The header to use instead, or null when no cookie is left. Undefined: nothing to change. */
  header?: string | null;
  /** The families that were removed, sorted. */
  ambiguous: string[];
};

/**
 * `header` without every cookie of an ambiguous family. `secure`: the origin is https (names
 * carry `__Host-`).
 */
export function guardCookies(header: string | null | undefined, secure: boolean): GuardedCookies {
  if (!header) return { ambiguous: [] };
  const pairs = header.split(";").map((pair) => {
    const eq = pair.indexOf("=");
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    return { pair, rawName, family: cookieFamily(rawName) };
  });
  const members = new Map<string, typeof pairs>();
  for (const entry of pairs) {
    if (entry.family === null) continue;
    members.set(entry.family, [...(members.get(entry.family) ?? []), entry]);
  }
  const ambiguous: string[] = [];
  for (const [family, entries] of members) {
    const expected = `${secure ? COOKIE_HOST_PREFIX : ""}${family}`;
    // The separator after `;` is one space; anything else around a name is not how a browser
    // writes a cookie of ours.
    const exact = entries.length === 1 && entries[0]!.rawName.replace(/^ /, "") === expected;
    if (!exact) ambiguous.push(family);
  }
  if (ambiguous.length === 0) return { ambiguous };
  const dropped = new Set(ambiguous);
  const kept = pairs.filter((entry) => entry.family === null || !dropped.has(entry.family));
  const rest = kept
    .map((entry) => entry.pair.trim())
    .filter((pair) => pair !== "")
    .join("; ");
  return { header: rest === "" ? null : rest, ambiguous: ambiguous.sort() };
}

/** A family name as it may be written to a log: the known shape, bounded. */
const safeFamily = (family: string) => (/^hf[._][a-z0-9._-]{1,48}$/.test(family) ? family : "hf.other");

export const cookieGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secure = c.env.APP_ORIGIN.startsWith("https://");
  const guarded = guardCookies(c.req.raw.headers.get("cookie"), secure);
  if (guarded.ambiguous.length === 0) return next();
  const headers = new Headers(c.req.raw.headers);
  if (guarded.header) headers.set("cookie", guarded.header);
  else headers.delete("cookie");
  // Everything behind this — the session read, the routes, Better Auth — reads this request.
  c.req.raw = new Request(c.req.raw, { headers });
  const names = [...new Set(guarded.ambiguous.map(safeFamily))].slice(0, 8);
  countFor(c.env, "auth", { outcome: "denied", kind: "cookie_ambiguous" });
  record(c, "auth.cookie_ambiguous", { type: "request" }, { cookies: names.join(","), count: names.length });
  return next();
};
