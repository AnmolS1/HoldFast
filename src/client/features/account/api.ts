// The account's own API calls (routes/account.ts) and their query keys. Everything goes through
// `api()`, which names the account on every request (the identity pin) and reads the error
// envelope; the Better Auth endpoints go through ./auth-calls.ts.
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  ActivityDto,
  ExportManifest,
  PrefsDto,
  ProfileDto,
  SessionDto,
  type PatchPrefsBody,
  type PatchProfileBody,
} from "../../../shared/schemas/account";
import { ThumbUrlResponse } from "../../../shared/schemas/node";
import { api } from "../../lib/api";
import { listLinked, listPasskeys, readTwoFactorEnabled, type AuthOutcome } from "./auth-calls";

/** Every key starts with "account": nothing of it outlives the account (the purge empties the cache). */
export const accountKeys = {
  profile: ["account", "profile"] as const,
  prefs: ["account", "prefs"] as const,
  sessions: ["account", "sessions"] as const,
  activity: ["account", "activity"] as const,
  passkeys: ["account", "passkeys"] as const,
  linked: ["account", "linked"] as const,
  stepUp: ["account", "step-up"] as const,
  twoFactor: ["account", "two-factor"] as const,
};

export const profileQuery = queryOptions({
  queryKey: accountKeys.profile,
  queryFn: ({ signal }) => api("/api/account/profile", { schema: ProfileDto, signal }),
});

export function patchProfile(body: PatchProfileBody): Promise<ProfileDto> {
  return api("/api/account/profile", { method: "PATCH", body, schema: ProfileDto });
}

export const prefsQuery = queryOptions({
  queryKey: accountKeys.prefs,
  queryFn: ({ signal }) => api("/api/account/prefs", { schema: PrefsDto, signal }),
});

export function patchPrefs(body: PatchPrefsBody): Promise<PrefsDto> {
  return api("/api/account/prefs", { method: "PATCH", body, schema: PrefsDto });
}

/** Read when the Devices section is opened — never polled. */
export const sessionsQuery = queryOptions({
  queryKey: accountKeys.sessions,
  queryFn: ({ signal }) => api("/api/account/sessions", { schema: z.array(SessionDto), signal }),
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export const activityQuery = queryOptions({
  queryKey: accountKeys.activity,
  queryFn: ({ signal }) => api("/api/account/activity", { schema: z.array(ActivityDto), signal }),
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

export function revokeSession(id: string): Promise<void> {
  return api(`/api/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE", empty: true });
}

export function revokeOtherSessions(): Promise<{ revoked: number }> {
  return api("/api/account/sessions/revoke-others", {
    method: "POST",
    schema: z.object({ revoked: z.number().int().nonnegative() }),
  });
}

/** The export, checked against its contract before it is handed to the person. */
export function fetchExport(signal?: AbortSignal): Promise<ExportManifest> {
  return api("/api/account/export", { schema: ExportManifest, signal });
}

export function avatarUrl(userId: string, size: 160 | 320): Promise<ThumbUrlResponse> {
  return api(`/api/account/avatar-url/${encodeURIComponent(userId)}?size=${size}`, {
    schema: ThumbUrlResponse,
  });
}

/** T06's routes (routes/account-lifecycle.ts). The status itself is the shell's `deletionStatusQuery`. */
export function cancelDeletion(): Promise<void> {
  return api("/api/account/deletion/cancel", { method: "POST", empty: true, silent: ["conflict"] });
}

/** A Better Auth answer as a query's data; its failure is the query's error. */
async function unwrap<T>(call: Promise<AuthOutcome<T>>): Promise<T> {
  const result = await call;
  if (result.error) throw result.error;
  return result.data;
}

/** The sign-in methods linked to the account (`credential` = it has a password, `google`). */
export const linkedQuery = queryOptions({
  queryKey: accountKeys.linked,
  queryFn: () => unwrap(listLinked()),
  refetchOnWindowFocus: false,
});

export const passkeysQuery = queryOptions({
  queryKey: accountKeys.passkeys,
  queryFn: () => unwrap(listPasskeys()),
  refetchOnWindowFocus: false,
});

export const twoFactorQuery = queryOptions({
  queryKey: accountKeys.twoFactor,
  queryFn: async () => (await unwrap(readTwoFactorEnabled()))?.user?.twoFactorEnabled === true,
  refetchOnWindowFocus: false,
});
