// One account's state must never be shown to, or acted on by, another.
//  1. Re-auth as a DIFFERENT account discards the held requests instead of replaying them.
//  2. Sign-out, the terms gate and the router guard purge every user-scoped cache on an identity change.
//  3. Leaving the re-auth modal really signs out, purges, and the screen behind it is not readable.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRibbonSnapshot, publish } from "../../../../src/client/components/TransferRibbon";
import { toast, getToasts } from "../../../../src/client/components/Toaster";
import { api, configureApi, isReauthPending, isTermsPending } from "../../../../src/client/lib/api";
import { authClient } from "../../../../src/client/lib/auth-client";
import { registerUserStatePurger, type SessionShape } from "../../../../src/client/lib/contracts";
import {
  getKnownUserId,
  purgeUserState,
  queryClient,
  refreshSession,
} from "../../../../src/client/lib/query";
import { buildRoutes } from "../../../../src/client/router";
import { ReauthDialog } from "../../../../src/client/routes/auth";
import { lightTokens } from "../../../../src/client/theme/tokens";
import {
  envelope,
  flush,
  json,
  renderRoutes,
  renderShell,
  resolveVar,
  seedConfig,
  sessionOf,
  setupShell,
  shellFetch,
} from "./helpers";

setupShell();

const ALICE = sessionOf({ id: "a".repeat(32), name: "Alice", email: "alice@example.com" });
const BOB = sessionOf({ id: "b".repeat(32), name: "Bob", email: "bob@example.com" });

let assigned: string[];
beforeEach(() => {
  assigned = [];
  // jsdom cannot navigate: record hard navigations instead.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      origin: "http://localhost:3000",
      assign: (url: string) => void assigned.push(url),
    },
  });
  configureApi({ routeInfo: () => ({ public: false, auth: false }) });
});

/** Alice is signed in and has state; her session then ends and a mutation is held behind the modal. */
async function aliceWithHeldRequest(next: () => SessionShape) {
  let current: SessionShape = ALICE;
  let expired = false;
  const calls = shellFetch({
    session: () => current,
    extra: (call) => {
      if (call.path === "/api/nodes/delete")
        return expired ? envelope("unauthorized", 401) : json({ deleted: true, as: current?.user.id });
      return undefined;
    },
  });
  seedConfig();
  await refreshSession();
  expect(getKnownUserId()).toBe(ALICE!.user.id);
  queryClient.setQueryData(["nodes", "root"], [{ id: "alice-file" }]);
  publish("upload", { progress: 0.4, sentence: "Uploading alice.pdf", status: "active" });

  expired = true;
  const held = api("/api/nodes/delete", { method: "POST", body: { id: "alice-file" } });
  held.catch(() => {});
  await flush();
  expect(isReauthPending()).toBe(true);
  return {
    calls,
    held,
    /** The sign-in inside the modal succeeds — as whoever `next()` says. */
    signInAs: () => {
      current = next();
      expired = false;
    },
  };
}

describe("1. re-authentication as a different account", () => {
  it("SAME account: the held request replays", async () => {
    const scene = await aliceWithHeldRequest(() => ALICE);
    vi.spyOn(authClient.signIn, "email").mockImplementation(async () => {
      scene.signInAs();
      return { data: {}, error: null };
    });
    renderShell(<ReauthDialog />);
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await expect(scene.held).resolves.toEqual({ deleted: true, as: ALICE!.user.id });
    expect(assigned).toEqual([]);
    // Her state is untouched.
    expect(queryClient.getQueryData(["nodes", "root"])).toEqual([{ id: "alice-file" }]);
    expect(getRibbonSnapshot().current?.sentence).toBe("Uploading alice.pdf");
  });

  it("DIFFERENT account: the held request is discarded (never sent again), Alice's state is purged, and the app restarts at / as Bob", async () => {
    const purged = vi.fn();
    const unregister = registerUserStatePurger(purged);
    const scene = await aliceWithHeldRequest(() => BOB);
    // A passkey can belong to any account.
    vi.spyOn(authClient.signIn, "passkey").mockImplementation(async () => {
      scene.signInAs();
      return { data: {}, error: null };
    });
    renderShell(<ReauthDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));

    await expect(scene.held).rejects.toMatchObject({ status: 401 });
    await waitFor(() => expect(assigned).toEqual(["/"]));
    // Alice's delete was sent exactly once (the 401) — it did NOT run again with Bob's authority.
    expect(scene.calls.filter((call) => call.path === "/api/nodes/delete").length).toBe(1);
    expect(isReauthPending()).toBe(false);
    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
    expect(getRibbonSnapshot().current).toBeNull();
    expect(purged).toHaveBeenCalled();
    expect(getKnownUserId()).toBe(BOB!.user.id);
    unregister();
  });

  it("UNKNOWN previous account counts as different", async () => {
    const { confirmReauthIdentity } = await import("../../../../src/client/lib/query");
    shellFetch({ session: BOB });
    queryClient.setQueryData(["nodes", "root"], [{ id: "someone-else" }]);
    await expect(confirmReauthIdentity(null)).resolves.toBe("changed");
    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
  });
});

describe("2. identity changes purge user-scoped state", () => {
  it("purgeUserState clears the query cache (not the public config), the stores, the gates, and runs registered purgers", async () => {
    const purged = vi.fn();
    const unregister = registerUserStatePurger(purged);
    shellFetch({ session: ALICE });
    seedConfig();
    await refreshSession();
    queryClient.setQueryData(["nodes", "root"], [{ id: "alice-file" }]);
    queryClient.setQueryData(["deletion-status"], { scheduledFor: null });
    publish("upload", { progress: 0.4, sentence: "Uploading alice.pdf", status: "active" });
    toast({ message: "alice.pdf moved to trash", action: { label: "Undo", onClick: () => {} } });

    await purgeUserState();

    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
    expect(queryClient.getQueryData(["deletion-status"])).toBeUndefined();
    expect(queryClient.getQueryData(["session"])).toBeNull();
    expect(queryClient.getQueryData(["public-config"])).toBeDefined();
    expect(getRibbonSnapshot().current).toBeNull();
    expect(getToasts()).toEqual([]);
    expect(getKnownUserId()).toBeNull();
    expect(purged).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("a failing purger does not stop the others", async () => {
    const after = vi.fn();
    const a = registerUserStatePurger(() => {
      throw new Error("boom");
    });
    const b = registerUserStatePurger(after);
    await purgeUserState();
    expect(after).toHaveBeenCalled();
    a();
    b();
  });

  it("router guard: a session for another account purges the previous account's cache before the page renders", async () => {
    let current: SessionShape = ALICE;
    shellFetch({ session: () => current });
    const first = renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    queryClient.setQueryData(["nodes", "root"], [{ id: "alice-file" }]);
    first.unmount();

    // Alice's session ended elsewhere; Bob signs in on this device without a reload.
    current = BOB;
    await queryClient.invalidateQueries({ queryKey: ["session"] });
    renderRoutes(buildRoutes(), ["/recent"]);
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Recent"]')).not.toBeNull());
    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
    expect(getKnownUserId()).toBe(BOB!.user.id);
  });

  it("the same account signing in again keeps its cache", async () => {
    shellFetch({ session: ALICE });
    await refreshSession();
    queryClient.setQueryData(["nodes", "root"], [{ id: "alice-file" }]);
    await refreshSession();
    expect(queryClient.getQueryData(["nodes", "root"])).toEqual([{ id: "alice-file" }]);
  });

  it("legal gate: Sign out calls the real endpoint, purges, and discards the request waiting behind the gate", async () => {
    const signOut = vi.spyOn(authClient, "signOut").mockResolvedValue({ data: {}, error: null });
    let current: SessionShape = sessionOf({ ...ALICE!.user, termsVersion: "2025-01" });
    const calls = shellFetch({
      session: () => current,
      extra: (call) => (call.path === "/api/nodes/folder" ? envelope("terms_required", 403) : undefined),
    });
    const { router } = renderRoutes(buildRoutes(), ["/accept-terms"]);
    await screen.findByRole("button", { name: "Sign out" });
    queryClient.setQueryData(["nodes", "root"], [{ id: "alice-file" }]);
    const held = api("/api/nodes/folder", { method: "POST", body: { name: "x" } });
    held.catch(() => {});
    await flush();
    expect(isTermsPending()).toBe(true);

    current = null;
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(signOut).toHaveBeenCalledTimes(1);
    await expect(held).rejects.toMatchObject({ status: 403 });
    expect(isTermsPending()).toBe(false);
    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
    expect(calls.filter((call) => call.path === "/api/nodes/folder").length).toBe(1);
  });

  it("legal gate: accepting while ANOTHER account is now signed in does not replay the first account's request", async () => {
    let current: SessionShape = sessionOf({ ...ALICE!.user, termsVersion: "2025-01" });
    const calls = shellFetch({
      session: () => current,
      extra: (call) => {
        if (call.path === "/api/nodes/folder") return envelope("terms_required", 403);
        if (call.path === "/api/account/accept-terms") {
          // Another tab signed Bob in: the acceptance (and the refreshed session) are his.
          current = BOB;
          return json({ ok: true });
        }
        return undefined;
      },
    });
    renderRoutes(buildRoutes(), ["/accept-terms"]);
    fireEvent.click(await screen.findByRole("checkbox"));
    queryClient.setQueryData(["nodes", "root"], [{ id: "alice-file" }]);
    const held = api("/api/nodes/folder", { method: "POST", body: { name: "alice-folder" } });
    held.catch(() => {});
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));
    await expect(held).rejects.toMatchObject({ status: 403 });
    expect(calls.filter((call) => call.path === "/api/nodes/folder").length).toBe(1);
    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
  });
});

describe("3. leaving the re-auth modal", () => {
  it("'Sign in as someone else' calls the sign-out endpoint, purges, rejects the held request, and loads /login", async () => {
    const signOut = vi.spyOn(authClient, "signOut").mockResolvedValue({ data: {}, error: null });
    const scene = await aliceWithHeldRequest(() => null);
    renderShell(<ReauthDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in as someone else" }));
    await waitFor(() => expect(assigned).toEqual(["/login"]));
    expect(signOut).toHaveBeenCalledTimes(1);
    await expect(scene.held).rejects.toMatchObject({ status: 401 });
    expect(queryClient.getQueryData(["nodes", "root"])).toBeUndefined();
    expect(queryClient.getQueryData(["session"])).toBeNull();
    expect(getRibbonSnapshot().current).toBeNull();
    expect(getKnownUserId()).toBeNull();
    expect(scene.calls.filter((call) => call.path === "/api/nodes/delete").length).toBe(1);
  });

  it("the backdrop is opaque (the page colour, not the translucent scrim), and the modal cannot be dismissed", async () => {
    await aliceWithHeldRequest(() => ALICE);
    renderShell(<ReauthDialog />);
    await screen.findByRole("dialog", { name: "Your session ended" });
    const backdrop = document.querySelector<HTMLElement>("[data-reauth-backdrop]")!;
    expect(backdrop).not.toBeNull();
    const colour = resolveVar(getComputedStyle(backdrop).backgroundColor);
    expect(colour).toBe(lightTokens.bg);
    expect(colour).not.toBe(lightTokens.scrim);
    expect(colour).toMatch(/^#[0-9A-F]{6}$/i);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(backdrop);
    await flush();
    expect(isReauthPending()).toBe(true);
    expect(screen.getByRole("dialog", { name: "Your session ended" })).toBeTruthy();
  });

  it("the email in the modal is the expired account's and cannot be edited", async () => {
    await aliceWithHeldRequest(() => ALICE);
    renderShell(<ReauthDialog />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    expect(email.value).toBe("alice@example.com");
    expect(email.readOnly).toBe(true);
  });
});
