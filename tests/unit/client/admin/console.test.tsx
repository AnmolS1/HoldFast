// The admin console's screens against a scripted API: each reads once when opened, renders an
// error state (never throws) on a 404 or a 5xx, never asks for content, and never polls.
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envelope, setupShell } from "../shell/helpers";
import {
  adminCalls,
  adminFetch,
  adminNode,
  consolePage,
  contentCalls,
  openConsole,
  REPORT,
  reportDetail,
  SCREENS,
  untilConsole,
} from "./helpers";

setupShell();
afterEach(() => vi.useRealTimers());

const COUNSEL =
  "Adjudication rule pending counsel (T29 §C.5 / §F). Until it is written, follow the interim operator practice in the CSAM procedure; the file itself cannot be opened from this console.";

describe("the console", () => {
  it("replaces the placeholder: a lazy chunk inside the frame, with its own sections", async () => {
    adminFetch();
    openConsole("/admin");
    await untilConsole();
    expect(document.querySelector('[data-placeholder-page="Admin"]')).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getAllByRole("link").length).toBe(12);
  });

  it("the analytics tiles read Unavailable on { available: false }", async () => {
    adminFetch();
    openConsole("/admin");
    await waitFor(() =>
      expect(document.querySelector('[data-admin-analytics="unavailable"]')).not.toBeNull(),
    );
    expect(
      within(document.querySelector('[data-admin-analytics="unavailable"]') as HTMLElement).getAllByText(
        "Unavailable",
      ),
    ).toHaveLength(3);
  });

  it.each([
    ["a user report", {}, {}],
    [
      "a csam report on a locked file",
      { locked: { at: new Date().toISOString(), source: "admin" } },
      { category: "csam", node: adminNode({ scanStatus: "suspected_csam", legalHold: true }) },
    ],
    ["a report whose file is gone", {}, { nodeId: null, node: null }],
  ])("the pending-counsel notice is on every report detail: %s", async (_name, detailPatch, reportPatch) => {
    const fixtures: Record<string, unknown> = {
      [`/api/admin/reports/${REPORT}`]: reportDetail(detailPatch, reportPatch),
    };
    adminFetch((call) =>
      call.path in fixtures
        ? new Response(JSON.stringify(fixtures[call.path]), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    openConsole(`/admin/reports/${REPORT}`);
    await waitFor(() => expect(screen.getByText(/report$/, { selector: "h2" })).toBeTruthy());
    expect(document.querySelector("[data-admin-counsel-notice]")?.textContent).toBe(COUNSEL);
  });

  it("the notice is there even when the report cannot be read", async () => {
    adminFetch((call) =>
      call.path.startsWith(`/api/admin/reports/${REPORT}`) ? envelope("internal", 500) : undefined,
    );
    openConsole(`/admin/reports/${REPORT}`);
    await waitFor(() => expect(document.querySelector("[data-admin-error]")).not.toBeNull());
    expect(document.querySelector("[data-admin-counsel-notice]")?.textContent).toBe(COUNSEL);
  });

  it("a lock with no alert row is shown as 'operators not yet reached'; with one it is not", async () => {
    const locked = { at: new Date().toISOString(), source: "system" };
    const fixtures: Record<string, unknown> = {
      [`/api/admin/reports/${REPORT}`]: reportDetail({ locked }, { category: "csam" }),
    };
    adminFetch((call) =>
      call.path in fixtures
        ? new Response(JSON.stringify(fixtures[call.path]), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    const view = openConsole(`/admin/reports/${REPORT}`);
    await waitFor(() => expect(document.querySelector("[data-admin-not-reached]")).not.toBeNull());
    view.unmount();
    fixtures[`/api/admin/reports/${REPORT}`] = reportDetail(
      { locked, alerts: [{ at: locked.at, via: "lock", recipients: 1 }] },
      { category: "csam" },
    );
    openConsole(`/admin/reports/${REPORT}`);
    await waitFor(() => expect(screen.getByText(/Operators told/)).toBeTruthy());
    expect(document.querySelector("[data-admin-not-reached]")).toBeNull();
  });
});

describe("no content, ever", () => {
  it.each([
    `/admin/reports/${REPORT}`,
    "/admin/reports",
    "/admin/quarantine",
    `/admin/quarantine/0199d3c2-7a10-7000-8000-0000000000a1`,
  ])(
    "%s requests no /t/, /i/ or /d/ URL and mints none, also for under_review and suspected_csam files",
    async (path) => {
      const calls = adminFetch();
      openConsole(path);
      await untilConsole();
      await waitFor(() => expect(document.querySelector("[data-admin-loading]")).toBeNull());
      expect(contentCalls(calls)).toEqual([]);
      expect(
        document.querySelector(
          'img, video, iframe, [data-thumb], a[href*="/d/"], a[href*="/i/"], a[href*="/t/"]',
        ),
      ).toBeNull();
    },
  );
});

describe("every screen renders its data from answers that parse as the contracts", () => {
  it.each(SCREENS)("$path", async ({ path }) => {
    adminFetch();
    openConsole(path);
    await untilConsole();
    await waitFor(() => expect(document.querySelector("[data-admin-loading]")).toBeNull());
    // The control of the error-state tests below: with good answers there is none.
    expect(consolePage()?.querySelector("[data-admin-error]")).toBeNull();
    expect(
      consolePage()?.querySelector(
        "[data-admin-part], [data-admin-system], [data-admin-settings], [data-admin-dashboard]",
      ),
    ).not.toBeNull();
  });
});

describe("every screen renders an error state, never a throw", () => {
  it.each(SCREENS.flatMap((screenEntry) => [404, 500].map((status) => ({ ...screenEntry, status }))))(
    "$path answering $status",
    async ({ path, read, status }) => {
      adminFetch((call) =>
        call.path.split("?")[0] === read
          ? envelope(status === 404 ? "not_found" : "internal", status)
          : undefined,
      );
      openConsole(path);
      await untilConsole();
      await waitFor(() => expect(consolePage()?.querySelector("[data-admin-error]")).not.toBeNull());
    },
  );
});

describe("nothing is polled", () => {
  it.each(SCREENS)("$path: one read when opened, none in ten minutes after", async ({ path, read }) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = adminFetch();
    openConsole(path);
    await untilConsole();
    await waitFor(() =>
      expect(adminCalls(calls).some((call) => call.path.split("?")[0] === read)).toBe(true),
    );
    await waitFor(() => expect(document.querySelector("[data-admin-loading]")).toBeNull());
    const before = adminCalls(calls).length;
    for (let minute = 0; minute < 10; minute++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(adminCalls(calls).length).toBe(before);
    expect(adminCalls(calls).filter((call) => call.path.split("?")[0] === read)).toHaveLength(1);
  });
});
