// The preferences sync the account feature registers (features/account/prefs-sync.ts): the server
// copy wins at sign-in, changes are saved debounced (one PATCH per burst), and an account change
// while a save is pending drops it — nothing of account A is saved as B.
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrefsSync, startPrefsSync } from "../../../../src/client/features/account/prefs-sync";
import { getPrefs, setPrefs, SYNC_DEBOUNCE_MS } from "../../../../src/client/lib/prefs";
import { purgeUserState, queryClient, sessionQuery } from "../../../../src/client/lib/query";
import { IDENTITY_HEADER } from "../../../../src/client/lib/api";
import { json, mockFetch, sessionOf, setupShell, type MockCall } from "../shell/helpers";

setupShell();

const A = "a".repeat(32);
const B = "b".repeat(32);

const prefsOf = (patch: Record<string, unknown>) => ({
  density: "compact",
  theme: "system",
  viewMode: "list",
  emailShares: true,
  emailLinkDigest: true,
  emailSecurity: true,
  ...patch,
});

/** The server: each account's own prefs; a PATCH writes them. */
function server(start: Record<string, Record<string, unknown>>) {
  const stored = new Map(Object.entries(start).map(([id, patch]) => [id, prefsOf(patch)]));
  const calls = mockFetch((call: MockCall) => {
    if (call.path === "/api/auth/get-session")
      return json(
        browserSession
          ? sessionOf({ id: browserSession, email: `${browserSession.slice(0, 4)}@example.com` })
          : null,
      );
    const who = new Headers(call.headers).get(IDENTITY_HEADER) ?? "";
    if (call.path === "/api/account/prefs" && call.method === "GET") return json(stored.get(who));
    if (call.path === "/api/account/prefs" && call.method === "PATCH") {
      const next = { ...stored.get(who)!, ...(call.body as object) };
      stored.set(who, next);
      return json(next);
    }
    return undefined;
  });
  return { calls, stored };
}

let browserSession: string | null = null;

/** The browser is signed in as `id` now, and the shell reads its session (lib/query.ts). */
async function signedInAs(id: string) {
  browserSession = id;
  await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

const patches = (calls: MockCall[]) => calls.filter((call) => call.method === "PATCH");

beforeEach(() => {
  browserSession = null;
  resetPrefsSync();
  startPrefsSync();
});

describe("the preferences sync", () => {
  it("at sign-in the server copy wins over the device's", async () => {
    setPrefs({ theme: "light", density: "compact", viewMode: "list" });
    const { calls } = server({ [A]: { theme: "dark", density: "comfortable", viewMode: "grid" } });
    await signedInAs(A);
    await waitFor(() =>
      expect(getPrefs()).toEqual({ theme: "dark", density: "comfortable", viewMode: "grid" }),
    );
    expect(calls.filter((call) => call.path === "/api/account/prefs")).toHaveLength(1);
    // Loading the server copy writes nothing back.
    expect(patches(calls)).toEqual([]);
  });

  it("a burst of changes is ONE debounced PATCH, of the last values, for the signed-in account", async () => {
    const { calls } = server({ [A]: {} });
    await signedInAs(A);
    await waitFor(() => expect(calls.some((call) => call.path === "/api/account/prefs")).toBe(true));
    vi.useFakeTimers();
    setPrefs({ theme: "dark" });
    setPrefs({ density: "comfortable" });
    setPrefs({ viewMode: "grid" });
    setPrefs({ theme: "light" });
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1);
    expect(patches(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).toEqual({ theme: "light", density: "comfortable", viewMode: "grid" });
    expect(new Headers(patches(calls)[0]!.headers).get(IDENTITY_HEADER)).toBe(A);
  });

  it("an account change while a save is pending: A's save is dropped, the sync is registered for B and B's copy wins", async () => {
    const { calls, stored } = server({
      [A]: {},
      [B]: { theme: "dark", density: "compact", viewMode: "grid" },
    });
    await signedInAs(A);
    await waitFor(() => expect(calls.some((call) => call.path === "/api/account/prefs")).toBe(true));
    vi.useFakeTimers();
    setPrefs({ theme: "light", density: "comfortable" });
    // Another account is adopted before the debounce ends (the purge runs first).
    await signedInAs(B);
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 3);
    vi.useRealTimers();
    await waitFor(() => expect(getPrefs()).toEqual({ theme: "dark", density: "compact", viewMode: "grid" }));
    expect(patches(calls)).toEqual([]);
    expect(stored.get(B)).toMatchObject({ theme: "dark", viewMode: "grid" });
    const reads = calls
      .filter((call) => call.path === "/api/account/prefs")
      .map((call) => new Headers(call.headers).get(IDENTITY_HEADER));
    expect(reads).toEqual([A, B]);
    // From now on a change is B's, saved as B.
    setPrefs({ density: "comfortable" });
    await waitFor(() => expect(patches(calls)).toHaveLength(1), { timeout: SYNC_DEBOUNCE_MS * 4 });
    expect(new Headers(patches(calls)[0]!.headers).get(IDENTITY_HEADER)).toBe(B);
  });

  it("a session read as nobody (signed out without a purge) neither registers nor drops the sync", async () => {
    const { calls } = server({ [A]: {} });
    await signedInAs(A);
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/account/prefs")).toHaveLength(1));
    // The session read as nobody (it ended; no purge yet), then the same account again.
    browserSession = null;
    await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    await signedInAs(A);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((call) => call.path === "/api/account/prefs")).toHaveLength(1);
  });

  it("a sign-out purges the sync; signing in again — as the same account — registers it again and loads the server copy", async () => {
    const { calls } = server({ [A]: { theme: "dark" } });
    await signedInAs(A);
    await waitFor(() => expect(getPrefs().theme).toBe("dark"));
    await purgeUserState();
    setPrefs({ theme: "light" });
    await new Promise((resolve) => setTimeout(resolve, SYNC_DEBOUNCE_MS + 50));
    // Signed out: nothing is saved for anybody.
    expect(patches(calls)).toEqual([]);
    await signedInAs(A);
    await waitFor(() => expect(getPrefs().theme).toBe("dark"));
    expect(calls.filter((call) => call.path === "/api/account/prefs" && call.method === "GET")).toHaveLength(
      2,
    );
    setPrefs({ viewMode: "grid" });
    await waitFor(() => expect(patches(calls)).toHaveLength(1), { timeout: SYNC_DEBOUNCE_MS * 4 });
  });
});

describe("what the sync follows", () => {
  it("a session written into the cache by hand (a seed, a sign-out's null) registers nothing", async () => {
    const { calls } = server({ [A]: {} });
    queryClient.setQueryData(sessionQuery.queryKey, sessionOf({ id: A }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });
});
