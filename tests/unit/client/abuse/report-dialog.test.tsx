// The report form (T22 step 4): validation, the two submit targets, one request per click, the
// wait a 429 names, and an account change while a submit is in flight.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { REPORT_WAIT_KEY } from "../../../../src/client/features/report/api";
import { ReportDialog, ReportLink } from "../../../../src/client/features/report";
import { adoptIdentity, clearWaits, purgeUserState, waitUntil } from "../../../../src/client/lib/query";
import { deferred } from "../views/helpers";
import {
  envelope,
  json,
  mockFetch,
  renderShell,
  seedSession,
  sessionOf,
  setupShell,
  type MockCall,
} from "../shell/helpers";
import { DUMMY_TOKEN, seedConfig, stubTurnstile } from "./helpers";

setupShell();

const NODE = "0199d3c2-7a10-7000-8000-0000000000f1";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

const reportCalls = (calls: MockCall[]) =>
  calls.filter((call) => call.method === "POST" && /^\/api\/(public\/report|reports)$/.test(call.path));

function answer(handler: (call: MockCall) => Response | Promise<Response>) {
  return mockFetch((call) =>
    call.method === "POST" && /^\/api\/(public\/report|reports)$/.test(call.path) ? handler(call) : undefined,
  );
}

/** A signed-in account: the identity the API client pins, and the cached session the shell reads. */
async function signIn() {
  seedSession(sessionOf());
  await adoptIdentity(sessionOf());
}

let turnstile: ReturnType<typeof stubTurnstile>;
beforeEach(() => {
  // A wait an earlier case recorded is that case's (the registry is the shell's, module-wide).
  clearWaits();
  seedConfig();
  turnstile = stubTurnstile();
});

async function openFromLink(linkToken?: string) {
  renderShell(<ReportLink target={{ nodeId: NODE, ...(linkToken ? { linkToken } : {}) }} />);
  fireEvent.click(screen.getByRole("button", { name: "Report" }));
  const dialog = await screen.findByRole("dialog", { name: "Report this file" });
  // The widget has handed over its token.
  await waitFor(() => expect(dialog.querySelector("[data-turnstile='ready']")).not.toBeNull());
  return dialog;
}

function choose(dialog: HTMLElement, label: string) {
  fireEvent.click(within(dialog).getByLabelText(label));
}

const send = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole("button", { name: "Send report" }));

describe("ReportLink and ReportDialog", () => {
  it("with a link token: the public route, with the category, details, the optional address and the Turnstile token — then the plain confirmation", async () => {
    const calls = answer(() => json({ received: true }, 202));
    const dialog = await openFromLink(TOKEN);
    for (const label of [
      "Malware or a virus",
      "Child sexual abuse material",
      "Copyright infringement",
      "Phishing or a scam",
      "Spam",
      "Something else",
    ]) {
      expect(within(dialog).getByLabelText(label)).toBeTruthy();
    }
    choose(dialog, "Phishing or a scam");
    fireEvent.change(within(dialog).getByLabelText(/Details/), {
      target: { value: "It asks for a bank login." },
    });
    fireEvent.change(within(dialog).getByLabelText(/Your email/), { target: { value: "me@example.test" } });
    send(dialog);
    expect(await within(dialog).findByText("Thanks. The file is hidden while we review it.")).toBeTruthy();
    expect(reportCalls(calls).map((call) => [call.path, call.body])).toEqual([
      [
        "/api/public/report",
        {
          nodeId: NODE,
          linkToken: TOKEN,
          category: "phishing",
          details: "It asks for a bank login.",
          reporterEmail: "me@example.test",
          turnstileToken: DUMMY_TOKEN,
        },
      ],
    ]);
  });

  it("without a token, signed in: the signed-in route — no address field, no token and no address sent", async () => {
    await signIn();
    const calls = answer(() => json({ received: true }, 202));
    const dialog = await openFromLink();
    expect(within(dialog).queryByLabelText(/Your email/)).toBeNull();
    choose(dialog, "Spam");
    send(dialog);
    await within(dialog).findByText("Thanks. The file is hidden while we review it.");
    expect(reportCalls(calls).map((call) => [call.path, call.body])).toEqual([
      ["/api/reports", { nodeId: NODE, category: "spam", details: "", turnstileToken: DUMMY_TOKEN }],
    ]);
  });

  it("without a token and nobody signed in (a public page's preview): nothing is offered", () => {
    const view = renderShell(<ReportLink target={{ nodeId: NODE }} />);
    expect(view.container.innerHTML).toBe("");
    // Control: with the token it is offered.
    const withToken = renderShell(<ReportLink target={{ nodeId: NODE, linkToken: TOKEN }} />);
    expect(within(withToken.container).getByRole("button", { name: "Report" })).toBeTruthy();
  });

  it("validation before anything is sent: no category; an address that is not one; the details are cut at 4,000", async () => {
    const calls = answer(() => json({ received: true }, 202));
    const dialog = await openFromLink(TOKEN);
    send(dialog);
    expect(await within(dialog).findByText("Choose what the problem is.")).toBeTruthy();
    choose(dialog, "Spam");
    fireEvent.change(within(dialog).getByLabelText(/Your email/), { target: { value: "not an address" } });
    send(dialog);
    expect(await within(dialog).findByText("Enter a valid email address, or leave it empty.")).toBeTruthy();
    const details = within(dialog).getByLabelText(/Details/) as HTMLTextAreaElement;
    fireEvent.change(details, { target: { value: "x".repeat(4500) } });
    expect(details.value).toHaveLength(4000);
    expect(reportCalls(calls)).toEqual([]);
  });

  it("no Turnstile token yet: it says to wait, and sends nothing", async () => {
    window.turnstile = { render: () => "w1", reset() {}, remove() {} }; // a widget that never answers
    const calls = answer(() => json({ received: true }, 202));
    renderShell(<ReportLink target={{ nodeId: NODE, linkToken: TOKEN }} />);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    const dialog = await screen.findByRole("dialog", { name: "Report this file" });
    choose(dialog, "Spam");
    send(dialog);
    expect(
      await within(dialog).findByText("Wait for the check to finish, then send the report."),
    ).toBeTruthy();
    expect(reportCalls(calls)).toEqual([]);
  });

  it("one request per click: a second click while it is on its way sends nothing more", async () => {
    const slow = deferred<Response>();
    const calls = answer(() => slow.promise);
    const dialog = await openFromLink(TOKEN);
    choose(dialog, "Spam");
    send(dialog);
    await waitFor(() => expect(reportCalls(calls)).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "Sending…" })).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sending…" }));
    await act(async () => slow.resolve(json({ received: true }, 202)));
    await within(dialog).findByText("Thanks. The file is hidden while we review it.");
    expect(reportCalls(calls)).toHaveLength(1);
  });

  it("a 429 with Retry-After: said in words, the wait recorded in the shell's registry, the send button off — and nothing retried", async () => {
    const calls = answer(() => envelope("rate_limited", 429, undefined, { "Retry-After": "3600" }));
    const dialog = await openFromLink(TOKEN);
    choose(dialog, "Spam");
    send(dialog);
    expect(await within(dialog).findByText(/You have sent several reports today/)).toBeTruthy();
    expect(waitUntil(REPORT_WAIT_KEY)).toBeGreaterThan(Date.now() + 3_500_000);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Send report" })).toHaveProperty("disabled", true),
    );
    expect(reportCalls(calls)).toHaveLength(1);
    // The spent token was replaced.
    expect(turnstile.resets()).toBe(1);
  });

  it.each([
    ["not_found", () => envelope("not_found", 404), "This file can't be reported from here any more."],
    [
      "a failed check",
      () => envelope("forbidden", 403, { code: "VERIFICATION_FAILED" }),
      "The check didn't pass. Try again.",
    ],
    [
      "the check unavailable",
      () => envelope("feature_disabled", 503, { reason: "captcha_unavailable" }),
      "The check could not be completed. Try again in a moment.",
    ],
  ])("%s: its own words, the form kept for another try", async (_name, response, words) => {
    answer(response);
    const dialog = await openFromLink(TOKEN);
    choose(dialog, "Spam");
    send(dialog);
    expect(await within(dialog).findByText(words)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send report" })).toBeTruthy();
  });
});

describe("ReportDialog — an account change while a submit is in flight", () => {
  it("the dialog closes with the account, shows no confirmation to the next one, and keeps no draft", async () => {
    await signIn();
    const slow = deferred<Response>();
    const calls = answer(() => slow.promise);
    let closes = 0;
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <ReportDialog
            open={open}
            onClose={() => {
              closes += 1;
              setOpen(false);
            }}
            target={{ nodeId: NODE }}
          />
        </>
      );
    }
    renderShell(<Host />);
    let dialog = await screen.findByRole("dialog", { name: "Report this file" });
    await waitFor(() => expect(dialog.querySelector("[data-turnstile='ready']")).not.toBeNull());
    choose(dialog, "Spam");
    fireEvent.change(within(dialog).getByLabelText(/Details/), { target: { value: "draft words" } });
    send(dialog);
    await waitFor(() => expect(reportCalls(calls)).toHaveLength(1));

    await act(() => purgeUserState({ keepSession: true }));
    expect(closes).toBe(1);
    await act(async () => slow.resolve(json({ received: true }, 202)));
    expect(screen.queryByText("Thanks. The file is hidden while we review it.")).toBeNull();

    // Opened again for the next account: an empty form.
    // (the closed dialog may still hide its siblings from the accessibility tree while it fades)
    fireEvent.click(screen.getByText("reopen"));
    dialog = await screen.findByRole("dialog", { name: "Report this file" });
    expect((within(dialog).getByLabelText(/Details/) as HTMLTextAreaElement).value).toBe("");
    expect(within(dialog).queryByText("Thanks. The file is hidden while we review it.")).toBeNull();
  });
});
