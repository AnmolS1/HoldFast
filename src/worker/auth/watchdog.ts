// The watchdog for Better Auth issue #10315 — detection, not cure.
//
// On a deployed Worker a module-scope promise that an aborted request left pending never settles,
// and every later request in that isolate would wait on it for ever. The mitigation is
// auth/als-preseed.ts; this makes anything that still hangs VISIBLE: the call is raced against a
// timer, and a hang is answered `503` with `Retry-After`, counted (`auth` / `hang`) and reported.
//
// EVERY call into Better Auth that a request makes goes through `watched()`:
//   - the session read of middleware/session.ts — the first Better Auth call of every /api/*
//     request, before any route runs (a hang there would take every API route down, not only
//     /api/auth/*);
//   - `auth.handler()` in routes/auth.ts.
// tests/unit/auth/watchdog.test.ts holds both to it with a real hang, and a source scan there
// fails when a new `.api.` call or `.handler(` call appears outside these two places.

import type { Context } from "hono";
import { INTERNAL_ERROR } from "../../shared/errors";
import type { AppEnv } from "../services/request-context";
import { countFor, reportError } from "./observe";

/** How long a call into Better Auth may take before the request is answered 503. */
export const AUTH_WATCHDOG_MS = 10_000;

let watchdogMs = AUTH_WATCHDOG_MS;
/** Tests only: a 10-second wait cannot be part of a unit test. Returns the function that restores it. */
export function setAuthWatchdogForTests(ms: number): () => void {
  watchdogMs = ms;
  return () => {
    watchdogMs = AUTH_WATCHDOG_MS;
  };
}

export const HANG = Symbol("Better Auth did not answer in time");

/** `work`'s result — or `HANG` when it has not settled within the limit. Never rejects because of the timer. */
export async function watched<T>(work: Promise<T>): Promise<T | typeof HANG> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof HANG>((resolve) => {
    timer = setTimeout(() => resolve(HANG), watchdogMs);
  });
  // The loser of the race must not become an unhandled rejection.
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer to a hang: counted, reported, `503` + `Retry-After`. `where` is a constant. */
export function hungAnswer(c: Context<AppEnv>, where: "session" | "handler"): Response {
  countFor(c.env, "auth", { outcome: "hang", kind: where });
  reportError(new Error(`Better Auth did not answer within 10 s (${where})`), { kind: "auth_hang" });
  return c.json(
    { error: INTERNAL_ERROR, message: "Sign-in is not available right now.", requestId: c.get("requestId") },
    503,
    { "Retry-After": "30" },
  );
}
