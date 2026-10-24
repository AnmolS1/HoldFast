// "Run now" (standing check (c)): one call per pass, repeated only while the answer is 202, and
// never on a guarded job the detector or the pause switch stopped (409) — nor after an account
// change (standing check (a)).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adoptIdentity } from "../../../../src/client/lib/query";
import { envelope, json, seedSession, setupShell, type MockCall } from "../shell/helpers";
import { adminFetch, adminSession, openConsole, untilConsole } from "./helpers";

setupShell();

const jobCalls = (calls: MockCall[]) => calls.filter((call) => call.path === "/api/admin/jobs/purge/run");

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function runPurge() {
  await untilConsole();
  const row = await waitFor(() => {
    const found = document.querySelector('[data-admin-job="purge"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  fireEvent.click(within(row).getByRole("button", { name: "Run now" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
}

describe("Run now", () => {
  it("loops on 202 and stops on 200: three passes, three calls, the pass count shown", async () => {
    const answers = [
      json({ name: "purge", done: false }, 202),
      json({ name: "purge", done: false }, 202),
      json({ name: "purge", done: true }),
    ];
    const calls = adminFetch((call) =>
      call.path === "/api/admin/jobs/purge/run" ? answers.shift() : undefined,
    );
    openConsole("/admin/system");
    await runPurge();
    await waitFor(() => expect(document.querySelector('[data-admin-job-outcome="done"]')).not.toBeNull());
    expect(screen.getByText("Done in 3 passes.")).toBeTruthy();
    expect(jobCalls(calls)).toHaveLength(3);
  });

  it.each([
    ["rolled_back", "Stopped: the database reads as rolled back. See the detector below."],
    ["destroy_paused", "Stopped: the pause switch is on. See the detector below."],
    // func-3: reconcile's stops another pass cannot change (the purge row stands in for it here).
    ["orphans_disabled", "Done apart from orphans: orphan deletion is off in Settings."],
    [
      "orphan_threshold",
      "Stopped: more objects look orphaned than the threshold allows. Nothing was deleted. Check them before running it again.",
    ],
  ])(
    "a guarded job stopped by %s: exactly one call, and the detector panel is shown",
    async (reason, sentence) => {
      const calls = adminFetch((call) =>
        call.path === "/api/admin/jobs/purge/run" ? envelope("conflict", 409, { reason }) : undefined,
      );
      openConsole("/admin/system");
      await runPurge();
      await waitFor(() =>
        expect(document.querySelector('[data-admin-job-outcome="stopped"]')).not.toBeNull(),
      );
      expect(screen.getByText(sentence)).toBeTruthy();
      expect(document.querySelector('[data-admin-detector-highlight="true"]')).not.toBeNull();
      // Give a wrongly looping caller every chance to call again.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(jobCalls(calls)).toHaveLength(1);
    },
  );

  it("an error ends the loop too: one call", async () => {
    const calls = adminFetch((call) =>
      call.path === "/api/admin/jobs/purge/run" ? envelope("internal", 500) : undefined,
    );
    openConsole("/admin/system");
    await runPurge();
    await waitFor(() => expect(document.querySelector('[data-admin-job-outcome="error"]')).not.toBeNull());
    expect(jobCalls(calls)).toHaveLength(1);
  });

  it("the account changes mid-loop: no further call, and nothing of the first account's run is left on screen", async () => {
    const held = gate();
    let n = 0;
    const calls = adminFetch((call) => {
      if (call.path !== "/api/admin/jobs/purge/run") return undefined;
      n += 1;
      // Bounded: a loop that wrongly went on would end at the third pass.
      const answer = () =>
        n >= 3 ? json({ name: "purge", done: true }) : json({ name: "purge", done: false }, 202);
      return n === 2 ? held.opened.then(answer) : answer();
    });
    openConsole("/admin/system");
    await runPurge();
    await waitFor(() => expect(jobCalls(calls)).toHaveLength(2));
    const other = adminSession({ id: "C".repeat(32), email: "other-admin@example.test" });
    await act(async () => {
      await adoptIdentity(other);
      seedSession(other);
    });
    await act(async () => {
      held.open();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(jobCalls(calls)).toHaveLength(2);
    await untilConsole();
    expect(screen.queryByText(/Running, pass/)).toBeNull();
    expect(document.querySelector("[data-admin-job-outcome]")).toBeNull();
  });
});
