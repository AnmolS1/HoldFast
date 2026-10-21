// The shell-wide Retry-After registry (lib/query.ts). A failure that names a wait (`Retry-After`)
// puts its query's hash in ONE account-scoped map; until the wait has passed, nothing refreshes that
// query by itself — not the tab coming back, not a reconnect, not a remount, and not the load a
// query with an error and no data gets on mount (`retryOnMount`, T19 r5-1). These are the QueryClient
// DEFAULTS: a query that spreads nothing of its own is covered.
import { focusManager, onlineManager, useQuery } from "@tanstack/react-query";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as oldPath from "../../../../src/client/features/starred/waits";
import { api } from "../../../../src/client/lib/api";
import {
  clearWaits,
  holdUntil,
  purgeUserState,
  queryClient,
  waitKey,
  waitUntil,
} from "../../../../src/client/lib/query";
import { envelope, json, mockFetch, renderShell, setupShell } from "./helpers";

setupShell();

afterEach(async () => {
  // Unmounted first: putting focus and the network back is itself a trigger (the client reacts a
  // microtask later), and a probe still mounted would read again into the next test.
  cleanup();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearWaits();
});

const KEY = ["retry-after-probe"] as const;

function Probe() {
  // Nothing of its own: only the client's defaults decide.
  useQuery({ queryKey: KEY, queryFn: ({ signal }) => api("/api/probe", { signal }) });
  return null;
}

const probeCalls = (calls: { path: string }[]) => calls.filter((call) => call.path === "/api/probe").length;

async function failWith(retryAfter: string | null) {
  let answer: () => Response = () =>
    envelope("rate_limited", 429, undefined, retryAfter === null ? {} : { "retry-after": retryAfter });
  const calls = mockFetch((call) => (call.path === "/api/probe" ? answer() : undefined));
  const view = renderShell(<Probe />);
  await waitFor(() => expect(queryClient.getQueryState(KEY)?.status).toBe("error"));
  return { calls, view, answerWith: (next: () => Response) => (answer = next) };
}

/** Every way a query is refreshed by itself, then a moment for a request to leave. */
async function everyAutomaticRefetch(remount: () => void) {
  act(() => focusManager.setFocused(false));
  act(() => focusManager.setFocused(true));
  act(() => onlineManager.setOnline(false));
  act(() => onlineManager.setOnline(true));
  remount();
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("lib/query: the Retry-After registry", () => {
  it("a 429 with Retry-After: 30 holds the query: focus, reconnect and a remount (no data, error state) ask nothing", async () => {
    const { calls, view } = await failWith("30");
    expect(probeCalls(calls)).toBe(1);
    const until = waitUntil(waitKey(KEY));
    expect(until).toBeGreaterThan(Date.now() + 25_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30_000);
    await everyAutomaticRefetch(() => {
      view.unmount();
      renderShell(<Probe />);
    });
    expect(probeCalls(calls)).toBe(1);
  });

  it("control: the same failure without Retry-After is read again by the same triggers", async () => {
    const { calls, view } = await failWith(null);
    expect(waitUntil(waitKey(KEY))).toBe(0);
    await everyAutomaticRefetch(() => {
      view.unmount();
      renderShell(<Probe />);
    });
    expect(probeCalls(calls)).toBeGreaterThan(1);
  });

  it("the wait ends by itself: after it has passed, the next trigger reads again", async () => {
    const { calls, answerWith } = await failWith("1");
    answerWith(() => json({ ok: true }));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probeCalls(calls)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(probeCalls(calls)).toBe(2));
    await waitFor(() => expect(queryClient.getQueryState(KEY)?.status).toBe("success"));
  });

  it("the waits are the account's: purgeUserState forgets them", async () => {
    holdUntil("some-hash", Date.now() + 60_000);
    expect(waitUntil("some-hash")).toBeGreaterThan(0);
    await purgeUserState({ keepSession: true });
    expect(waitUntil("some-hash")).toBe(0);
  });

  it("features/starred/waits.ts is the same registry (a re-export)", () => {
    expect(oldPath.holdUntil).toBe(holdUntil);
    expect(oldPath.waitUntil).toBe(waitUntil);
    expect(oldPath.clearWaits).toBe(clearWaits);
    expect(oldPath.waitKey).toBe(waitKey);
  });
});
