// The DMCA detail offers only what the server accepts (review m6): `forward_counter` is refused
// before a counter-notice is in, so it is not offered on an `actioned` notice.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupShell } from "../shell/helpers";
import { adminFetch, AT, NODE, openConsole, untilConsole } from "./helpers";

setupShell();

const NOTICE = "0199d3c2-7a10-7000-8000-0000000000e5";

function notice(status: string) {
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
  };
}

async function buttonsFor(status: string) {
  const fixtures: Record<string, unknown> = { [`/api/admin/dmca/${NOTICE}`]: notice(status) };
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
