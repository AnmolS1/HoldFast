// The Better Auth endpoints the account screens call — password, address, passkeys, two-factor,
// linked sign-in methods, the deletion request — through `betterAuthClient` (lib/auth-client.ts),
// which names the account on every request (the identity pin) like `api()` does. Never a raw
// `fetch` to /api.
//
// Each call answers `{ data } | { error }` and never throws. The library's error carries no
// headers, so `Retry-After` is read here from the failed response itself (better-fetch hands
// `onError` the response) — a `429` is waited out through lib/query.ts's registry, never retried.
//
// `password` travels in the body where the server asks for the owner again (auth/mailbox-proof.ts
// REAUTH_PATHS: change of address, link and unlink of Google, rename and removal of a passkey that
// counts as a second factor). The library's proxy sends every field it is given.
import { betterAuthClient } from "../../lib/auth-client";

export interface AuthFailure {
  status: number;
  /** Better Auth's code ("INVALID_PASSWORD", "SECOND_FACTOR_REQUIRED", …) or ours ("NETWORK"). */
  code?: string;
  message?: string;
  /** Seconds, from `Retry-After`. */
  retryAfter?: number;
}

export type AuthOutcome<T> = { data: T; error: null } | { data: null; error: AuthFailure };

/** The codes the account screens answer in their own words. */
export const AUTH_CODES = {
  invalidPassword: "INVALID_PASSWORD",
  sessionNotFresh: "SESSION_NOT_FRESH",
  secondFactorRequired: "SECOND_FACTOR_REQUIRED",
  secondFactorThrottled: "SECOND_FACTOR_THROTTLED",
  compromised: "PASSWORD_COMPROMISED",
  unlinkNotAvailable: "UNLINK_NOT_AVAILABLE",
  lastAccount: "FAILED_TO_UNLINK_LAST_ACCOUNT",
} as const;

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

type Raw = { data: unknown; error: unknown };
type FetchOptions = { onError(context: { response: Response }): void };

/**
 * Runs one call. `run` is handed the fetch options to pass to the library (they read the
 * response's `Retry-After`).
 */
async function call<T>(run: (fetchOptions: FetchOptions) => Promise<Raw>): Promise<AuthOutcome<T>> {
  let retryAfter: number | undefined;
  const fetchOptions: FetchOptions = {
    onError(context) {
      retryAfter = parseRetryAfter(context.response.headers.get("retry-after"));
    },
  };
  let raw: Raw;
  try {
    raw = await run(fetchOptions);
  } catch (cause) {
    return {
      data: null,
      error: { status: 0, code: "NETWORK", message: cause instanceof Error ? cause.message : undefined },
    };
  }
  if (raw.error) {
    const error = raw.error as { status?: unknown; code?: unknown; message?: unknown };
    return {
      data: null,
      error: {
        status: typeof error.status === "number" ? error.status : 0,
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : undefined,
        retryAfter,
      },
    };
  }
  return { data: (raw.data ?? {}) as T, error: null };
}

// The library's typed inputs do not all name `password`; its proxy sends every field given.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = betterAuthClient as any;

// ── password and address ────────────────────────────────────────────────────────────────────

export const changePassword = (input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions: boolean;
}) => call((fetchOptions) => client.changePassword({ ...input, fetchOptions }));

/** The confirmation goes to the CURRENT address first; `password` where the account has one. */
export const changeEmail = (input: { newEmail: string; password?: string }) =>
  call((fetchOptions) => client.changeEmail({ ...input, callbackURL: "/account", fetchOptions }));

// ── passkeys ────────────────────────────────────────────────────────────────────────────────

export interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt: string | Date;
  deviceType?: string;
}

export const listPasskeys = () =>
  call<PasskeyRow[]>((fetchOptions) => client.passkey.listUserPasskeys({ fetchOptions }));

/** The browser's own ceremony (the platform's dialog); the name is the one typed. */
export const addPasskey = (name: string) =>
  call((fetchOptions) => client.passkey.addPasskey({ name, fetchOptions }));

export const renamePasskey = (input: { id: string; name: string; password?: string }) =>
  call((fetchOptions) => client.passkey.updatePasskey({ ...input, fetchOptions }));

export const deletePasskey = (input: { id: string; password?: string }) =>
  call((fetchOptions) => client.passkey.deletePasskey({ ...input, fetchOptions }));

// ── two-factor ──────────────────────────────────────────────────────────────────────────────

/**
 * Whether the account has two-factor on: Better Auth's session answer carries it (the shell's own
 * session shape does not keep the field).
 */
export const readTwoFactorEnabled = () =>
  call<{ user?: { twoFactorEnabled?: boolean | null } } | null>((fetchOptions) =>
    client.getSession({ query: { disableCookieCache: true }, fetchOptions }),
  );

/** The first enrolment: the password; answers the otpauth URI and the backup codes. */
export const enableTwoFactor = (password: string) =>
  call<{ totpURI: string; backupCodes: string[] }>((fetchOptions) =>
    client.twoFactor.enable({ password, fetchOptions }),
  );

/**
 * Confirms an enrolment, or steps the session up. Sent BY a session, Better Auth never sets the
 * trusted-device cookie (plugins/two-factor/verify-two-factor.mjs: `trustDevice` is read on the
 * sign-in challenge only) — the 30-day option is on the shell's sign-in code screen.
 */
export const verifyTotp = (code: string) =>
  call((fetchOptions) => client.twoFactor.verifyTotp({ code, fetchOptions }));

/** The base32 secret of an otpauth:// URI, for typing in by hand. */
export function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export const verifyBackupCode = (code: string) =>
  call((fetchOptions) => client.twoFactor.verifyBackupCode({ code, fetchOptions }));

export const generateBackupCodes = (password: string) =>
  call<{ backupCodes: string[] }>((fetchOptions) =>
    client.twoFactor.generateBackupCodes({ password, fetchOptions }),
  );

export const disableTwoFactor = (password: string) =>
  call((fetchOptions) => client.twoFactor.disable({ password, fetchOptions }));

// ── linked sign-in methods ──────────────────────────────────────────────────────────────────

export interface LinkedAccount {
  /** The `account` row id: what unlink takes. */
  id: string;
  providerId: string;
}

export const listLinked = () =>
  call<LinkedAccount[]>((fetchOptions) => client.listAccounts({ fetchOptions }));

/**
 * Asks for Google's consent-screen address (`url`). The browser is NOT sent there by the library
 * (`disableRedirect`): the caller does it, once it knows the account has not changed meanwhile.
 */
export const linkGoogle = (password?: string) =>
  call<{ url?: string }>((fetchOptions) =>
    client.linkSocial({
      provider: "google",
      callbackURL: "/account/security",
      errorCallbackURL: "/account/security",
      disableRedirect: true,
      ...(password ? { password } : {}),
      fetchOptions,
    }),
  );

export const unlinkAccount = (input: { accountId: string; password?: string }) =>
  call((fetchOptions) => client.unlinkAccount({ ...input, fetchOptions }));

// ── deletion ────────────────────────────────────────────────────────────────────────────────

/** Mails the confirmation link (T06's veto schedules instead of deleting when it is followed). */
export const requestDeletion = () => call((fetchOptions) => client.deleteUser({ fetchOptions }));
