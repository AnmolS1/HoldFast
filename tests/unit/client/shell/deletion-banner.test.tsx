import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import type { SessionShape } from "../../../../src/client/lib/contracts";
import { buildRoutes } from "../../../../src/client/router";
import { envelope, json, renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const WHEN = "2026-10-15T12:00:00.000Z";
const banner = () => document.querySelector('[data-banner="deletion"]');

describe("deletion banner", () => {
  it("is shown when the account is scheduled for deletion, with the date and the paused-links sentence", async () => {
    shellFetch({ session: sessionOf({ deleteScheduledAt: WHEN }), extra: (call) => (call.path === "/api/account/deletion-status" ? json({ scheduledFor: WHEN }) : undefined) });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()!.textContent).toContain("This account is scheduled for deletion on October 15, 2026. Your links are paused until then.");
    expect(screen.getByRole("button", { name: "Cancel deletion" })).toBeTruthy();
  });

  it("is absent for an account that is not scheduled", async () => {
    shellFetch({ session: sessionOf() });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    expect(banner()).toBeNull();
  });

  it("Cancel deletion → POST → hides at once, refetches the session, toasts 'Deletion cancelled.'", async () => {
    let session: SessionShape = sessionOf({ deleteScheduledAt: WHEN });
    let scheduledFor: string | null = WHEN;
    const calls = shellFetch({
      session: () => session,
      extra: (call) => {
        if (call.path === "/api/account/deletion-status") return json({ scheduledFor });
        if (call.path === "/api/account/deletion/cancel" && call.method === "POST") {
          session = sessionOf();
          scheduledFor = null;
          return json({ ok: true });
        }
        return undefined;
      },
    });
    renderRoutes(buildRoutes(), ["/"]);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(banner()).toBeNull());
    expect(getToasts().map((toast) => toast.message)).toEqual(["Deletion cancelled."]);
    // It does not promise that links work again: another pause reason may remain.
    expect(getToasts()[0]!.message).not.toMatch(/link/i);
    const sessionReads = () => calls.filter((call) => call.path === "/api/auth/get-session").length;
    await waitFor(() => expect(sessionReads()).toBeGreaterThanOrEqual(2));
    expect(calls.filter((call) => call.path === "/api/account/deletion/cancel").length).toBe(1);
  });

  it("409 → 'Deletion has already started — contact support.', and no cancel button any more", async () => {
    shellFetch({
      session: sessionOf({ deleteScheduledAt: WHEN }),
      extra: (call) => {
        if (call.path === "/api/account/deletion-status") return json({ scheduledFor: WHEN });
        if (call.path === "/api/account/deletion/cancel") return envelope("conflict", 409);
        return undefined;
      },
    });
    renderRoutes(buildRoutes(), ["/"]);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(banner()!.textContent).toContain("Deletion has already started — contact support."));
    expect(screen.queryByRole("button", { name: "Cancel deletion" })).toBeNull();
    expect(getToasts()).toEqual([]);
  });

  it("?deletion=scheduled re-reads the status and the session, shows the banner, and drops the parameter", async () => {
    // The session cookie is cached: it does not carry the date yet. The status route does.
    const calls = shellFetch({ session: sessionOf(), extra: (call) => (call.path === "/api/account/deletion-status" ? json({ scheduledFor: WHEN }) : undefined) });
    const { router } = renderRoutes(buildRoutes(), ["/account?deletion=scheduled&tab=x"]);
    await waitFor(() => expect(banner()).not.toBeNull());
    await waitFor(() => expect(router.state.location.search).toBe("?tab=x"));
    expect(router.state.location.pathname).toBe("/account");
    expect(document.querySelector('[data-placeholder-page="Account"]')).not.toBeNull();
    expect(calls.filter((call) => call.path === "/api/account/deletion-status").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((call) => call.path === "/api/auth/get-session").length).toBeGreaterThanOrEqual(2);
  });

  it("impersonation and read-only banners", async () => {
    shellFetch({ session: sessionOf({ name: "Grace Hopper" }, { impersonatedBy: "b".repeat(32) }), config: { readOnly: true } });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector('[data-banner="impersonation"]')).not.toBeNull());
    expect(document.querySelector('[data-banner="impersonation"]')!.textContent).toContain("Viewing as Grace Hopper — read-only");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(document.querySelector('[data-banner="read-only"]')!.textContent).toContain("Holdfast is read-only for maintenance.");
  });
});
