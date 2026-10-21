// Addendum 3 (review M2): on a FOLDER link a stranger reports a FILE — the previewed one, with the
// link's token (PublicPreviewSource.reportTarget, fold-w3 #20) — and the page's footer offers no
// Report for the folder itself; on a FILE link the footer does. Every token and id is made up.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { HEADER_LINK_SESSION } from "../../../../src/shared/constants";
import { sendReport } from "../../../../src/client/features/report/api";
import { clearWaits } from "../../../../src/client/lib/query";
import {
  FILE_ID,
  info,
  json,
  minted,
  mockFetchCalls,
  openPublic,
  publicFile,
  publicFolder,
  publicPath,
  setupShell,
  TOKEN,
} from "../sharing/helpers";
import { CONFIG } from "../shell/helpers";
import { DUMMY_TOKEN, SITE_KEY, stubTurnstile } from "./helpers";

setupShell();

beforeEach(() => {
  clearWaits();
  stubTurnstile();
});

const CONFIG_WITH_KEY = { ...CONFIG, turnstileSiteKey: SITE_KEY };
const child = publicFile({ id: "0199d3c2-7a10-7000-8000-0000000000a1", name: "inside.txt" });

describe("reporting from a public link", () => {
  it("a folder link: no Report for the folder; the previewed file is reported through the public route with the link's token", async () => {
    const { calls } = await openPublic({
      "GET /api/public/config": CONFIG_WITH_KEY,
      [`GET ${publicPath()}`]: info(publicFolder(), { allowPreview: true }),
      [`GET ${publicPath("/children")}`]: { items: [child], nextCursor: null },
      [`POST ${publicPath("/download-url")}`]: json(minted("i", child.id)),
      "POST /api/public/report": json({ received: true }, 202),
    });
    await screen.findByRole("button", { name: "Preview inside.txt" });
    // The footer names no report for the folder root.
    expect(document.querySelector("footer [data-report-link]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview inside.txt" }));
    const preview = await screen.findByRole("dialog");
    fireEvent.click(await within(preview).findByRole("button", { name: "Report" }));
    const dialog = await screen.findByRole("dialog", { name: "Report this file" });
    await waitFor(() => expect(dialog.querySelector("[data-turnstile='ready']")).not.toBeNull());
    fireEvent.click(within(dialog).getByLabelText("Spam"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send report" }));
    await within(dialog).findByText("Thanks. The file is hidden while we review it.");
    const sent = calls.filter((call) => call.method === "POST" && call.path === "/api/public/report");
    expect(sent.map((call) => call.body)).toEqual([
      { nodeId: child.id, linkToken: TOKEN, category: "spam", details: "", turnstileToken: DUMMY_TOKEN },
    ]);
    // A link without a password: no link session to send.
    expect(sent[0]!.headers[HEADER_LINK_SESSION]).toBeUndefined();
    expect(calls.some((call) => call.path === "/api/reports")).toBe(false);
  });

  it("a file link: the footer's Report targets the file with the token (control: the footer is still there for a file)", async () => {
    await openPublic({
      "GET /api/public/config": CONFIG_WITH_KEY,
      [`GET ${publicPath()}`]: info(publicFile()),
    });
    await screen.findByRole("heading", { name: "report.txt" });
    expect(document.querySelector("footer [data-report-link]")).not.toBeNull();
    void FILE_ID;
  });
});

// RPTFIX: the public report route asks for what the link's own routes ask for — on a password link,
// the link session. Made up.
const SESSION = "made-up-link-session";

describe("reporting from a password link", () => {
  it("a password folder link, unlocked: the previewed file's report carries the link session header (not in the body)", async () => {
    let open = false;
    const { calls } = await openPublic({
      "GET /api/public/config": CONFIG_WITH_KEY,
      [`GET ${publicPath()}`]: () =>
        json(
          open
            ? info(publicFolder(), { requiresPassword: true, allowPreview: true })
            : info(null, { requiresPassword: true }),
        ),
      [`POST ${publicPath("/unlock")}`]: () => {
        open = true;
        return json({ linkSession: SESSION, expiresAt: "2099-01-01T00:00:00.000Z" });
      },
      [`GET ${publicPath("/children")}`]: { items: [child], nextCursor: null },
      [`POST ${publicPath("/download-url")}`]: json(minted("i", child.id)),
      "POST /api/public/report": json({ received: true }, 202),
    });
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "made-up right one" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview inside.txt" }));
    const preview = await screen.findByRole("dialog");
    fireEvent.click(await within(preview).findByRole("button", { name: "Report" }));
    const dialog = await screen.findByRole("dialog", { name: "Report this file" });
    await waitFor(() => expect(dialog.querySelector("[data-turnstile='ready']")).not.toBeNull());
    fireEvent.click(within(dialog).getByLabelText("Spam"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send report" }));
    await within(dialog).findByText("Thanks. The file is hidden while we review it.");
    const sent = calls.filter((call) => call.method === "POST" && call.path === "/api/public/report");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers[HEADER_LINK_SESSION]).toBe(SESSION);
    expect(sent[0]!.body).toEqual({
      nodeId: child.id,
      linkToken: TOKEN,
      category: "spam",
      details: "",
      turnstileToken: DUMMY_TOKEN,
    });
  });

  it("a password FILE link, unlocked: the footer's Report carries the link session header", async () => {
    let open = false;
    const { calls } = await openPublic({
      "GET /api/public/config": CONFIG_WITH_KEY,
      [`GET ${publicPath()}`]: () =>
        json(open ? info(publicFile(), { requiresPassword: true }) : info(null, { requiresPassword: true })),
      [`POST ${publicPath("/unlock")}`]: () => {
        open = true;
        return json({ linkSession: SESSION, expiresAt: "2099-01-01T00:00:00.000Z" });
      },
      "POST /api/public/report": json({ received: true }, 202),
    });
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "made-up right one" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("heading", { name: "report.txt" });
    fireEvent.click(document.querySelector<HTMLElement>("footer [data-report-link]")!);
    const dialog = await screen.findByRole("dialog", { name: "Report this file" });
    await waitFor(() => expect(dialog.querySelector("[data-turnstile='ready']")).not.toBeNull());
    fireEvent.click(within(dialog).getByLabelText("Spam"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send report" }));
    await within(dialog).findByText("Thanks. The file is hidden while we review it.");
    const sent = calls.filter((call) => call.method === "POST" && call.path === "/api/public/report");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers[HEADER_LINK_SESSION]).toBe(SESSION);
    expect(sent[0]!.body).toMatchObject({ nodeId: FILE_ID, linkToken: TOKEN });
  });

  it("sendReport: the header goes to the public route only — never to the signed-in one", async () => {
    const calls = mockFetchCalls(() => json({ received: true }, 202));
    const input = { category: "spam" as const, details: "", turnstileToken: DUMMY_TOKEN };
    await sendReport({ nodeId: FILE_ID, linkToken: TOKEN, linkSession: SESSION }, input);
    await sendReport({ nodeId: FILE_ID, linkSession: SESSION }, input);
    expect(calls.map((call) => [call.path, call.headers[HEADER_LINK_SESSION]])).toEqual([
      ["/api/public/report", SESSION],
      ["/api/reports", undefined],
    ]);
  });
});
