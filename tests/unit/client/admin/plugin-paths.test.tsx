// The console reaches Better Auth's admin plugin through exactly T06's allow-list (ruling 6): ban,
// unban, set role, impersonate, stop impersonating — every user action of section 2 driven, and
// the set of /api/auth/admin/* requests compared with ADMIN_PLUGIN_ALLOWED.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stopImpersonating } from "../../../../src/client/features/admin/auth-calls";
import adminGateSource from "../../../../src/worker/auth/admin-gate.ts?raw";
import { json, setupShell, type MockCall } from "../shell/helpers";
import { adminFetch, adminUser, DEFAULT_ADMIN, openConsole, OTHER_ID, userDetail } from "./helpers";

setupShell();

/** T06's export, read from its source (a Worker module is not loaded into jsdom). */
const ALLOWED = [
  .../ADMIN_PLUGIN_ALLOWED = Object\.freeze\(\[([^\]]*)\]/.exec(adminGateSource)![1]!.matchAll(/"([^"]+)"/g),
].map((match) => `/api/auth${match[1]}`);

const pluginCalls = (calls: MockCall[]) =>
  calls.filter((call) => call.path.startsWith("/api/auth/admin/")).map((call) => call.path.split("?")[0]!);

function api(banned: boolean) {
  const fixtures = {
    ...DEFAULT_ADMIN,
    [`/api/admin/users/${OTHER_ID}`]: userDetail({ user: adminUser({ banned }) }),
  };
  return adminFetch((call) => {
    if (call.path.startsWith("/api/auth/admin/")) return json({ user: { id: OTHER_ID }, session: {} });
    if (call.method !== "POST" || !call.path.startsWith(`/api/admin/users/${OTHER_ID}/`)) return undefined;
    if (/revoke-(sessions|links)$/.test(call.path)) return json({ revoked: 1 });
    if (/deletion$/.test(call.path)) return json({ scheduledFor: new Date().toISOString(), changed: true });
    return json(fixtures[`/api/admin/users/${OTHER_ID}`]);
  }, fixtures);
}

/** Opens the user's detail, presses `action`, types a reason and confirms. */
async function drive(action: string) {
  await screen.findByRole("button", { name: action });
  fireEvent.click(screen.getByRole("button", { name: action }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/Reason/), {
    target: { value: "Made-up reason for the test." },
  });
  fireEvent.click(within(dialog).getAllByRole("button").at(-1)!);
  await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
}

describe("the admin plugin paths", () => {
  it("the allow-list read from T06 has the five paths", () => {
    expect(ALLOWED).toEqual([
      "/api/auth/admin/ban-user",
      "/api/auth/admin/unban-user",
      "/api/auth/admin/set-role",
      "/api/auth/admin/impersonate-user",
      "/api/auth/admin/stop-impersonating",
    ]);
  });

  it("every section-2 action driven: the plugin paths requested are exactly ADMIN_PLUGIN_ALLOWED", async () => {
    const seen = new Set<string>();
    for (const [banned, actions] of [
      [
        false,
        [
          "Ban",
          "Make admin",
          "Suspend",
          "Revoke sessions",
          "Revoke all links",
          "Set legal hold",
          "Delete user",
        ],
      ],
      [true, ["Lift ban"]],
    ] as const) {
      const calls = api(banned);
      const view = openConsole(`/admin/users/${OTHER_ID}`);
      for (const action of actions) await drive(action);
      for (const path of pluginCalls(calls)) seen.add(path);
      view.unmount();
    }
    const calls = api(false);
    const view = openConsole(`/admin/users/${OTHER_ID}`);
    await drive("Impersonate");
    for (const path of pluginCalls(calls)) seen.add(path);
    view.unmount();
    const stop = api(false);
    await stopImpersonating();
    for (const path of pluginCalls(stop)) seen.add(path);
    expect([...seen].sort()).toEqual([...ALLOWED].sort());
  });

  it("the console's own actions go to /api/admin/*, never to another plugin path (no remove-user, no set-user-password)", async () => {
    const calls = api(false);
    openConsole(`/admin/users/${OTHER_ID}`);
    await drive("Delete user");
    expect(
      calls.some((call) => call.method === "POST" && call.path === `/api/admin/users/${OTHER_ID}/deletion`),
    ).toBe(true);
    expect(pluginCalls(calls)).toEqual([]);
  });
});
