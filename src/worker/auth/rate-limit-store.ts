// Better Auth's per-address request limiter, stored in `rate_limit` WITHOUT the address
// (R1 legal-1). Better Auth keys a row `<ip>|<path>` (api/rate-limiter/index.mjs:248,
// @better-auth/core/dist/utils/ip.mjs:228-229) and offers no hook on the key; its only seam is
// `rateLimit.customStorage` (`{ consume(key, rule) }`, @better-auth/core/dist/types/init-options.d.mts:142-166),
// which REPLACES its database storage (index.mjs:197). So the store is ours: the address part of
// the key becomes a keyed hash (`rl:<hmac>|<path>`) before anything is written.
//
// Replacing the storage also turns off Better Auth's table-wide prune (index.mjs:133, :174),
// which deleted EVERY row of `rate_limit` past its own longest window (one hour) — Holdfast's
// 24 h export-day budget included (R1 verify V1-n1). Nothing here deletes; the rows go with the
// retention job (jobs/retention.ts, `rate_limit`), past the longest window of any key family.
//
// The decision is Better Auth's own (index.mjs `decideConsume`, :25-63), in ONE statement on the
// database's clock (as every other writer of the table): no row → 1; a row idle for the whole
// window → starts again at 1; at `max` → refused, wait = what is left of the window; else +1.
// Every admitted request moves `last_request` to now (the window is measured from the last one).

import { sql } from "drizzle-orm";
import type { BetterAuthRateLimitStorage } from "@better-auth/core";
import type { Executor } from "../db/client";
import { hmacHex, type Keys } from "../services/keys";
import { normalise } from "../services/ip-hash";

/** Every key this store writes starts with this. */
export const AUTH_LIMIT_PREFIX = "rl:";

/**
 * `rl:<hash>|` — the part of the key that stands for one client address. The hash is of the
 * normalised address (an IPv6 address as its /64), under the stable IP key with its own label,
 * so it matches no `ipHashStable` stored elsewhere.
 */
export async function authLimitClientPrefix(keys: Keys, ip: string): Promise<string> {
  const hash = await hmacHex(keys, "ip-hash-stable", `auth-limit|${normalise(ip)}`);
  return `${AUTH_LIMIT_PREFIX}${hash.slice(0, 32)}|`;
}

/** Better Auth's `<ip>|<path>` as it is stored. The address is everything before the FIRST `|`. */
export async function storedAuthLimitKey(keys: Keys, key: string): Promise<string> {
  const cut = key.indexOf("|");
  const client = cut === -1 ? key : key.slice(0, cut);
  const path = cut === -1 ? "" : key.slice(cut + 1);
  return `${await authLimitClientPrefix(keys, client)}${path}`;
}

/** The store Better Auth's limiter counts in (`rateLimit.customStorage`). */
export function authLimitStore(db: Executor, keys: Keys): BetterAuthRateLimitStorage {
  return {
    async consume(key, rule) {
      const stored = await storedAuthLimitKey(keys, key);
      const windowMs = rule.window * 1000;
      const result = await db.execute<{ admitted: number | null; wait_ms: string | number | null }>(sql`
        WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms),
        held AS (
          SELECT r.last_request + ${windowMs} - clock.ms AS wait_ms FROM rate_limit r, clock WHERE r.key = ${stored}
        ),
        admitted AS (
          INSERT INTO rate_limit AS r (id, key, count, last_request)
          SELECT gen_random_uuid()::text, ${stored}, 1, clock.ms FROM clock
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN r.last_request <= (SELECT ms FROM clock) - ${windowMs} THEN 1 ELSE r.count + 1 END,
            last_request = (SELECT ms FROM clock)
          WHERE r.last_request <= (SELECT ms FROM clock) - ${windowMs} OR r.count < ${rule.max}
          RETURNING r.count
        )
        SELECT (SELECT count FROM admitted) AS admitted, (SELECT wait_ms FROM held) AS wait_ms`);
      const row = result.rows[0];
      if (row && row.admitted !== null) return { allowed: true, retryAfter: null };
      const waitMs = row?.wait_ms != null ? Number(row.wait_ms) : windowMs;
      return { allowed: false, retryAfter: Math.min(rule.window, Math.max(1, Math.ceil(waitMs / 1000))) };
    },
  };
}
