// W2S4, the identity pin, client half (lib/api.ts): every API request names the account this
// client's state belongs to; a request the API refuses because the browser's session is another
// account (another tab signed in since) is never replayed and says nothing — the client purges,
// adopts the account the session now names, and starts again at `/`.
import { beforeEach, describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { api, configureApi, IDENTITY_HEADER, toastApiError } from "../../../../src/client/lib/api";
import type { SessionShape } from "../../../../src/client/lib/contracts";
import {
  accountEpoch,
  adoptIdentity,
  getKnownUserId,
  queryClient,
  sameAccount,
} from "../../../../src/client/lib/query";
import { envelope, json, mockFetch, sessionOf, setupShell, type MockCall } from "./helpers";

setupShell();

const ALICE = sessionOf({ id: "a".repeat(32), name: "Alice", email: "alice@example.com" });
const BOB = sessionOf({ id: "b".repeat(32), name: "Bob", email: "bob@example.com" });
const MISMATCH = () => envelope("forbidden", 403, { reason: "identity_mismatch" });

let navigated: string[];
let browser: SessionShape;

beforeEach(async () => {
  navigated = [];
  browser = ALICE;
  configureApi({ navigate: (to) => void navigated.push(to) });
  queryClient.setQueryData(["session"], ALICE);
  await adoptIdentity(ALICE);
});

const pinOf = (call: MockCall) => call.headers[IDENTITY_HEADER];

function server(answer: (call: MockCall) => Response | undefined) {
  return mockFetch((call) => {
    if (call.path === "/api/auth/get-session") return json(browser);
    return answer(call);
  });
}

describe("the request names the account", () => {
  it("every /api/* request carries the known account's id — not /api/auth/*, not /api/public/*", async () => {
    const calls = server(() => json({ ok: true }));
    await api("/api/nodes");
    await api("/api/nodes/n1", { method: "PATCH", body: { name: "x" } });
    await api("/api/public/config");
    await api("/api/auth/list-sessions");
    expect(calls.map((call) => [call.path, pinOf(call) ?? null])).toEqual([
      ["/api/nodes", ALICE.user.id],
      ["/api/nodes/n1", ALICE.user.id],
      ["/api/public/config", null],
      ["/api/auth/list-sessions", null],
    ]);
  });

  it("no account known (signed out): no header", async () => {
    const { resetIdentityForTests } = await import("../../../../src/client/lib/query");
    resetIdentityForTests();
    const calls = server(() => json({ ok: true }));
    await api("/api/nodes");
    expect(pinOf(calls[0]!)).toBeUndefined();
  });
});

describe("refused as another account", () => {
  it("no toast, never replayed; purged before the caller hears of it; B adopted; back to /", async () => {
    browser = BOB;
    const calls = server((call) => (call.path === "/api/nodes" ? MISMATCH() : undefined));
    const started = accountEpoch();
    let laterWorkMayRun: boolean | null = null;
    await api("/api/nodes").catch((error: unknown) => {
      // What a feature's late work checks before it writes or says anything.
      laterWorkMayRun = sameAccount(started);
      toastApiError(error);
    });
    expect(laterWorkMayRun).toBe(false);
    expect(calls.filter((call) => call.path === "/api/nodes")).toHaveLength(1);
    await expect.poll(() => getKnownUserId()).toBe(BOB.user.id);
    await expect.poll(() => navigated).toEqual(["/"]);
    expect(getToasts()).toEqual([]);
    expect(queryClient.getQueryData(["session"])).toMatchObject({ user: { id: BOB.user.id } });
  });

  it("three refused at once: one adoption, one navigation", async () => {
    browser = BOB;
    const calls = server((call) => (call.path.startsWith("/api/nodes") ? MISMATCH() : undefined));
    await Promise.allSettled([api("/api/nodes/1"), api("/api/nodes/2"), api("/api/nodes/3")]);
    await expect.poll(() => navigated).toEqual(["/"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(navigated).toEqual(["/"]);
    expect(calls.filter((call) => call.path === "/api/auth/get-session")).toHaveLength(1);
  });

  it("the session cannot be read during the adoption: the app starts over once (a reload), it does not ask again", async () => {
    browser = BOB;
    const reloaded: string[] = [];
    configureApi({ reload: (to) => void reloaded.push(to) });
    const calls = mockFetch((call) => {
      if (call.path === "/api/auth/get-session") return envelope("internal", 503);
      if (call.path.startsWith("/api/nodes")) return MISMATCH();
      return undefined;
    });
    await api("/api/nodes").catch(() => {});
    await expect.poll(() => reloaded).toEqual(["/"]);
    // Nothing more is asked by itself: no loop of refusals and session reads.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reloaded).toEqual(["/"]);
    expect(navigated).toEqual([]);
    expect(calls.filter((call) => call.path === "/api/auth/get-session").length).toBeLessThanOrEqual(1);
    expect(calls.filter((call) => call.path.startsWith("/api/nodes"))).toHaveLength(1);
  });

  // Review M1: a request sent for A whose refusal arrives after the tab has ALREADY moved to B
  // (the focus re-read of the session adopted B) must not purge B or send B to `/`.
  it("a late refusal of a request made for the previous account: dropped quietly — B is not purged, nothing navigates", async () => {
    let release: (answer: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => (release = resolve));
    server((call) => (call.path === "/api/nodes/slow" ? held : undefined));
    const request = api("/api/nodes/slow", { method: "POST" }).catch((error: unknown) => error);
    // The tab adopts B on its own (a session re-read), before the old answer comes.
    browser = BOB;
    const { refreshSession } = await import("../../../../src/client/lib/query");
    await refreshSession();
    expect(getKnownUserId()).toBe(BOB.user.id);
    let bPurged = false;
    const { registerUserStatePurger } = await import("../../../../src/client/lib/contracts");
    registerUserStatePurger(() => {
      bPurged = true;
    });
    const epoch = accountEpoch();
    release(MISMATCH());
    expect(await request).toMatchObject({ details: { reason: "identity_mismatch" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({ navigated, bPurgedAgain: bPurged || !sameAccount(epoch) }).toEqual({
      navigated: [],
      bPurgedAgain: false,
    });
    expect(getKnownUserId()).toBe(BOB.user.id);
    expect(getToasts()).toEqual([]);
  });

  it("control: another 403 forbidden (no reason) adopts nothing and keeps its toast path", async () => {
    browser = BOB;
    server(() => envelope("forbidden", 403));
    await api("/api/nodes").catch(toastApiError);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getKnownUserId()).toBe(ALICE.user.id);
    expect(navigated).toEqual([]);
    expect(getToasts().map((toast) => toast.message)).toEqual(["forbidden message"]);
  });
});
