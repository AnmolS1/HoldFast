// The console's step-up (R-g). An admin route answers `403 admin_requires_2fa` when the account
// has no second factor OR when THIS session has not passed one within 12 h (signed in with Google,
// a passkey without user verification, or long ago). `withStepUp(request)` turns the second case
// into a prompt for a code (StepUp.tsx) and then sends THAT request once more; nothing else is
// replayed, and nothing is replayed into another account (the epoch is checked).
//
// Several requests refused at once share ONE prompt. An account change answers every open prompt
// "not passed" (the purger below) — the code was the previous account's.
import { useSyncExternalStore } from "react";
import { ApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, sameAccount, waitKey } from "../../lib/query";

/** Where the step-up's throttle wait is held (lib/query.ts registry, account-scoped). */
export const STEP_UP_WAIT = waitKey(["admin", "step-up"]);

type Pending = { promise: Promise<boolean>; settle(passed: boolean): void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
/** Whether a provider is mounted to show the prompt (none in a test of the calls alone). */
let providers = 0;

export function isStepUpRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.code === "admin_requires_2fa";
}

function ask(): Promise<boolean> {
  if (providers === 0) return Promise.resolve(false);
  if (pending) return pending.promise;
  let settle!: (passed: boolean) => void;
  const promise = new Promise<boolean>((resolve) => (settle = resolve));
  pending = {
    promise,
    settle(passed) {
      pending = null;
      emit();
      settle(passed);
    },
  };
  emit();
  return promise;
}

/** The provider's answer to the open prompt. */
export function answerStepUp(passed: boolean): void {
  pending?.settle(passed);
}

/** The request; on `admin_requires_2fa` the prompt, then the SAME request once more. */
export async function withStepUp<T>(request: () => Promise<T>): Promise<T> {
  const then = accountEpoch();
  try {
    return await request();
  } catch (error) {
    if (!isStepUpRefusal(error)) throw error;
    const passed = await ask();
    // Given up, or the account changed meanwhile: the refusal stands; nothing is sent again.
    if (!passed || !sameAccount(then)) throw error;
    return request();
  }
}

/** Whether a prompt is open (re-rendered on change). */
export function useStepUpOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending !== null,
    () => false,
  );
}

/** Mounted by StepUpProvider. */
export function registerStepUpProvider(): () => void {
  providers += 1;
  return () => {
    providers -= 1;
  };
}

registerUserStatePurger(() => {
  pending?.settle(false);
});
