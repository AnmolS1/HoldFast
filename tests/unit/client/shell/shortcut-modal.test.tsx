// A page's shortcut must not act through a modal dialog, and work that outlives its request can
// tell that the account changed underneath it.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountEpoch, purgeUserState, sameAccount } from "../../../../src/client/lib/query";
import { modalOpen, useShortcut, type ShortcutId } from "../../../../src/client/lib/shortcuts";

function Probe({ id, onFire }: { id: ShortcutId; onFire: () => void }) {
  useShortcut(id, onFire);
  return null;
}

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("shortcuts and modal dialogs", () => {
  it("a page shortcut fires on the page and not while a modal dialog is open", () => {
    const fired = vi.fn();
    render(<Probe id="rename" onFire={fired} />);
    press("F2");
    expect(fired).toHaveBeenCalledTimes(1);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    expect(modalOpen(document.body)).toBe(true);

    press("F2"); // focus on the body, the dialog open
    press("F2", {}, inside); // pressed inside the dialog
    expect(fired).toHaveBeenCalledTimes(1);

    dialog.remove();
    press("F2");
    expect(fired).toHaveBeenCalledTimes(2);
  });

  it("a key pressed inside a dialog that is not marked modal is still not the page's", () => {
    const fired = vi.fn();
    render(<Probe id="rename" onFire={fired} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    press("F2", {}, inside);
    expect(fired).not.toHaveBeenCalled();
  });

  it("a global shortcut still fires with a dialog open", () => {
    const fired = vi.fn();
    render(<Probe id="escape" onFire={fired} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    document.body.append(dialog);
    press("Escape");
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe("the account epoch", () => {
  it("changes on every purge, so late work can tell the account changed", async () => {
    const then = accountEpoch();
    expect(sameAccount(then)).toBe(true);
    await purgeUserState();
    expect(sameAccount(then)).toBe(false);
    const again = accountEpoch();
    await purgeUserState({ keepSession: true });
    expect(sameAccount(again)).toBe(false);
  });
});
