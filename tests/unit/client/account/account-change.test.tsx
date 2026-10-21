// Wave-3 standing check (a): the account changes while a step of the account page is waiting for
// its answer. Nothing of account A may then be shown to B, cached for B or sent as B: the step's
// late answer is dropped (no toast, no download, no cache write) and the page shows B.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { resetPrefsSync } from "../../../../src/client/features/account/prefs-sync";
import { IDENTITY_HEADER } from "../../../../src/client/lib/api";
import { adoptIdentity, queryClient, sessionQuery } from "../../../../src/client/lib/query";
import { buildRoutes } from "../../../../src/client/router";
import { fileNode } from "../explorer/fixtures/nodes";
import { json, renderRoutes, sessionOf, setupShell, shellFetch, type MockCall } from "../shell/helpers";

setupShell();
beforeEach(() => resetPrefsSync());

const A = "a".repeat(32);
const B = "b".repeat(32);
const profileOf = (who: string) => ({
  displayName: who === A ? "Ada Lovelace" : "Barbara Liskov",
  email: who === A ? "ada@example.com" : "barbara@example.com",
  timezone: "UTC",
  locale: "en",
  avatar: null,
});
const PREFS = {
  density: "compact",
  theme: "system",
  viewMode: "list",
  emailShares: true,
  emailLinkDigest: true,
  emailSecurity: true,
};
const LATER = () => new Date(Date.now() + 3_600_000).toISOString();

type Held = { path: (call: MockCall) => boolean; answer: () => Response };

/**
 * The API as A, then as B. The request `held` matches is answered only when the test releases it —
 * with the success `answer` — after the account has changed.
 */
function scripted(held: Held) {
  let who = A;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls = shellFetch({
    session: () => sessionOf({ id: who, email: profileOf(who).email, name: profileOf(who).displayName }),
    extra: (call) => {
      if (held.path(call)) return gate.then(held.answer) as unknown as Response;
      const as = new Headers(call.headers).get(IDENTITY_HEADER) ?? who;
      if (call.path === "/api/account/profile" && call.method === "GET") return json(profileOf(as));
      if (call.path === "/api/account/prefs" && call.method === "GET") return json(PREFS);
      if (call.path === "/api/auth/list-accounts") return json([{ id: "acc", providerId: "credential" }]);
      if (call.path === "/api/account/sessions")
        return json([
          {
            id: "S".repeat(32),
            current: true,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            expiresAt: LATER(),
            uaLabel: "Chrome on macOS",
            country: "DE",
          },
          {
            id: "T".repeat(32),
            current: false,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            expiresAt: LATER(),
            uaLabel: "Firefox on Linux",
            country: "FR",
          },
        ]);
      if (call.path === "/api/account/activity") return json([]);
      return undefined;
    },
  });
  /** Another account in another tab: the next session read names B (the shell purges, then adopts). */
  const switchToB = async () => {
    who = B;
    const session = sessionOf({ id: B, email: profileOf(B).email, name: profileOf(B).displayName });
    await adoptIdentity(session);
    queryClient.setQueryData(sessionQuery.queryKey, session);
  };
  return {
    calls,
    release,
    switchToB,
    waitHeld: () => waitFor(() => expect(calls.some(held.path)).toBe(true)),
  };
}

/** After the late answer: the page is B's, and nothing of A was written into B's state. */
async function expectOnlyB(calls: MockCall[], before: number) {
  await waitFor(() => expect(screen.getByDisplayValue("Barbara Liskov")).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(getToasts()).toEqual([]);
  const profile = queryClient.getQueryData<{ email: string }>(["account", "profile"]);
  if (profile) expect(profile.email).toBe("barbara@example.com");
  // Nothing more was sent for A after the change.
  const later = calls.slice(before).filter((call) => new Headers(call.headers).get(IDENTITY_HEADER) === A);
  expect(later).toEqual([]);
}

describe("the account changes while a step waits", () => {
  it("a profile PATCH: its answer is not cached or toasted for B", async () => {
    const api = scripted({
      path: (call) => call.path === "/api/account/profile" && call.method === "PATCH",
      answer: () => json({ ...profileOf(A), displayName: "Ada Byron" }),
    });
    renderRoutes(buildRoutes(), ["/account"]);
    const field = await screen.findByDisplayValue("Ada Lovelace");
    fireEvent.change(field, { target: { value: "Ada Byron" } });
    fireEvent.click(within(field.closest("form")!).getByRole("button", { name: "Save" }));
    await api.waitHeld();
    await api.switchToB();
    const before = api.calls.length;
    api.release();
    await expectOnlyB(api.calls, before);
    expect(screen.queryByDisplayValue("Ada Byron")).toBeNull();
  });

  it("the avatar upload: a late complete shows nothing and refreshes nothing for B", async () => {
    const api = scripted({
      path: (call) => call.path.endsWith("/complete"),
      // A clean avatar: what would toast "Profile picture updated." and refresh the profile.
      answer: () => json(fileNode(1, { scanStatus: "clean", name: "me.png" }), 201),
    });
    renderRoutes(buildRoutes(), ["/account"]);
    await screen.findByDisplayValue("Ada Lovelace");
    // The two requests before `complete` answer at once.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), "http://localhost:3000").pathname;
      if (path === "/api/uploads")
        return json({
          uploadId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e",
          mode: "single",
          partBytes: 67108864,
          partCount: 1,
          resumedParts: [],
          finalName: "me.png",
          expiresAt: LATER(),
        });
      if (path.endsWith("/single")) return json({ etag: "e1" });
      return real(input, init);
    });
    const input = document.querySelector<HTMLInputElement>("[data-avatar-input]")!;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" })] },
    });
    await api.waitHeld();
    await api.switchToB();
    const before = api.calls.length;
    api.release();
    await expectOnlyB(api.calls, before);
    expect(screen.queryByText("Couldn't check that image. Try again.")).toBeNull();
    expect(getToasts().map((toast) => toast.message)).not.toContain("Profile picture updated.");
  });

  it("the export: A's file is never handed over once B is signed in", async () => {
    // jsdom has no object URLs: stand them in, so that a hand-over would reach the click.
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:export", revokeObjectURL: () => {} }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const api = scripted({
      path: (call) => call.path === "/api/account/export",
      answer: () =>
        json({
          version: 1,
          exportedAt: new Date().toISOString(),
          user: {
            id: A,
            email: "ada@example.com",
            displayName: "Ada Lovelace",
            createdAt: new Date().toISOString(),
            timezone: null,
            locale: "en",
            quotaBytes: 1,
            usedBytes: 0,
            termsAcceptedAt: null,
            termsVersion: null,
          },
          prefs: PREFS,
          nodes: [],
          shares: [],
          sharedWithMe: [],
          links: [],
          activity: [],
        }),
    });
    renderRoutes(buildRoutes(), ["/account/data"]);
    fireEvent.click(await screen.findByRole("button", { name: "Download export" }));
    await api.waitHeld();
    await api.switchToB();
    api.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(click).not.toHaveBeenCalled();
    expect(getToasts()).toEqual([]);
  });

  it("a session revoke: its late answer toasts nothing and asks nothing more for A", async () => {
    const api = scripted({
      path: (call) => call.method === "DELETE" && call.path.startsWith("/api/account/sessions/"),
      answer: () => new Response(null, { status: 204 }),
    });
    renderRoutes(buildRoutes(), ["/account/devices"]);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Firefox on Linux" }));
    await api.waitHeld();
    await api.switchToB();
    const before = api.calls.length;
    api.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getToasts()).toEqual([]);
    const later = api.calls
      .slice(before)
      .filter((call) => new Headers(call.headers).get(IDENTITY_HEADER) === A);
    expect(later).toEqual([]);
  });

  it("a Better Auth call (change of address): the late answer is shown to nobody", async () => {
    const api = scripted({
      path: (call) => call.path === "/api/auth/change-email",
      answer: () => json({ status: true }),
    });
    renderRoutes(buildRoutes(), ["/account"]);
    fireEvent.click(await screen.findByRole("button", { name: "Change email" }));
    fireEvent.change(screen.getByLabelText("New email address"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "made-up password 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation" }));
    await api.waitHeld();
    expect(
      new Headers(api.calls.find((call) => call.path === "/api/auth/change-email")!.headers).get(
        IDENTITY_HEADER,
      ),
    ).toBe(A);
    await api.switchToB();
    const before = api.calls.length;
    api.release();
    await expectOnlyB(api.calls, before);
    expect(screen.queryByText(/Check ada@example\.com/)).toBeNull();
  });
});
