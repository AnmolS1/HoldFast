// The DMCA detail offers only what the server accepts (review m6): `forward_counter` is refused
// before a counter-notice is in, so it is not offered on an `actioned` notice — nor once it has
// been forwarded. The detail shows when the counter-notice was received and the restore window,
// and says why a restore outside the window was refused (T30PREP, the window's both ends).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { envelope, setupShell } from "../shell/helpers";
import { adminFetch, AT, NODE, openConsole, untilConsole } from "./helpers";

setupShell();

const NOTICE = "0199d3c2-7a10-7000-8000-0000000000e5";

function notice(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: NOTICE,
    receivedAt: AT,
    receivedVia: "email",
    complainantName: "A. Rights-Holder",
    complainantOrg: null,
    complainantAddress: null,
    complainantPhone: null,
    complainantEmail: "legal@example.test",
    workDescription: "A photograph.",
    infringingDescription: "The named file.",
    statementGoodFaith: true,
    statementAccuracy: true,
    signature: "A. Rights-Holder",
    rawText: null,
    checklist: null,
    status,
    handledBy: null,
    takedownAt: AT,
    ownerNotifiedAt: AT,
    strikeId: null,
    createdAt: AT,
    updatedAt: AT,
    counterReceivedAt: status === "counter_received" ? AT : null,
    counterName: null,
    counterAddress: null,
    counterPhone: null,
    counterEmail: null,
    counterStatement: null,
    counterConsentJurisdiction: null,
    counterSignature: null,
    counterForwardedAt: null,
    restoreNotBefore: null,
    restoreNotAfter: null,
    lawsuitNoticeAt: null,
    restoredAt: null,
    restoredBy: null,
    nodes: [{ nodeId: NODE, nodeName: "file.bin", sha256: null, tookDown: true }],
    ...extra,
  };
}

const FORWARDED = {
  counterReceivedAt: "2028-11-03T12:00:00.000Z",
  counterForwardedAt: "2028-11-06T09:00:00.000Z",
  restoreNotBefore: "2028-11-20T12:00:00.000Z",
  restoreNotAfter: "2028-11-27T23:59:59.999Z",
};

async function buttonsFor(status: string, extra: Record<string, unknown> = {}) {
  const fixtures: Record<string, unknown> = { [`/api/admin/dmca/${NOTICE}`]: notice(status, extra) };
  adminFetch((call) =>
    call.method === "GET" && call.path in fixtures
      ? new Response(JSON.stringify(fixtures[call.path]), { headers: { "content-type": "application/json" } })
      : undefined,
  );
  const view = openConsole(`/admin/dmca/${NOTICE}`);
  await untilConsole();
  // Every status offered here has a withdraw button: the detail has rendered once it is there.
  await waitFor(() => expect(screen.getByRole("button", { name: "Withdrawn by complainant" })).toBeTruthy(), {
    timeout: 10_000,
  });
  const names = screen.queryAllByRole("button").map((button) => button.textContent ?? "");
  view.unmount();
  return names;
}

describe("the DMCA detail's actions", () => {
  it("an actioned notice does not offer Forward counter-notice; a counter_received one does", async () => {
    expect(await buttonsFor("actioned")).not.toContain("Forward counter-notice");
    expect(await buttonsFor("counter_received")).toContain("Forward counter-notice");
  });
});

describe("the counter-notice window in the detail", () => {
  it("a forwarded notice is not offered Forward again", async () => {
    expect(await buttonsFor("counter_received", FORWARDED)).not.toContain("Forward counter-notice");
  });

  it("shows when the counter-notice was received and the window; a restore after the window is refused with its reason", async () => {
    adminFetch((call) => {
      if (call.method === "GET" && call.path === `/api/admin/dmca/${NOTICE}`) {
        return new Response(JSON.stringify(notice("counter_received", FORWARDED)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (call.method === "POST" && call.path === `/api/admin/dmca/${NOTICE}/action`) {
        return envelope("conflict", 409, {
          reason: "after_window",
          restoreNotAfter: FORWARDED.restoreNotAfter,
        });
      }
      return undefined;
    });
    const view = openConsole(`/admin/dmca/${NOTICE}`);
    await untilConsole();
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy(), {
      timeout: 10_000,
    });
    expect(screen.getByText("Counter-notice received on")).toBeTruthy();
    expect(screen.getByText(/^From .+ to .+$/)).toBeTruthy();
    expect(screen.getByText(/after the counter-notice was received/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Note \(recorded in the audit log\)/), {
      target: { value: "Late." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(within(dialog).getByText("Restore is possible only until the end of the window.")).toBeTruthy(),
    );
    view.unmount();
  });
});
