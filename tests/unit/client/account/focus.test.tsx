// R1 a11y-1 / a11y-13: where keyboard focus goes when an account control goes away. Two-factor setup
// swaps whole blocks (the buttons, the setup form, the backup codes); each swap moves focus to the
// block that appeared, never to <body>. The password prompt opens on its password field.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrefsSync } from "../../../../src/client/features/account/prefs-sync";
import { buildRoutes } from "../../../../src/client/router";
import { fileNode } from "../explorer/fixtures/nodes";
import {
  envelope,
  json,
  renderRoutes,
  sessionOf,
  setupShell,
  shellFetch,
  type MockHandler,
} from "../shell/helpers";

setupShell();
beforeEach(() => resetPrefsSync());

const ME = "a".repeat(32);
const PROFILE = { displayName: "Ada", email: "ada@example.com", timezone: "UTC", locale: "en", avatar: null };
const CREDENTIAL = [{ id: "acc1", providerId: "credential", accountId: ME }];
// Made-up TOTP key and codes: no real secret.
const URI = "otpauth://totp/Holdfast:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Holdfast";

function api({ twoFactor, accounts = CREDENTIAL }: { twoFactor: () => boolean; accounts?: unknown[] }) {
  const extra: MockHandler = (call) => {
    if (call.path.startsWith("/api/auth/get-session?"))
      return json({ user: { id: ME, twoFactorEnabled: twoFactor() }, session: {} });
    if (call.path === "/api/account/profile" && call.method === "GET") return json(PROFILE);
    if (call.path === "/api/auth/list-accounts") return json(accounts);
    if (call.path.startsWith("/api/auth/passkey/list-user-passkeys")) return json([]);
    return undefined;
  };
  return extra;
}

async function enterPassword(dialogName: string) {
  const dialog = await screen.findByRole("dialog", { name: dialogName });
  fireEvent.change(within(dialog).getByLabelText("Your password"), {
    target: { value: "made-up password 1" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /Continue|Turn off/ }));
  // The page is aria-hidden until the prompt has gone.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const focused = () => document.activeElement;

describe("two-factor setup keeps keyboard focus", () => {
  it("password → setup form → codes → done: focus follows each block, never <body>", async () => {
    let on = false;
    const base = api({ twoFactor: () => on });
    shellFetch({
      session: sessionOf(),
      extra: (call) => {
        if (call.path === "/api/auth/two-factor/enable")
          return json({ totpURI: URI, backupCodes: ["code-1", "code-2"] });
        if (call.path === "/api/auth/two-factor/verify-totp") {
          on = true;
          return json({ token: "x" });
        }
        return base(call);
      },
    });
    renderRoutes(buildRoutes(), ["/account/security"]);
    const turnOn = await screen.findByRole("button", { name: "Turn on" });
    turnOn.focus();
    fireEvent.click(turnOn);

    // a11y-13: the prompt opens on its password field — typing goes straight in.
    const prompt = await screen.findByRole("dialog", { name: "Set up two-factor authentication" });
    await waitFor(() => expect(focused()).toBe(within(prompt).getByLabelText("Your password")));
    await enterPassword("Set up two-factor authentication");

    const setup = await waitFor(() => {
      const form = document.querySelector<HTMLElement>("[data-two-factor-setup]");
      expect(form).not.toBeNull();
      return form!;
    });
    const setupHeading = within(setup).getByRole("heading", { name: "Set up two-factor authentication" });
    await waitFor(() => expect(focused()).toBe(setupHeading));

    fireEvent.change(within(setup).getByLabelText("6-digit code"), { target: { value: "123456" } });
    fireEvent.click(within(setup).getByRole("button", { name: "Verify" }));
    const codesHeading = await screen.findByRole("heading", { name: "Backup codes" });
    await waitFor(() => expect(focused()).toBe(codesHeading));

    fireEvent.click(screen.getByRole("button", { name: "I've saved my codes" }));
    const newCodes = await screen.findByRole("button", { name: "New backup codes" });
    await waitFor(() => expect(focused()).toBe(newCodes));
  });

  it("Cancel on the setup form returns focus to Turn on", async () => {
    const base = api({ twoFactor: () => false });
    shellFetch({
      session: sessionOf(),
      extra: (call) =>
        call.path === "/api/auth/two-factor/enable"
          ? json({ totpURI: URI, backupCodes: ["code-1"] })
          : base(call),
    });
    renderRoutes(buildRoutes(), ["/account/security"]);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await enterPassword("Set up two-factor authentication");
    const setup = await waitFor(() => {
      const form = document.querySelector<HTMLElement>("[data-two-factor-setup]");
      expect(form).not.toBeNull();
      return form!;
    });
    fireEvent.click(within(setup).getByRole("button", { name: "Cancel" }));
    const turnOn = await screen.findByRole("button", { name: "Turn on" });
    await waitFor(() => expect(focused()).toBe(turnOn));
  });

  it("Turn off: once the factor is off, focus lands on Turn on (not on the Turn off that went away)", async () => {
    let on = true;
    const base = api({ twoFactor: () => on });
    shellFetch({
      session: sessionOf(),
      extra: (call) => {
        if (call.path === "/api/auth/two-factor/disable") {
          on = false;
          return json({ status: true });
        }
        return base(call);
      },
    });
    renderRoutes(buildRoutes(), ["/account/security"]);
    const turnOff = await screen.findByRole("button", { name: "Turn off" });
    turnOff.focus();
    fireEvent.click(turnOff);
    await enterPassword("Turn off");
    const turnOn = await screen.findByRole("button", { name: "Turn on" });
    await waitFor(() => expect(focused()).toBe(turnOn));
  });

  it("New backup codes: focus goes to the codes", async () => {
    const base = api({ twoFactor: () => true });
    shellFetch({
      session: sessionOf(),
      extra: (call) =>
        call.path === "/api/auth/two-factor/generate-backup-codes"
          ? json({ status: true, backupCodes: ["code-9"] })
          : base(call),
    });
    renderRoutes(buildRoutes(), ["/account/security"]);
    fireEvent.click(await screen.findByRole("button", { name: "New backup codes" }));
    await enterPassword("New backup codes");
    const codesHeading = await screen.findByRole("heading", { name: "Backup codes" });
    await waitFor(() => expect(focused()).toBe(codesHeading));
  });

  it("the control: Cancel in the password prompt gives focus back to the button that opened it", async () => {
    const base = api({ twoFactor: () => false });
    shellFetch({ session: sessionOf(), extra: base });
    renderRoutes(buildRoutes(), ["/account/security"]);
    const turnOn = await screen.findByRole("button", { name: "Turn on" });
    turnOn.focus();
    fireEvent.click(turnOn);
    const prompt = await screen.findByRole("dialog", { name: "Set up two-factor authentication" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(focused()).toBe(turnOn));
  });
});

describe("the avatar button keeps keyboard focus while it is busy", () => {
  it("checking: aria-disabled (not disabled), a press sends nothing; on scanner_starting, Try again takes focus; pressing it gives focus back", async () => {
    let answer!: (response: Response) => void;
    let completes = 0;
    const calls = shellFetch({
      session: sessionOf(),
      extra: (call) => {
        if (call.path === "/api/uploads" && call.method === "POST")
          return json({
            uploadId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e",
            mode: "single",
            partBytes: 67108864,
            partCount: 1,
            resumedParts: [],
            finalName: "me.png",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        if (call.path.endsWith("/single")) return json({ etag: "e1" });
        if (call.path.endsWith("/complete")) {
          completes += 1;
          return new Promise<Response>((resolve) => (answer = resolve));
        }
        if (call.path === "/api/account/profile" && call.method === "GET") return json(PROFILE);
        if (call.path === "/api/auth/list-accounts") return json([]);
        return undefined;
      },
    });
    renderRoutes(buildRoutes(), ["/account"]);
    const button = await screen.findByRole("button", { name: "Upload picture" });
    button.focus();
    const input = document.querySelector<HTMLInputElement>("[data-avatar-input]")!;
    const picked = vi.spyOn(input, "click");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "me.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    const checking = await screen.findByRole("button", { name: "Checking your picture…" });
    expect(checking).toBe(button);
    expect((checking as HTMLButtonElement).disabled).toBe(false);
    expect(checking.getAttribute("aria-disabled")).toBe("true");
    expect(focused()).toBe(button);
    fireEvent.click(checking);
    expect(picked).not.toHaveBeenCalled();

    answer(envelope("scanner_starting", 503, undefined, { "Retry-After": "30" }));
    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    await waitFor(() => expect(focused()).toBe(tryAgain));

    fireEvent.click(tryAgain);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    expect(focused()).toBe(button);
    await waitFor(() => expect(completes).toBe(2));
    answer(json(fileNode(1, { scanStatus: "clean", name: "me.png" }), 201));
    expect(await screen.findByRole("button", { name: "Upload picture" })).toBe(button);
    expect(calls.filter((call) => call.path === "/api/uploads" && call.method === "POST")).toHaveLength(2);
  });
});
