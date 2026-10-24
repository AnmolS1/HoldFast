// secsrv-2 / ruling Q4 (P2's server refuses self-actions): on the admin's OWN account the Users
// screen offers no Suspend, no Delete user and no quota Set — nor Ban or the role change (R1D
// auth-1: the plugin's two are refused too); another account's row still does. And a refusal of
// the plugin's two is said in the client's own words.
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { en } from "../../../../src/client/lib/en";
import { json, setupShell } from "../shell/helpers";
import { ADMIN_ID, adminFetch, adminUser, DEFAULT_ADMIN, openConsole, OTHER_ID, userDetail } from "./helpers";

setupShell();

describe("the admin's own row", () => {
  it.each([
    ["own", ADMIN_ID, false],
    ["another", OTHER_ID, true],
  ] as const)(
    "%s account (%s): Suspend, Delete user, Set quota, Ban and the role change offered = %s",
    async (_which, id, offered) => {
      adminFetch(() => undefined, {
        ...DEFAULT_ADMIN,
        [`/api/admin/users/${id}`]: userDetail({ user: adminUser({ id, role: "admin" }) }),
      });
      openConsole(`/admin/users/${id}`);
      await screen.findByRole("button", { name: "Revoke sessions" }, { timeout: 10_000 });
      for (const name of ["Suspend", "Delete user", "Set quota", "Ban", "Remove admin role"]) {
        expect(screen.queryByRole("button", { name }) !== null, name).toBe(offered);
      }
    },
  );
});

describe("the plugin's refusals", () => {
  it.each([
    ["Ban", "/api/auth/admin/ban-user", 409, "LAST_ADMIN", "last_admin", en["apiError.last_admin"]],
    [
      "Remove admin role",
      "/api/auth/admin/set-role",
      409,
      "LAST_ADMIN",
      "last_admin",
      en["apiError.last_admin"],
    ],
    ["Ban", "/api/auth/admin/ban-user", 400, "SELF_ACTION", "self_action", en["apiError.self_action"]],
  ] as const)(
    "%s answered %s %s: the console says it in its own words",
    async (action, path, status, code, error, words) => {
      adminFetch(
        (call) =>
          call.path === path
            ? json({ code, error, message: "The server's provisional text." }, status)
            : undefined,
        {
          ...DEFAULT_ADMIN,
          [`/api/admin/users/${OTHER_ID}`]: userDetail({ user: adminUser({ id: OTHER_ID, role: "admin" }) }),
        },
      );
      openConsole(`/admin/users/${OTHER_ID}`);
      fireEvent.click(await screen.findByRole("button", { name: action }, { timeout: 10_000 }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/Reason/), {
        target: { value: "Made-up reason for the test." },
      });
      fireEvent.click(within(dialog).getAllByRole("button").at(-1)!);
      expect(await within(dialog).findByText(words)).toBeTruthy();
      expect(screen.queryByText("The server's provisional text.")).toBeNull();
    },
  );
});
