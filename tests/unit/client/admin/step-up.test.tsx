// The console's step-up (R-g): `403 admin_requires_2fa` opens a code prompt; a correct code is
// posted by this session to Better Auth's verify endpoint, and then ONLY the refused request is
// sent again — once. An account without two-factor is told to turn it on, and nothing is sent.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { envelope, json, setupShell, shellFetch, type MockCall } from "../shell/helpers";
import { adminSession, DEFAULT_ADMIN, openConsole, REPORT } from "./helpers";

setupShell();

const count = (calls: MockCall[], method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path === path).length;

function api(twoFactorEnabled: boolean) {
  let refused = false;
  return shellFetch({
    session: { ...adminSession(), user: { ...adminSession().user, twoFactorEnabled } } as never,
    extra: (call) => {
      if (call.path === "/api/auth/two-factor/verify-totp") return json({ token: "made-up" });
      if (call.method === "POST" && call.path === `/api/admin/reports/${REPORT}/assign`) {
        if (!refused) {
          refused = true;
          return envelope("admin_requires_2fa", 403);
        }
        return json((DEFAULT_ADMIN[`/api/admin/reports/${REPORT}`] as { report: unknown }).report);
      }
      if (call.method === "GET" && call.path in DEFAULT_ADMIN) return json(DEFAULT_ADMIN[call.path]);
      return undefined;
    },
  });
}

describe("the step-up", () => {
  it("a refused action: the prompt, the code posted once, then that action replayed once — nothing else re-sent", async () => {
    const calls = api(true);
    openConsole(`/admin/reports/${REPORT}`);
    fireEvent.click(await screen.findByRole("button", { name: "Assign to me" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByLabelText(/Code from your app/);
    fireEvent.change(within(dialog).getByLabelText(/Code from your app/), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(count(calls, "POST", `/api/admin/reports/${REPORT}/assign`)).toBe(2));
    expect(count(calls, "POST", "/api/auth/two-factor/verify-totp")).toBe(1);
    expect(calls.find((call) => call.path === "/api/auth/two-factor/verify-totp")?.body).toEqual({
      code: "123456",
    });
    // Between the code and the replay nothing else of the console was sent: the replay is the
    // first admin request after the verify, and it is the refused one.
    const verifyAt = calls.findIndex((call) => call.path === "/api/auth/two-factor/verify-totp");
    const after = calls.slice(verifyAt + 1).filter((call) => call.path.startsWith("/api/admin/"));
    expect(after[0]).toMatchObject({ method: "POST", path: `/api/admin/reports/${REPORT}/assign` });
    // Before the step-up the report was read once; it was not re-sent with the refused request.
    const before = calls.slice(0, verifyAt).filter((call) => call.path.startsWith("/api/admin/"));
    expect(before.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /api/admin/reports/${REPORT}`,
      `POST /api/admin/reports/${REPORT}/assign`,
    ]);
    expect(await screen.findByText("Assigned to you.")).toBeTruthy();
  });

  it("cancelled: the refusal stands, nothing is sent again", async () => {
    const calls = api(true);
    openConsole(`/admin/reports/${REPORT}`);
    fireEvent.click(await screen.findByRole("button", { name: "Assign to me" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
    expect(count(calls, "POST", `/api/admin/reports/${REPORT}/assign`)).toBe(1);
    expect(count(calls, "POST", "/api/auth/two-factor/verify-totp")).toBe(0);
  });

  it("an account without two-factor is sent to turn it on: no code field, no verify call", async () => {
    const calls = api(false);
    openConsole(`/admin/reports/${REPORT}`);
    fireEvent.click(await screen.findByRole("button", { name: "Assign to me" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("link", { name: "Turn on two-factor" })).toBeTruthy();
    expect(within(dialog).queryByLabelText(/Code from your app/)).toBeNull();
    expect(count(calls, "POST", "/api/auth/two-factor/verify-totp")).toBe(0);
  });
});
