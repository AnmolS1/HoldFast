// The 401 rule through the REAL router wiring (`connectRouter`): the API client learns from the
// matched routes whether the page is public or an auth screen. The matrix in api-401.test.ts
// stubs that answer; this file does not.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api, cancelReauth, isReauthPending } from "../../../../src/client/lib/api";
import { buildRoutes } from "../../../../src/client/router";
import {
  envelope,
  flush,
  renderRoutes,
  seedConfig,
  seedSession,
  sessionOf,
  setupShell,
  shellFetch,
} from "./helpers";

setupShell();

function arrange(session: ReturnType<typeof sessionOf> | null) {
  return shellFetch({
    session,
    extra: (call) => (call.path === "/api/nodes" ? envelope("unauthorized", 401) : undefined),
  });
}

describe("401 and the route that is showing", () => {
  it("a public link page (handle.public): no modal, even though a signed-in session is known", async () => {
    arrange(sessionOf());
    // The client already knows a session (the person is signed in in this browser).
    seedSession(sessionOf());
    seedConfig();
    renderRoutes(buildRoutes(), ["/s/sometoken"]);
    await waitFor(() =>
      expect(document.querySelector('[data-placeholder-page="Shared file"]')).not.toBeNull(),
    );
    await expect(api("/api/nodes")).rejects.toMatchObject({ status: 401 });
    expect(isReauthPending()).toBe(false);
  });

  it("/dmca (handle.public): no modal", async () => {
    arrange(sessionOf());
    seedSession(sessionOf());
    renderRoutes(buildRoutes(), ["/dmca"]);
    await screen.findByText("This page is being prepared.");
    await expect(api("/api/nodes")).rejects.toMatchObject({ status: 401 });
    expect(isReauthPending()).toBe(false);
  });

  it("an auth screen: no modal (the session is unverified, so it stays on /verify-email)", async () => {
    arrange(sessionOf({ emailVerified: false }));
    renderRoutes(buildRoutes(), ["/verify-email"]);
    await screen.findByRole("heading", { name: "Check your email" });
    await expect(api("/api/nodes")).rejects.toMatchObject({ status: 401 });
    expect(isReauthPending()).toBe(false);
  });

  it("the terms screen: no modal", async () => {
    arrange(sessionOf({ termsVersion: "2025-01" }));
    renderRoutes(buildRoutes(), ["/accept-terms"]);
    await screen.findByRole("button", { name: "Accept and continue" });
    await expect(api("/api/nodes")).rejects.toMatchObject({ status: 401 });
    expect(isReauthPending()).toBe(false);
  });

  it("control — an app route: the SAME request opens the modal", async () => {
    arrange(sessionOf());
    renderRoutes(buildRoutes(), ["/recent"]);
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Recent"]')).not.toBeNull());
    const held = api("/api/nodes");
    held.catch(() => {});
    await flush();
    expect(isReauthPending()).toBe(true);
    cancelReauth();
    await expect(held).rejects.toMatchObject({ status: 401 });
  });
});
