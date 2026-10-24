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

/** A window far in the future (open on the client's clock), and one long closed. */
const OPEN = {
  counterReceivedAt: "2026-01-02T12:00:00.000Z",
  counterForwardedAt: "2026-01-02T13:00:00.000Z",
  restoreNotBefore: "2026-01-16T12:00:00.000Z",
  restoreNotAfter: "2099-12-31T23:59:59.999Z",
};
const CLOSED = {
  counterReceivedAt: "2026-01-02T12:00:00.000Z",
  counterForwardedAt: null,
  restoreNotBefore: "2026-01-16T12:00:00.000Z",
  restoreNotAfter: "2026-01-23T23:59:59.999Z",
};

const FORWARDED = {
  counterReceivedAt: "2028-11-03T12:00:00.000Z",
  counterForwardedAt: "2028-11-06T09:00:00.000Z",
  restoreNotBefore: "2028-11-20T13:00:00.000Z",
  restoreNotAfter: "2028-11-28T04:59:59.999Z",
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

  it("the window's dates are New York dates with the zone named, whatever the viewer's zone", async () => {
    adminFetch((call) =>
      call.method === "GET" && call.path === `/api/admin/dmca/${NOTICE}`
        ? new Response(JSON.stringify(notice("counter_received", FORWARDED)), {
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    const view = openConsole(`/admin/dmca/${NOTICE}`);
    await untilConsole();
    // 2028-11-28T04:59:59.999Z is the end of 27 November in New York (EST): never "28 November".
    const row = await screen.findByText(/^From .+ to .+$/, undefined, { timeout: 10_000 });
    expect(row.textContent).toBe(
      "From Nov 20, 2028, 08:00 (US Eastern) to November 27, 2028 (end of day, US Eastern)",
    );
    view.unmount();
  });

  it("the counter-notice's receipt is shown as a New York time with the zone named — day 0 of the window (safety-n1)", async () => {
    // 02:00 UTC on 3 November is still 2 November in New York (EDT): never "Nov 3".
    adminFetch((call) =>
      call.method === "GET" && call.path === `/api/admin/dmca/${NOTICE}`
        ? new Response(
            JSON.stringify(
              notice("counter_received", { ...FORWARDED, counterReceivedAt: "2028-11-03T02:00:00.000Z" }),
            ),
            { headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    const view = openConsole(`/admin/dmca/${NOTICE}`);
    await untilConsole();
    expect(
      await screen.findByText("Nov 02, 2028, 22:00 (US Eastern)", undefined, { timeout: 10_000 }),
    ).toBeTruthy();
    view.unmount();
  });

  it("shows when the counter-notice was received and the window; a refused restore says why", async () => {
    adminFetch((call) => {
      if (call.method === "GET" && call.path === `/api/admin/dmca/${NOTICE}`) {
        // A window far ahead: the restore is inside it on the client's clock; the server refuses.
        return new Response(JSON.stringify(notice("counter_received", OPEN)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (call.method === "POST" && call.path === `/api/admin/dmca/${NOTICE}/action`) {
        return envelope("conflict", 409, { reason: "window_closed", restoreNotAfter: OPEN.restoreNotAfter });
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
    // Inside the window: no acknowledgement asked for.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/Note \(recorded in the audit log\)/), {
      target: { value: "Late." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(within(dialog).getByText(/past the 14-business-day window/)).toBeTruthy());
    view.unmount();
  });

  it("after the window: Forward is not offered (and the detail says why); Restore asks for the late acknowledgement and sends acknowledgeLate", async () => {
    const posted: unknown[] = [];
    adminFetch((call) => {
      if (call.method === "GET" && call.path === `/api/admin/dmca/${NOTICE}`) {
        return new Response(JSON.stringify(notice("counter_received", CLOSED)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (call.method === "POST" && call.path === `/api/admin/dmca/${NOTICE}/action`) {
        posted.push(call.body);
        return new Response(JSON.stringify(notice("restored", { ...CLOSED, restoredAt: AT })), {
          headers: { "content-type": "application/json" },
        });
      }
      return undefined;
    });
    const view = openConsole(`/admin/dmca/${NOTICE}`);
    await untilConsole();
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy(), {
      timeout: 10_000,
    });
    expect(screen.queryByRole("button", { name: "Forward counter-notice" })).toBeNull();
    expect(screen.getByText(/can no longer be forwarded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Note \(recorded in the audit log\)/), {
      target: { value: "Missed the window." },
    });
    const confirm = within(dialog).getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /past the 14-business-day window/ }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ action: "restore", acknowledgeLate: true, note: "Missed the window." });
    view.unmount();
  });
});
