// The Better Auth client: the one object the shell calls for sign-in, sign-up, sign-out, email
// verification, password reset, the second factor and impersonation.
//
// `authClient` is a PLAIN object with exactly the methods of `AuthClientContract`
// (lib/auth-contract.ts); each delegates to the Better Auth client below. A plain object, not
// the library's proxy, so that the contract is checked by the compiler and a test can spy on a
// method. `betterAuthClient` is the library's own client, for the screens that need more than
// the contract (passkey management, two-factor set-up, change of password or address).
//
// The session cookie is HttpOnly and is never visible here. Nothing in this module writes to Web
// Storage: Better Auth's client would post a "session changed" note for other tabs through it
// when its own session store is in use — that channel is replaced below with one that does
// nothing (the shell reads the session with its own query, and re-reads it on focus).
//
// The session is NOT read through this client: lib/query.ts reads `GET /api/auth/get-session`
// itself, so loaders, the API client and components share one cached answer. Should anything
// ever use the library's own session store, `purgeUserState()` empties it with everything else.
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { adminClient, inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins";
import type { AuthClientContract, AuthError, AuthResult } from "./auth-contract";
import { registerUserStatePurger } from "./contracts";
import { OPTIONS_PATH, passkeyCeremonies } from "./passkey-ceremony";

// Before the client exists: no cross-tab note is ever written anywhere.
const SILENT_CHANNEL = {
  post() {},
  subscribe: () => () => {},
  setup: () => () => {},
};
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("better-auth:broadcast-channel")] =
  SILENT_CHANNEL;

export const betterAuthClient = createAuthClient({
  // Same origin, the Worker's /api/auth. No token is handled by this client: the browser sends
  // the HttpOnly cookie itself.
  basePath: "/api/auth",
  fetchOptions: {
    // Tells the ceremony queue that a passkey sign-in has its options (lib/passkey-ceremony.ts).
    onResponse(context) {
      if (new URL(context.response.url, window.location.origin).pathname.endsWith(OPTIONS_PATH)) {
        passkeyCeremonies.optionsArrived();
      }
    },
  },
  plugins: [
    passkeyClient(),
    twoFactorClient(),
    adminClient(),
    // What the sign-up form states besides name, email and password. The server reads these
    // from the request body (services/signup-policy.ts); none of them is stored as given.
    inferAdditionalFields({
      user: {
        inviteCode: { type: "string", required: false },
        birthYear: { type: "number", required: true },
        birthMonth: { type: "number", required: true },
        acceptTerms: { type: "boolean", required: true },
      },
    }),
  ],
});

type RawResult = { data: unknown; error: unknown };

/** The library's `{ data, error }` as the contract's result. */
function result<T>(raw: RawResult): AuthResult<T> {
  if (raw.error) {
    const error = raw.error as Partial<AuthError>;
    return {
      data: null,
      error: {
        status: typeof error.status === "number" ? error.status : 0,
        statusText: typeof error.statusText === "string" ? error.statusText : "",
        message: typeof error.message === "string" ? error.message : undefined,
        code: typeof error.code === "string" ? error.code : undefined,
      },
    };
  }
  return { data: (raw.data ?? {}) as T, error: null };
}

const run = async <T = unknown>(call: Promise<RawResult>): Promise<AuthResult<T>> => result<T>(await call);

export const authClient: AuthClientContract = {
  signIn: {
    email: (input) => run(betterAuthClient.signIn.email(input)),
    social: (input) => run(betterAuthClient.signIn.social(input)),
    // One ceremony starts at a time: the autofill request and the button would otherwise abort
    // each other (lib/passkey-ceremony.ts).
    passkey: (input) =>
      passkeyCeremonies.run(() => run(betterAuthClient.signIn.passkey(input) as Promise<RawResult>)),
  },
  signUp: {
    email: (input) => run(betterAuthClient.signUp.email(input)),
  },
  signOut: () => run(betterAuthClient.signOut()),
  sendVerificationEmail: (input) => run(betterAuthClient.sendVerificationEmail(input)),
  requestPasswordReset: (input) => run(betterAuthClient.requestPasswordReset(input)),
  resetPassword: (input) => run(betterAuthClient.resetPassword(input)),
  twoFactor: {
    verifyTotp: (input) => run(betterAuthClient.twoFactor.verifyTotp(input)),
    verifyBackupCode: (input) => run(betterAuthClient.twoFactor.verifyBackupCode(input)),
  },
  admin: {
    stopImpersonating: () => run(betterAuthClient.admin.stopImpersonating()),
  },
};

// The library keeps a session store of its own (unused by the shell). If anything ever fills it,
// it is user-scoped state like any other: emptied on sign-out and on every change of identity.
registerUserStatePurger(() => {
  try {
    const store = (
      betterAuthClient as unknown as {
        $store?: { atoms?: Record<string, { get(): unknown; set(value: unknown): void } | undefined> };
      }
    ).$store;
    const session = store?.atoms?.session;
    if (session) session.set({ ...(session.get() as object), data: null, error: null, isPending: false });
  } catch {
    // Nothing to empty.
  }
});
