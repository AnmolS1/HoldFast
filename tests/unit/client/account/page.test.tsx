// The account page (features/account): what each section sends and how it answers the server's
// refusals — against a scripted API.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrefsSync } from "../../../../src/client/features/account/prefs-sync";
import { getToasts } from "../../../../src/client/components/Toaster";
import { IDENTITY_HEADER } from "../../../../src/client/lib/api";
import { buildRoutes } from "../../../../src/client/router";
import { fileNode } from "../explorer/fixtures/nodes";
import {
  envelope,
  json,
  renderRoutes,
  sessionOf,
  setupShell,
  shellFetch,
  type MockCall,
  type MockHandler,
} from "../shell/helpers";

setupShell();
beforeEach(() => resetPrefsSync());

const ME = "a".repeat(32);
const PROFILE = {
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  timezone: "UTC",
  locale: "en",
  avatar: null,
};
const PREFS = {
  density: "compact",
  theme: "system",
  viewMode: "list",
  emailShares: true,
  emailLinkDigest: true,
  emailSecurity: true,
};
const CREDENTIAL = [{ id: "acc1", providerId: "credential", accountId: ME }];

/** Better Auth's error body, as its handler answers a refusal. */
const authError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json({ code, message: `${code} message` }, status, headers);

function api(extra: MockHandler = () => undefined) {
  return shellFetch({
    session: sessionOf(),
    extra: (call) => {
      const own = extra(call);
      if (own) return own;
      if (call.path === "/api/account/profile" && call.method === "GET") return json(PROFILE);
      if (call.path === "/api/account/prefs" && call.method === "GET") return json(PREFS);
      if (call.path === "/api/auth/list-accounts") return json(CREDENTIAL);
      if (call.path.startsWith("/api/auth/passkey/list-user-passkeys")) return json([]);
      return undefined;
    },
  });
}

const header = (call: MockCall | undefined) => new Headers(call?.headers).get(IDENTITY_HEADER);
const page = () => document.querySelector("[data-account-page]");

describe("the page", () => {
  it("replaces the placeholder: its own sections at their own addresses", async () => {
    api();
    renderRoutes(buildRoutes(), ["/account"]);
    await waitFor(() => expect(page()).not.toBeNull());
    expect(document.querySelector('[data-placeholder-page="Account"]')).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Account sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Profile", "Preferences", "Security", "Devices", "Your data"]);
    expect(await screen.findByRole("heading", { name: "Display name" })).toBeTruthy();
  });

  it("an API answering 404 everywhere is an error state, never a crash", async () => {
    shellFetch({ session: sessionOf() });
    renderRoutes(buildRoutes(), ["/account"]);
    await waitFor(() => expect(document.querySelector("[data-account-error]")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("profile", () => {
  async function openEmailForm() {
    renderRoutes(buildRoutes(), ["/account"]);
    fireEvent.click(await screen.findByRole("button", { name: "Change email" }));
    fireEvent.change(screen.getByLabelText("New email address"), { target: { value: "new@example.com" } });
  }

  it("the change of address sends the password with the new address, through the pinned client", async () => {
    const calls = api((call) =>
      call.path === "/api/auth/change-email" ? json({ status: true }) : undefined,
    );
    await openEmailForm();
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "made-up password 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation" }));
    expect(await screen.findByText("Check ada@example.com for a link to confirm the change.")).toBeTruthy();
    const sent = calls.find((call) => call.path === "/api/auth/change-email")!;
    expect(sent.body).toMatchObject({
      newEmail: "new@example.com",
      password: "made-up password 1",
      callbackURL: "/account",
    });
    expect(header(sent)).toBe(ME);
  });

  it("INVALID_PASSWORD and SESSION_NOT_FRESH are told apart", async () => {
    let answer = authError(400, "INVALID_PASSWORD");
    api((call) => (call.path === "/api/auth/change-email" ? answer.clone() : undefined));
    await openEmailForm();
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "wrong one" } });
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation" }));
    const wrong = await screen.findByText("That password isn't right.");
    expect(wrong.closest('[role="alert"]')).not.toBeNull();
    expect(document.querySelector("[data-reauth-needed]")).toBeNull();

    answer = authError(403, "SESSION_NOT_FRESH");
    fireEvent.click(screen.getByRole("button", { name: "Send confirmation" }));
    await waitFor(() => expect(document.querySelector("[data-reauth-needed]")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.queryByText("That password isn't right.")).toBeNull();
  });

  it("/account?email=unavailable shows its notice, and the parameter leaves the address", async () => {
    api();
    const { router } = renderRoutes(buildRoutes(), ["/account?email=unavailable"]);
    const notice = await waitFor(() => {
      const node = document.querySelector("[data-email-unavailable]");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(notice.textContent).toContain("That address can't be used any more");
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it.each([
    ["the complete fails with a 5xx (no scanner)", () => envelope("internal", 500)],
    [
      "the complete answers a node that is not clean",
      () => json(fileNode(1, { scanStatus: "error", name: "me.png" }), 201),
    ],
  ])("avatar: %s → the initials stay, with the one message", async (_name, complete) => {
    const calls = api((call) => {
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
      if (call.path.endsWith("/complete")) return complete();
      return undefined;
    });
    renderRoutes(buildRoutes(), ["/account"]);
    const input = await waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-avatar-input]");
      expect(node).not.toBeNull();
      return node!;
    });
    const file = new File([new Uint8Array([137, 80, 78, 71])], "me.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("Couldn't check that image. Try again.")).toBeTruthy();
    expect(document.querySelector('[data-avatar="initials"]')).not.toBeNull();
    const init = calls.find((call) => call.path === "/api/uploads")!;
    expect(init.body).toMatchObject({ purpose: "avatar", parentId: null, size: 4 });
    const done = calls.find((call) => call.path.endsWith("/complete"))!;
    expect((done.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(getToasts()).toEqual([]);
  });
});

describe("security: step-up", () => {
  const TWO_FACTOR_ON = { user: { id: ME, twoFactorEnabled: true }, session: {} };

  function security(extra: MockHandler) {
    return api((call) => {
      const own = extra(call);
      if (own) return own;
      if (call.path.startsWith("/api/auth/get-session?")) return json(TWO_FACTOR_ON);
      return undefined;
    });
  }

  async function askForNewCodes() {
    renderRoutes(buildRoutes(), ["/account/security"]);
    fireEvent.click(await screen.findByRole("button", { name: "New backup codes" }));
    const dialog = await screen.findByRole("dialog", { name: "New backup codes" });
    fireEvent.change(within(dialog).getByLabelText("Your password"), {
      target: { value: "made-up password 1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    return screen.findByRole("dialog", { name: "Confirm it's you" });
  }

  it("403 SECOND_FACTOR_REQUIRED opens the prompt; after a code the action is repeated once", async () => {
    let stepped = false;
    const calls = security((call) => {
      if (call.path === "/api/auth/two-factor/generate-backup-codes")
        return stepped
          ? json({ status: true, backupCodes: ["code-1", "code-2"] })
          : authError(403, "SECOND_FACTOR_REQUIRED");
      if (call.path === "/api/auth/two-factor/verify-totp") {
        stepped = true;
        return json({ token: "x" });
      }
      return undefined;
    });
    const prompt = await askForNewCodes();
    fireEvent.change(within(prompt).getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(within(prompt).getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("code-1")).toBeTruthy();
    const asked = calls.filter((call) => call.path === "/api/auth/two-factor/generate-backup-codes");
    expect(asked).toHaveLength(2);
    expect(asked.map((call) => (call.body as { password: string }).password)).toEqual([
      "made-up password 1",
      "made-up password 1",
    ]);
    expect(
      calls.filter((call) => call.path === "/api/auth/two-factor/verify-totp").map((call) => call.body),
    ).toEqual([expect.objectContaining({ code: "123456" })]);
  });

  it("429 SECOND_FACTOR_THROTTLED shows the Retry-After wait, and nothing is sent until it has passed", async () => {
    const calls = security((call) => {
      if (call.path === "/api/auth/two-factor/generate-backup-codes")
        return authError(403, "SECOND_FACTOR_REQUIRED");
      if (call.path === "/api/auth/two-factor/verify-totp")
        return authError(429, "SECOND_FACTOR_THROTTLED", { "retry-after": "90" });
      return undefined;
    });
    const prompt = await askForNewCodes();
    fireEvent.change(within(prompt).getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(within(prompt).getByRole("button", { name: "Continue" }));
    const wait = await within(prompt).findByText(
      /Too many wrong codes\. Wait 2 min, or use a browser you have signed in from before\./,
    );
    expect(wait.closest('[role="alert"]')).not.toBeNull();
    const submit = within(prompt).getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.submit(submit.closest("form")!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.path === "/api/auth/two-factor/verify-totp")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/auth/two-factor/generate-backup-codes")).toHaveLength(
      1,
    );
  });
});

describe("data: export", () => {
  it("Download export saves the file the API answered, checked against the contract", async () => {
    let saved: Blob | null = null;
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => ((saved = blob), "blob:export"),
        revokeObjectURL: () => {},
      }),
    );
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const at = new Date().toISOString();
    const calls = api((call) =>
      call.path === "/api/account/export"
        ? json({
            version: 1,
            exportedAt: at,
            user: {
              id: ME,
              email: "ada@example.com",
              displayName: "Ada Lovelace",
              createdAt: at,
              timezone: null,
              locale: "en",
              quotaBytes: 1,
              usedBytes: 0,
              termsAcceptedAt: null,
              termsVersion: null,
            },
            prefs: PREFS,
            nodes: [],
            shares: [],
            sharedWithMe: [],
            links: [],
            activity: [],
          })
        : undefined,
    );
    renderRoutes(buildRoutes(), ["/account/data"]);
    fireEvent.click(await screen.findByRole("button", { name: "Download export" }));
    await waitFor(() => expect(names).toEqual([`holdfast-export-${at.slice(0, 10)}.json`]));
    expect(JSON.parse(await saved!.text())).toMatchObject({ version: 1, user: { id: ME } });
    expect(header(calls.find((call) => call.path === "/api/account/export"))).toBe(ME);
  });
});

describe("data: deletion", () => {
  const WHEN = new Date(Date.now() + 6 * 86_400_000).toISOString();

  it("Cancel answering 409 says the deletion can no longer be cancelled", async () => {
    api((call) => {
      if (call.path === "/api/account/deletion-status") return json({ scheduledFor: WHEN });
      if (call.path === "/api/account/deletion/cancel") return envelope("conflict", 409);
      return undefined;
    });
    renderRoutes(buildRoutes(), ["/account/data"]);
    const part = await waitFor(() => {
      const node = document.querySelector("[data-deletion-scheduled]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    fireEvent.click(within(part).getByRole("button", { name: "Cancel deletion" }));
    expect(
      await within(part).findByText(
        "Deletion has already started and can no longer be cancelled. Contact support.",
      ),
    ).toBeTruthy();
    expect(within(part).queryByRole("button", { name: "Cancel deletion" })).toBeNull();
  });

  it("Cancel → T06's route; the section and the banner both lose the date", async () => {
    let scheduledFor: string | null = WHEN;
    const calls = api((call) => {
      if (call.path === "/api/account/deletion-status") return json({ scheduledFor });
      if (call.path === "/api/account/deletion/cancel") {
        scheduledFor = null;
        return json({ scheduledFor: null });
      }
      return undefined;
    });
    renderRoutes(buildRoutes(), ["/account/data"]);
    const part = await waitFor(() => {
      const node = document.querySelector("[data-deletion-scheduled]");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    await waitFor(() => expect(document.querySelector('[data-banner="deletion"]')).not.toBeNull());
    fireEvent.click(within(part).getByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(document.querySelector("[data-deletion-scheduled]")).toBeNull());
    await waitFor(() => expect(document.querySelector('[data-banner="deletion"]')).toBeNull());
    expect(calls.filter((call) => call.path === "/api/account/deletion/cancel")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete account" })).toBeTruthy();
  });

  it("Delete account asks first, then mails the link through Better Auth's delete-user", async () => {
    const calls = api((call) =>
      call.path === "/api/auth/delete-user"
        ? json({ success: true, message: "Verification email sent" })
        : undefined,
    );
    renderRoutes(buildRoutes(), ["/account/data"]);
    const button = await screen.findByRole("button", { name: "Delete account" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Delete your account?" });
    expect(dialog.textContent).toContain("Open it in this browser, where you're signed in — it works once.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Email me the link" }));
    expect(await screen.findByText(/Check your email\. Open the link in this browser/)).toBeTruthy();
    const sent = calls.filter((call) => call.path === "/api/auth/delete-user");
    expect(sent).toHaveLength(1);
    expect(header(sent[0])).toBe(ME);
  });
});
