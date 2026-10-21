// The dangerous-type interstitial (T22 step 5): the real component in place of T08's
// pass-through stub — it goes on ONLY on an explicit click — and the public page's decision over
// the server's `dangerous` flag (the rule over names and sniffed types is the Worker's, tested in
// tests/unit/abuse/dangerous.test.ts). Every token and URL is made up.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DangerousFileInterstitial } from "../../../../src/client/features/interstitial";
import { dangerKind } from "../../../../src/client/features/interstitial/kind";
import { messages } from "../../../../src/client/features/interstitial/strings";
import {
  FILE_ID,
  info,
  json,
  minted,
  openPublic,
  publicCalls,
  publicFile,
  publicPath,
  setupShell,
} from "../sharing/helpers";
import { renderShell } from "../shell/helpers";

setupShell();

function show(fileName = "setup.exe") {
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  const view = renderShell(
    <DangerousFileInterstitial fileName={fileName} onContinue={onContinue} onCancel={onCancel} />,
  );
  return { onContinue, onCancel, view, dialog: screen.getByRole("dialog") };
}

describe("DangerousFileInterstitial", () => {
  it("shows the warning and calls NOTHING on mount or on a re-render (the stub called onContinue at once)", () => {
    const { onContinue, onCancel, view, dialog } = show();
    expect(within(dialog).getByText("Download setup.exe?")).toBeTruthy();
    expect(within(dialog).getByText(messages["danger.program"])).toBeTruthy();
    view.rerender(
      <DangerousFileInterstitial fileName="setup.exe" onContinue={onContinue} onCancel={onCancel} />,
    );
    expect(onContinue).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("goes on only on 'Download anyway' — once; Cancel, Escape and the focus start on the safe side", () => {
    const first = show();
    // Enter by reflex does not download: the focus is on Cancel.
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(first.dialog).getByRole("button", { name: "Download anyway" }));
    expect(first.onContinue).toHaveBeenCalledTimes(1);
    expect(first.onCancel).not.toHaveBeenCalled();
    first.view.unmount();

    const second = show();
    fireEvent.click(within(second.dialog).getByRole("button", { name: "Cancel" }));
    expect(second.onCancel).toHaveBeenCalledTimes(1);
    expect(second.onContinue).not.toHaveBeenCalled();
    second.view.unmount();

    const third = show();
    fireEvent.keyDown(third.dialog, { key: "Escape" });
    expect(third.onCancel).toHaveBeenCalledTimes(1);
    expect(third.onContinue).not.toHaveBeenCalled();
  });

  it.each([
    ["setup.exe", "program"],
    ["Installer.MSI", "program"],
    ["tool.jar", "program"],
    ["run.sh", "script"],
    ["macro.vbs", "script"],
    ["disk.iso", "image"],
    ["app.dmg", "image"],
    ["link.lnk", "settings"],
    ["tweak.reg", "settings"],
    ["photo.jpg", "other"],
    ["no-extension", "other"],
  ] as const)("%s: one sentence of what that kind of file can do (%s)", (name, kind) => {
    expect(dangerKind(name)).toBe(kind);
    const view = render(
      <DangerousFileInterstitial fileName={name} onContinue={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByText(messages[`danger.${kind}`])).toBeTruthy();
    view.unmount();
  });
});

describe("the public page's decision, over the server's `dangerous` flag", () => {
  const mintsOf = (calls: { path: string; body: unknown }[]) =>
    calls.filter((call) => call.path === publicPath("/download-url")).map((call) => call.body);

  it("dangerous: Download shows the warning and mints NOTHING until the click — then one mint with dangerousAck", async () => {
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFile({ name: "setup.exe", ext: "exe" }), { dangerous: true }),
      [`POST ${publicPath("/download-url")}`]: json(minted()),
    });
    await screen.findByRole("heading", { name: "setup.exe" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const dialog = await screen.findByRole("dialog", { name: "Download setup.exe?" });
    expect(publicCalls(calls)).not.toContain("POST /download-url");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download anyway" }));
    await waitFor(() => expect(publicCalls(calls)).toContain("POST /download-url"));
    expect(mintsOf(calls)).toEqual([{ nodeId: FILE_ID, kind: "download", dangerousAck: true }]);
  });

  it("dangerous, cancelled: nothing is minted", async () => {
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFile({ name: "setup.exe", ext: "exe" }), { dangerous: true }),
      [`POST ${publicPath("/download-url")}`]: json(minted()),
    });
    await screen.findByRole("heading", { name: "setup.exe" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const dialog = await screen.findByRole("dialog", { name: "Download setup.exe?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Download setup.exe?" })).toBeNull());
    expect(mintsOf(calls)).toEqual([]);
  });

  it("not dangerous: no warning, one mint without an ack", async () => {
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFile(), { dangerous: false }),
      [`POST ${publicPath("/download-url")}`]: json(minted()),
    });
    await screen.findByRole("heading", { name: "report.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(publicCalls(calls)).toContain("POST /download-url"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mintsOf(calls)).toEqual([{ nodeId: FILE_ID, kind: "download" }]);
  });
});
