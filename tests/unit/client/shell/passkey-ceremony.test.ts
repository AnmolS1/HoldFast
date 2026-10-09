// T0 — the sign-in screen starts two passkey ceremonies (autofill on mount, the button), and the
// library runs each as "fetch options, then startAuthentication — which aborts the one before".
// Started side by side they abort the wrong one; src/client/lib/passkey-ceremony.ts sequences them.
//
// The library's two steps are modelled exactly as @better-auth/passkey/dist/client.mjs:7–25 runs
// them, over a fake network (each options request answers after its own delay) and a fake
// authenticator with simplewebauthn's rule: starting a ceremony aborts the one in progress.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCeremonyQueue, type CeremonyQueue } from "../../../../src/client/lib/passkey-ceremony";

type Outcome = { who: string; result: "signed-in" | "aborted" | "no-options"; challenge?: string };

function world(queue: CeremonyQueue | null) {
  const log: string[] = [];
  let cookie = "";
  let current: { who: string; abort(): void } | null = null;

  /** Step 1: the options request; its answer sets the challenge cookie. */
  const fetchOptions = async (who: string, ms: number, fail = false) => {
    log.push(`${who}: options requested`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (fail) {
      log.push(`${who}: options failed`);
      return null;
    }
    cookie = `challenge-of-${who}`;
    log.push(`${who}: options arrived`);
    queue?.optionsArrived();
    return { challenge: `challenge-of-${who}` };
  };

  /** Step 2: one ceremony at a time — starting one aborts the one in progress. */
  const startAuthentication = (who: string, challenge: string, userActsAfter: number | null) =>
    new Promise<string>((resolve, reject) => {
      current?.abort();
      log.push(`${who}: ceremony started`);
      const timer = userActsAfter === null ? null : setTimeout(() => resolve(challenge), userActsAfter);
      current = {
        who,
        abort() {
          if (timer) clearTimeout(timer);
          log.push(`${who}: ceremony aborted`);
          reject(new Error("AbortError"));
        },
      };
    });

  /** The library's sign-in, step for step. */
  const signIn = (who: string, optionsMs: number, userActsAfter: number | null, fail = false) => {
    const start = async (): Promise<Outcome> => {
      const options = await fetchOptions(who, optionsMs, fail);
      if (!options) return { who, result: "no-options" };
      try {
        const signed = await startAuthentication(who, options.challenge, userActsAfter);
        // The server checks the signed challenge against the cookie's.
        return signed === cookie
          ? { who, result: "signed-in", challenge: signed }
          : { who, result: "aborted" };
      } catch {
        return { who, result: "aborted" };
      }
    };
    return queue ? queue.run(start) : start();
  };
  return { log, signIn };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

async function settle<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

describe("a click on the passkey button while the autofill request is still fetching its options", () => {
  it("the control — side by side, the autofill ceremony aborts the one the person asked for", async () => {
    const { log, signIn } = world(null);
    // Autofill: slow options (200 ms), and nobody ever picks from the autofill list.
    const autofill = signIn("autofill", 200, null);
    // The click, 50 ms in: fast options (20 ms); the person confirms 500 ms after the prompt.
    await vi.advanceTimersByTimeAsync(50);
    const button = signIn("button", 20, 500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await button).toEqual({ who: "button", result: "aborted" });
    expect(log).toEqual([
      "autofill: options requested",
      "button: options requested",
      "button: options arrived",
      "button: ceremony started",
      "autofill: options arrived",
      "button: ceremony aborted",
      "autofill: ceremony started",
    ]);
    void autofill;
  });

  it("sequenced: the button's ceremony starts after the autofill's, survives, and signs in with its own challenge", async () => {
    const { log, signIn } = world(createCeremonyQueue());
    const autofill = signIn("autofill", 200, null);
    await vi.advanceTimersByTimeAsync(50);
    const button = signIn("button", 20, 500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await button).toEqual({ who: "button", result: "signed-in", challenge: "challenge-of-button" });
    expect(await autofill).toEqual({ who: "autofill", result: "aborted" });
    expect(log).toEqual([
      "autofill: options requested",
      "autofill: options arrived",
      "autofill: ceremony started",
      "button: options requested",
      "button: options arrived",
      "autofill: ceremony aborted",
      "button: ceremony started",
    ]);
  });

  it("whatever the two delays are, the ceremony asked for LAST is the one that signs in", async () => {
    for (const [autofillMs, clickAt, buttonMs] of [
      [0, 0, 0],
      [5, 0, 300],
      [300, 0, 5],
      [300, 299, 0],
      [300, 301, 0],
      [50, 500, 50],
    ] as const) {
      const { signIn } = world(createCeremonyQueue());
      const autofill = signIn("autofill", autofillMs, null);
      await vi.advanceTimersByTimeAsync(clickAt);
      const button = signIn("button", buttonMs, 100);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await button, `${autofillMs}/${clickAt}/${buttonMs}`).toMatchObject({ result: "signed-in" });
      void autofill;
    }
  });

  it("a ceremony that never gets options (offline) does not hold up the next one", async () => {
    const { signIn } = world(createCeremonyQueue());
    const autofill = signIn("autofill", 100, null, true);
    const button = signIn("button", 10, 50);
    expect(await settle(button)).toMatchObject({ result: "signed-in" });
    expect(await autofill).toEqual({ who: "autofill", result: "no-options" });
  });

  it("an answer that arrives with nothing waiting changes nothing", async () => {
    const queue = createCeremonyQueue();
    queue.optionsArrived();
    expect(await settle(queue.run(async () => "ran"))).toBe("ran");
  });
});
