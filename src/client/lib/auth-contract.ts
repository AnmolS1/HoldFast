// The auth methods the shell calls. Names and argument shapes are those of the Better Auth 1.7.7
// React client (`createAuthClient` from "better-auth/react") with `passkeyClient()` from
// "@better-auth/passkey/client" and `twoFactorClient()` / `adminClient()` from
// "better-auth/client/plugins"; the real client must satisfy this interface.
//
// The session itself is NOT read through this interface: the shell reads
// `GET /api/auth/get-session` with its own query (lib/query.ts), so route loaders, the API
// client and components share one cached answer.

export interface AuthError {
  message?: string;
  status: number;
  statusText: string;
  code?: string;
}

export type AuthResult<T = unknown> = { data: T; error: null } | { data: null; error: AuthError };

export interface AuthFetchOptions {
  /** The Turnstile token travels as `x-captcha-response`. */
  headers?: Record<string, string>;
}

export interface SignInEmailInput {
  email: string;
  password: string;
  rememberMe?: boolean;
  callbackURL?: string;
  fetchOptions?: AuthFetchOptions;
}

export interface SignUpEmailInput {
  name: string;
  email: string;
  password: string;
  callbackURL?: string;
  /** Sign-up policy fields read by the server's `beforeUserCreate`. The birth date is not stored. */
  inviteCode?: string;
  birthYear: number;
  birthMonth: number;
  acceptTerms: boolean;
  fetchOptions?: AuthFetchOptions;
}

export interface AuthClientContract {
  signIn: {
    /** `data.twoFactorRedirect` is true when a second factor is required. */
    email(
      input: SignInEmailInput,
    ): Promise<AuthResult<{ twoFactorRedirect?: boolean } | Record<string, unknown>>>;
    social(input: {
      provider: "google";
      callbackURL?: string;
      errorCallbackURL?: string;
    }): Promise<AuthResult>;
    /** `autoFill: true` starts conditional UI (the browser offers passkeys in the email field). */
    passkey(input?: { autoFill?: boolean }): Promise<AuthResult>;
  };
  signUp: {
    email(input: SignUpEmailInput): Promise<AuthResult>;
  };
  signOut(): Promise<AuthResult>;
  sendVerificationEmail(input: {
    email: string;
    callbackURL?: string;
    fetchOptions?: AuthFetchOptions;
  }): Promise<AuthResult>;
  requestPasswordReset(input: {
    email: string;
    redirectTo?: string;
    fetchOptions?: AuthFetchOptions;
  }): Promise<AuthResult>;
  resetPassword(input: { newPassword: string; token: string }): Promise<AuthResult>;
  twoFactor: {
    verifyTotp(input: { code: string; trustDevice?: boolean }): Promise<AuthResult>;
    verifyBackupCode(input: { code: string; trustDevice?: boolean }): Promise<AuthResult>;
  };
  admin: {
    stopImpersonating(): Promise<AuthResult>;
  };
}

export const AUTH_NOT_WIRED = "auth not wired";
export const CAPTCHA_HEADER = "x-captcha-response";

/** Run an auth call; a rejection (the placeholder client, a network failure) becomes an error result. */
export async function callAuth<T>(call: () => Promise<AuthResult<T>>): Promise<AuthResult<T>> {
  try {
    return await call();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      data: null,
      error: {
        status: 0,
        statusText: "",
        message,
        code: message === AUTH_NOT_WIRED ? "NOT_WIRED" : "NETWORK",
      },
    };
  }
}
