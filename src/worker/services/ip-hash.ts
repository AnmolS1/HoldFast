// Keyed hashes of client addresses. Two helpers that are never interchangeable:
//
//   ipHashDaily(keys, ip, dayUTC)   rotates every UTC day, so rows cannot be linked across days.
//                                   audit_log.ipHashDaily, link_access_log.ipHashDaily, sign-up
//                                   velocity subjects.
//   ipHashStable(keys, ip)          does not rotate: a persistent pseudonymous identifier. Stored
//                                   only for report dedupe, link sessions and the link-password
//                                   throttle.
//
// Both hash the NORMALISED address: IPv4 as it is, IPv6 truncated to its /64 (one subscriber).

import { hmacHex, type Keys } from "./keys";

type Parsed = { v: 4; octets: number[] } | { v: 6; groups: number[] };

function parseV4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseV6(text: string): number[] | null {
  let source = text;
  // A trailing dotted quad (::ffff:192.0.2.1) is two groups.
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    source = `${source.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    for (const group of half.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function parse(ip: string): Parsed | null {
  let text = ip.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) {
    const octets = parseV4(text);
    return octets ? { v: 4, octets } : null;
  }
  const groups = parseV6(text);
  if (!groups) return null;
  // IPv4-mapped (::ffff:a.b.c.d) is the IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return { v: 4, octets: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff] };
  }
  return { v: 6, groups };
}

const hex = (groups: number[]) => groups.map((group) => group.toString(16)).join(":");

/**
 * The canonical form that gets hashed: an IPv4 address as it is, an IPv6 address as its /64
 * (`2001:db8:0:1::/64`), whatever spelling it arrived in. Text that is not an address is
 * returned trimmed and lower-cased, so it still hashes to something stable.
 */
export function normalise(ip: string): string {
  const parsed = parse(ip);
  if (!parsed) return ip.trim().toLowerCase();
  if (parsed.v === 4) return parsed.octets.join(".");
  return `${hex(parsed.groups.slice(0, 4))}::/64`;
}

/** The wider network an address sits in: its /24 (IPv4) or /48 (IPv6). */
export function ipPrefix(ip: string): string {
  const parsed = parse(ip);
  if (!parsed) return ip.trim().toLowerCase();
  if (parsed.v === 4) return `${parsed.octets.slice(0, 3).join(".")}.0/24`;
  return `${hex(parsed.groups.slice(0, 3))}::/48`;
}

/** `YYYY-MM-DD` in UTC: the day an `ipHashDaily` belongs to. */
export function dayUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** HMAC(ip-hash, normalise(ip) + "|" + dayUTC). Different every UTC day. */
export function ipHashDaily(keys: Keys, ip: string, day: string): Promise<string> {
  return hmacHex(keys, "ip-hash", `${normalise(ip)}|${day}`);
}

/** HMAC(ip-hash-stable, normalise(ip)). Never rotates — see the header for where it may be stored. */
export function ipHashStable(keys: Keys, ip: string): Promise<string> {
  return hmacHex(keys, "ip-hash-stable", normalise(ip));
}
