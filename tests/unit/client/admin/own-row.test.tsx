// secsrv-2 / ruling Q4 (P2's server refuses self-actions): on the admin's OWN account the Users
// screen offers no Suspend, no Delete user and no quota Set; another account's row still does.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupShell } from "../shell/helpers";
import { ADMIN_ID, adminFetch, adminUser, DEFAULT_ADMIN, openConsole, OTHER_ID, userDetail } from "./helpers";

setupShell();

describe("the admin's own row", () => {
  it.each([
    ["own", ADMIN_ID, false],
    ["another", OTHER_ID, true],
  ] as const)(
    "%s account (%s): Suspend, Delete user and Set quota offered = %s",
    async (_which, id, offered) => {
      adminFetch(() => undefined, {
        ...DEFAULT_ADMIN,
        [`/api/admin/users/${id}`]: userDetail({ user: adminUser({ id, role: "admin" }) }),
      });
      openConsole(`/admin/users/${id}`);
      await screen.findByRole("button", { name: "Revoke sessions" }, { timeout: 10_000 });
      for (const name of ["Suspend", "Delete user", "Set quota"]) {
        expect(screen.queryByRole("button", { name }) !== null, name).toBe(offered);
      }
    },
  );
});
