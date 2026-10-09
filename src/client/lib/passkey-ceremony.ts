// One passkey sign-in ceremony STARTS at a time.
//
// The sign-in screen has two: the conditional-UI request it starts when it mounts (passkeys in
// the email field's autofill) and the one the "Sign in with a passkey" button starts. Each is
// two steps inside the library (@better-auth/passkey/dist/client.mjs:7–25):
//   1. GET /passkey/generate-authenticate-options — the answer sets the challenge cookie;
//   2. `startAuthentication()` — which ABORTS whichever ceremony was running before it
//      (@simplewebauthn/browser's WebAuthnAbortService: one at a time).
// Started side by side they interleave: a click while the autofill request's step 1 is still in
// flight lets the button reach step 2 first — and when the autofill's step 1 then returns, ITS
// step 2 aborts the button's ceremony ("that passkey didn't work"), and the cookie holds whichever
// challenge arrived last. So a ceremony's step 1 does not begin until the one before it has
// reached step 2 (or ended): the later ceremony — the one the person just asked for — is then
// always the one that survives, with its own challenge in the cookie.

export type CeremonyQueue = {
  /** Runs `start` once every earlier ceremony has got its options (or ended). */
  run<T>(start: () => Promise<T>): Promise<T>;
  /** The options request of the ceremony now starting has been answered. */
  optionsArrived(): void;
};

export function createCeremonyQueue(): CeremonyQueue {
  let last: Promise<void> = Promise.resolve();
  let reached: (() => void) | null = null;
  return {
    run(start) {
      const before = last;
      let done!: () => void;
      last = new Promise<void>((resolve) => (done = resolve));
      return before.then(() => {
        reached = done;
        const call = start();
        // Ended without ever getting options (offline, an error): the next one may go.
        void call.then(done, done);
        return call;
      });
    },
    optionsArrived() {
      const done = reached;
      reached = null;
      // A task later: by then the library has moved on from the answer into `startAuthentication`.
      if (done) setTimeout(done, 0);
    },
  };
}

export const OPTIONS_PATH = "/passkey/generate-authenticate-options";
export const passkeyCeremonies = createCeremonyQueue();
