// The operator's switch for the closed-test notice (DEMONOTICE): Settings → Switches → "Closed-test
// notice at sign-up" shows the stored value and PATCHes `demoMode` — turning it off at launch is a
// console action, not a code change.
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { json } from "../shell/helpers";
import { adminCalls, adminFetch, DEFAULT_ADMIN, openConsole, screen, untilConsole } from "./helpers";

const answer = (demoMode: boolean) => {
  const base = DEFAULT_ADMIN["/api/admin/settings"] as { settings: Record<string, unknown> };
  return { ...base, settings: { ...base.settings, demoMode } };
};

describe("Settings: the closed-test notice switch", () => {
  it("shows the stored value and PATCHes demoMode off", async () => {
    const calls = adminFetch(
      (call) =>
        call.method === "PATCH" && call.path === "/api/admin/settings" ? json(answer(false)) : undefined,
      { ...DEFAULT_ADMIN, "/api/admin/settings": answer(true) },
    );
    openConsole("/admin/settings");
    await untilConsole();
    const toggle = (await screen.findByRole("switch", {
      name: "Closed-test notice at sign-up",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(adminCalls(calls).filter((call) => call.method === "PATCH")).toEqual([
        expect.objectContaining({ path: "/api/admin/settings", body: { demoMode: false } }),
      ]),
    );
    await waitFor(() => expect(toggle.checked).toBe(false));
  });
});
