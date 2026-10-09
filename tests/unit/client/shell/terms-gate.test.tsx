import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api, isTermsPending } from "../../../../src/client/lib/api";
import type { SessionShape } from "../../../../src/client/lib/contracts";
import { buildRoutes } from "../../../../src/client/router";
import { CONFIG, envelope, json, renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

describe("terms re-acceptance", () => {
  it("stale terms → the blocking screen; accept → POST with the current version → continues to next", async () => {
    let session: SessionShape = sessionOf({ termsVersion: "2025-01" });
    const calls = shellFetch({
      session: () => session,
      extra: (call) => {
        if (call.path === "/api/account/accept-terms" && call.method === "POST") {
          session = sessionOf({ termsVersion: "2026-10" });
          return json({ ok: true });
        }
        return undefined;
      },
    });
    const { router } = renderRoutes(buildRoutes(), ["/recent"]);
    expect(await screen.findByRole("heading", { name: "We've updated the Terms and Privacy Policy." })).toBeTruthy();
    // The screen replaces the app: no frame, no page content.
    expect(document.querySelector("[data-frame]")).toBeNull();
    expect(document.querySelector("[data-placeholder-page]")).toBeNull();
    expect(screen.getByRole("link", { name: "Read the Terms" }).getAttribute("href")).toBe("https://ponderance.dev/terms");
    expect(screen.getByRole("link", { name: "Read the Privacy Policy" }).getAttribute("href")).toBe("https://ponderance.dev/privacy");

    const accept = screen.getByRole("button", { name: "Accept and continue" });
    const checkbox = screen.getByRole("checkbox", { name: "I agree to the Terms and Privacy Policy." }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    // Exactly two actions exist: accept, and sign out.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Accept and continue", "Sign out"]);

    fireEvent.click(checkbox);
    fireEvent.click(accept);
    await waitFor(() => expect(router.state.location.pathname).toBe("/recent"));
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Recent"]')).not.toBeNull());
    const post = calls.find((call) => call.path === "/api/account/accept-terms");
    expect(post?.body).toEqual({ version: "2026-10" });
  });

  it("a failed accept stays on the screen and shows the request id", async () => {
    shellFetch({ session: sessionOf({ termsVersion: "2025-01" }), extra: (call) => (call.path === "/api/account/accept-terms" ? envelope("validation", 400) : undefined) });
    const { router } = renderRoutes(buildRoutes(), ["/accept-terms"]);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("req req-1234");
    expect(router.state.location.pathname).toBe("/accept-terms");
  });

  it("403 terms_required on a request → the gate, and the request replays after accepting", async () => {
    let session: SessionShape = sessionOf();
    let configTerms = "2026-10";
    let accepted = false;
    const calls = shellFetch({
      session: () => session,
      config: () => ({ ...CONFIG, termsVersion: configTerms }),
      extra: (call) => {
        if (call.path === "/api/nodes/folder") return accepted ? json({ id: "new" }) : envelope("terms_required", 403);
        if (call.path === "/api/account/accept-terms") {
          accepted = true;
          session = sessionOf({ termsVersion: "2026-11" });
          return json({ ok: true });
        }
        return undefined;
      },
    });
    const { router } = renderRoutes(buildRoutes(), ["/trash"]);
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Trash"]')).not.toBeNull());

    // The terms were bumped on the server after this page loaded.
    configTerms = "2026-11";
    const { queryClient, publicConfigQuery } = await import("../../../../src/client/lib/query");
    await queryClient.invalidateQueries({ queryKey: publicConfigQuery.queryKey });

    const pending = api<{ id: string }>("/api/nodes/folder", { method: "POST", body: { name: "Taxes" } });
    await waitFor(() => expect(router.state.location.pathname).toBe("/accept-terms"));
    expect(isTermsPending()).toBe(true);
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/trash");

    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));
    await expect(pending).resolves.toEqual({ id: "new" });
    expect(isTermsPending()).toBe(false);
    await waitFor(() => expect(router.state.location.pathname).toBe("/trash"));
    expect(calls.filter((call) => call.path === "/api/nodes/folder").map((call) => call.body)).toEqual([{ name: "Taxes" }, { name: "Taxes" }]);
  });
});
