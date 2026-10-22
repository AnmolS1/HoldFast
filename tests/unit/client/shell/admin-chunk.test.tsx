// The admin console's chunk is fetched for an admin only: a non-admin (or a signed-out visitor)
// who opens /admin/x gets not-found and the console's module is never imported. The module is
// replaced by a stand-in that counts its imports; this file must not import the console up front
// (guards.test.tsx does, for timing — which is why this probe lives on its own).
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildRoutes } from "../../../../src/client/router";
import { renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

const probe = vi.hoisted(() => ({ imports: 0 }));

vi.mock("../../../../src/client/features/admin/AdminConsole", () => {
  probe.imports += 1;
  return { AdminConsole: () => <div data-admin-page /> };
});

setupShell();

// In order: every non-admin case runs before the admin case, which loads the module for good.
describe("the admin chunk", () => {
  it.each(["user", "administrator", "user,administrator", ""])(
    "/admin/users with the role %j: not-found, and the console is never imported",
    async (role) => {
      shellFetch({ session: sessionOf({ role }) });
      renderRoutes(buildRoutes(), ["/admin/users"]);
      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(probe.imports).toBe(0);
    },
  );

  it("/admin/users signed out: the sign-in page, and the console is never imported", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/admin/users"]);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(probe.imports).toBe(0);
  });

  // The probe can see an import: an admin's visit makes one.
  it("/admin/users as an admin: the console is imported and shown", async () => {
    shellFetch({ session: sessionOf({ role: "admin" }) });
    renderRoutes(buildRoutes(), ["/admin/users"]);
    await waitFor(() => expect(document.querySelector("[data-admin-page]")).not.toBeNull());
    expect(probe.imports).toBe(1);
  });
});
