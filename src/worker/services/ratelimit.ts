// Wrapper over the Workers Rate Limiting bindings (RL_AUTH, RL_API, RL_FILES, RL_LINKS).
//
// The binding is per-colo and eventually consistent: it is a coarse abuse control, nothing more.
// A hard daily limit is a database ledger, not this. The binding reports only success or failure,
// so `Retry-After` is the limiter's period.
//
// A limiter that is missing or throws lets the request through (and is counted): losing a coarse
// control must not take the API down.

import { AppError } from "./errors";
import { writeMetric } from "./metrics";

export type LimiterName = "RL_AUTH" | "RL_API" | "RL_FILES" | "RL_LINKS";

/** Every limiter in wrangler.jsonc has `period: 60`. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

type LimiterEnv = Partial<Record<LimiterName, RateLimit>> & {
  METRICS?: AnalyticsEngineDataset;
  SENTRY_ENVIRONMENT?: string;
};

/** True when the request may proceed. */
export async function checkRateLimit(env: LimiterEnv, name: LimiterName, key: string): Promise<boolean> {
  try {
    const limiter = env[name];
    if (!limiter) return true;
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    writeMetric(env, "error", { kind: "ratelimit", reason: name });
    return true;
  }
}

/** Throws `429 rate_limited` with `Retry-After` when the key is over its limit. */
export async function enforceRateLimit(env: LimiterEnv, name: LimiterName, key: string): Promise<void> {
  if (await checkRateLimit(env, name, key)) return;
  throw new AppError("rate_limited", undefined, undefined, {
    "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS),
  });
}
