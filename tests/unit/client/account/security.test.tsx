// R1 func-6 / func-10: the security page says what the server does. A password change always signs
// out the other devices (hooks.ts forces it), and the devices list follows; an account with no
// password is not offered a two-factor prompt that asks for one.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetPrefsSync } from "../../../../src/client/features/account/prefs-sync";
import { buildRoutes } from "../../../../src/client/router";
import { json, renderRoutes, sessionOf, setupShell, shellFetch } from "../shell/helpers";

setupShell();
beforeEach(() => resetPrefsSync());

const ME = "a".repeat(32);
const PROFILE = { displayName: "Ada", email: "ada@example.com", timezone: "UTC", locale: "en", avatar: null };

function api(accounts: unknown[]) {
  return shellFetch({
    session: sessionOf(),
    extra: (call) => {
      if (call.path.startsWith("/api/auth/get-session?"))
        return json({ user: { id: ME, twoFactorEnabled: false }, session: {} });
      if (call.path === "/api/account/profile" && call.method === "GET") return json(PROFILE);
      if (call.path === "/api/auth/list-accounts") return json(accounts);
      if (call.path.startsWith("/api/auth/passkey/list-user-passkeys")) return json([]);
      return undefined;
    },
  });
}

describe("two-factor without a password (func-10)", () => {
  it("a Google-only account is told it needs a password, and gets no Turn on", async () => {
    api([{ id: "acc2", providerId: "google", accountId: "g-1" }]);
    renderRoutes(buildRoutes(), ["/account/security"]);
    expect(await screen.findByText(/Two-factor authentication needs a password/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("the control: an account with a password is offered Turn on", async () => {
    api([{ id: "acc1", providerId: "credential", accountId: ME }]);
    renderRoutes(buildRoutes(), ["/account/security"]);
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Two-factor authentication needs a password/)).toBeNull());
  });
});
