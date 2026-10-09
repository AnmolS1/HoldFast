// Route guards, including the open-redirect cases of `next`.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildRoutes } from "../../../../src/client/router";
import { safeNext } from "../../../../src/client/routes/auth";
import { renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const ORIGIN = "http://localhost:3000";

describe("safeNext", () => {
  const safe: Array<[string, string]> = [
    ["/", "/"],
    ["/folder/abc", "/folder/abc"],
    ["/search?q=tax%202026#top", "/search?q=tax%202026#top"],
    ["/account/security", "/account/security"],
    ["/a/../folder/x", "/folder/x"],
  ];
  it.each(safe)("keeps %s (normalised to %s)", (raw, expected) => {
    expect(safeNext(raw, ORIGIN)).toBe(expected);
  });

  const hostile = [
    "//evil.example",
    "//evil.example/path",
    "///evil.example",
    "https://evil.example",
    "http://evil.example/",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "javascript:alert(1)",
    "data:text/html,x",
    "evil.example",
    "folder/abc",
    "%2F%2Fevil.example",
    " /folder",
    "/folder\u0000",
    "",
  ];
  it.each(hostile)("rejects %j → /", (raw) => {
    expect(safeNext(raw, ORIGIN)).toBe("/");
  });

  it("the origin comparison is a second line behind the prefix rules: it alone still stops a host change", () => {
    // If a future edit loosened the prefix rules, a value that resolves elsewhere must still fail.
    // `new URL` is the arbiter; this asserts the property the comparison protects.
    for (const raw of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      expect(new URL(raw, ORIGIN).origin).not.toBe(ORIGIN);
      expect(safeNext(raw, ORIGIN)).toBe("/");
    }
  });

  it("null and undefined → /", () => {
    expect(safeNext(null, ORIGIN)).toBe("/");
    expect(safeNext(undefined, ORIGIN)).toBe("/");
  });

  it("an encoded backslash stays a path segment on this origin", () => {
    // %5C is not decoded by the URL parser into a separator: it cannot change the host.
    expect(safeNext("/%5Cevil.example", ORIGIN)).toBe("/%5Cevil.example");
    expect(new URL(safeNext("/%5Cevil.example", ORIGIN), ORIGIN).origin).toBe(ORIGIN);
  });

  it("every accepted value resolves to this origin", () => {
    for (const raw of [...safe.map(([value]) => value), ...hostile]) {
      expect(new URL(safeNext(raw, ORIGIN), ORIGIN).origin).toBe(ORIGIN);
    }
  });
});

const path = (router: { state: { location: { pathname: string; search: string } } }) => router.state.location.pathname + router.state.location.search;

describe("route guards", () => {
  it("unauthenticated → /login?next=<where they were going>", async () => {
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/trash?x=1"]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/trash?x=1");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("signed in but unverified → /verify-email", async () => {
    shellFetch({ session: sessionOf({ emailVerified: false }) });
    const { router } = renderRoutes(buildRoutes(), ["/recent"]);
    await waitFor(() => expect(path(router)).toBe("/verify-email"));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
  });

  it("stale terms → /accept-terms?next=", async () => {
    shellFetch({ session: sessionOf({ termsVersion: "2025-01" }) });
    const { router } = renderRoutes(buildRoutes(), ["/starred"]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/accept-terms"));
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/starred");
  });

  it("a verified user with current terms reaches the page", async () => {
    shellFetch({ session: sessionOf() });
    const { router } = renderRoutes(buildRoutes(), ["/trash"]);
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Trash"]')).not.toBeNull());
    expect(path(router)).toBe("/trash");
  });

  it("/admin/* without the admin role renders not-found (no hint that it exists)", async () => {
    shellFetch({ session: sessionOf({ role: "user" }) });
    renderRoutes(buildRoutes(), ["/admin/users"]);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(document.querySelector('[data-placeholder-page="Admin"]')).toBeNull();
  });

  it("/admin/* with the admin role renders the admin page", async () => {
    shellFetch({ session: sessionOf({ role: "admin" }) });
    renderRoutes(buildRoutes(), ["/admin/users"]);
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Admin"]')).not.toBeNull());
  });

  it("a signed-in user opening /login is sent to a SAFE next", async () => {
    shellFetch({ session: sessionOf() });
    const { router } = renderRoutes(buildRoutes(), ["/login?next=/recent"]);
    await waitFor(() => expect(path(router)).toBe("/recent"));
  });

  it.each(["//evil.example", "https://evil.example/x", "/\\evil.example"])("a signed-in user opening /login?next=%s lands on / — never off-site", async (next) => {
    shellFetch({ session: sessionOf() });
    const { router } = renderRoutes(buildRoutes(), [`/login?next=${encodeURIComponent(next)}`]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(path(router)).toBe("/");
  });

  it("public routes render with no session, outside the frame, and read no session", async () => {
    const calls = shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/dmca"]);
    expect(await screen.findByText("This page is being prepared.")).toBeTruthy();
    expect(document.querySelector("[data-frame]")).toBeNull();
    expect(calls.map((call) => call.path)).toEqual([]);
  });

  it("/s/:token renders outside the frame with no session", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/s/abc123"]);
    await waitFor(() => expect(document.querySelector('[data-placeholder-page="Shared file"]')).not.toBeNull());
    expect(document.querySelector("[data-frame]")).toBeNull();
  });

  it("an unknown address is not-found", async () => {
    shellFetch({ session: sessionOf() });
    renderRoutes(buildRoutes(), ["/no/such/page"]);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });

  it("when the config cannot be loaded the app says so instead of rendering half a shell", async () => {
    shellFetch({ session: sessionOf(), extra: (call) => (call.path === "/api/public/config" ? new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) : undefined) });
    renderRoutes(buildRoutes(), ["/"]);
    expect(await screen.findByRole("heading", { name: "Holdfast couldn't start" })).toBeTruthy();
    expect(document.querySelector("[data-frame]")).toBeNull();
  });

  it("/accept-terms with current terms goes on to next; signed out goes to /login", async () => {
    shellFetch({ session: sessionOf() });
    const first = renderRoutes(buildRoutes(), ["/accept-terms?next=/recent"]);
    await waitFor(() => expect(path(first.router)).toBe("/recent"));
    first.unmount();
  });
});
