// The Better Auth calls the console makes, through `betterAuthClient` (lib/auth-client.ts — the
// identity pin rides on it). The admin plugin is reached through EXACTLY the five allow-listed
// paths (T06 `ADMIN_PLUGIN_ALLOWED`): ban-user, unban-user, set-role, impersonate-user,
// stop-impersonating — nothing else of the plugin, ever. The step-up's two verify calls are the
// two-factor plugin's.
//
// Each call answers `{ data } | { error }` and never throws; a `Retry-After` is read from the
// failed response itself.
import { betterAuthClient } from "../../lib/auth-client";

export interface AuthFailure {
  status: number;
  code?: string;
  message?: string;
  retryAfter?: number;
}

export type AuthOutcome<T> = { data: T; error: null } | { data: null; error: AuthFailure };

export const SECOND_FACTOR_THROTTLED = "SECOND_FACTOR_THROTTLED";

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

type Raw = { data: unknown; error: unknown };
type FetchOptions = { onError(context: { response: Response }): void };

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

// ── the admin plugin: the five allow-listed paths ──────────────────────────────────────────

/** `/admin/ban-user`. `banExpiresIn` in seconds; absent = no expiry. */
export const banUser = (userId: string, banReason: string, banExpiresIn?: number) =>
  call(
    (fetchOptions) =>
      betterAuthClient.admin.banUser({
        userId,
        banReason,
        ...(banExpiresIn ? { banExpiresIn } : {}),
        fetchOptions,
      }) as Promise<Raw>,
  );

/** `/admin/unban-user`. */
export const unbanUser = (userId: string) =>
  call((fetchOptions) => betterAuthClient.admin.unbanUser({ userId, fetchOptions }) as Promise<Raw>);

/** `/admin/set-role`. */
export const setRole = (userId: string, role: "user" | "admin") =>
  call((fetchOptions) => betterAuthClient.admin.setRole({ userId, role, fetchOptions }) as Promise<Raw>);

/** `/admin/impersonate-user`: a 15-minute, read-only session as the account. */
export const impersonateUser = (userId: string) =>
  call((fetchOptions) => betterAuthClient.admin.impersonateUser({ userId, fetchOptions }) as Promise<Raw>);

/** `/admin/stop-impersonating`, from the impersonated session. */
export const stopImpersonating = () =>
  call((fetchOptions) => betterAuthClient.admin.stopImpersonating({ fetchOptions }) as Promise<Raw>);

// ── the step-up: a code sent BY this session marks it as having passed the second factor ──

export const verifyTotp = (code: string) =>
  call((fetchOptions) => betterAuthClient.twoFactor.verifyTotp({ code, fetchOptions }) as Promise<Raw>);

export const verifyBackupCode = (code: string) =>
  call((fetchOptions) => betterAuthClient.twoFactor.verifyBackupCode({ code, fetchOptions }) as Promise<Raw>);
