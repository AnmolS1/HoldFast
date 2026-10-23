// AVWARM: the avatar upload on a cold scanner. While the server scans (up to two minutes when the
// scanner is starting) the page says "Checking your picture…"; a `503 scanner_starting` is the plain
// "The virus scanner is starting up. Try again in a minute." with a "Try again" that sends the same
// picture again — never the generic "Couldn't check" and never a toast.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
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

/** The avatar's three calls; `complete` answers each complete in turn. */
function api(complete: MockHandler) {
  return shellFetch({
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
      if (call.path.endsWith("/complete")) return complete(call);
      if (call.path === "/api/account/profile" && call.method === "GET") return json(PROFILE);
      if (call.path === "/api/account/prefs" && call.method === "GET") return json(PREFS);
      if (call.path === "/api/auth/list-accounts") return json([]);
      if (call.path.startsWith("/api/auth/passkey/list-user-passkeys")) return json([]);
      return undefined;
    },
  });
}

async function choosePicture() {
  const input = await waitFor(() => {
    const node = document.querySelector<HTMLInputElement>("[data-avatar-input]");
    expect(node).not.toBeNull();
    return node!;
  });
  const file = new File([new Uint8Array([137, 80, 78, 71])], "me.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("avatar on a cold scanner", () => {
  it("while the server scans: 'Checking your picture…' on the button and in a status line", async () => {
    let answer!: (response: Response) => void;
    api(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderRoutes(buildRoutes(), ["/account"]);
    await choosePicture();
    const button = await screen.findByRole("button", { name: "Checking your picture…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const status = screen.getByText("Checking your picture… This can take up to two minutes.");
    expect(status.getAttribute("role")).toBe("status");
    answer(json(fileNode(1, { scanStatus: "clean", name: "me.png" }), 201));
    expect(await screen.findByRole("button", { name: "Upload picture" })).toBeTruthy();
    expect(screen.queryByText("Checking your picture… This can take up to two minutes.")).toBeNull();
  });

  it("503 scanner_starting: the plain sentence and 'Try again', which sends the same picture again", async () => {
    let completes = 0;
    const calls = api(() => {
      completes += 1;
      return completes === 1
        ? envelope("scanner_starting", 503, undefined, { "Retry-After": "30" })
        : json(fileNode(1, { scanStatus: "clean", name: "me.png" }), 201);
    });
    renderRoutes(buildRoutes(), ["/account"]);
    await choosePicture();
    expect(await screen.findByText("The virus scanner is starting up. Try again in a minute.")).toBeTruthy();
    expect(screen.queryByText("Couldn't check that image. Try again.")).toBeNull();
    expect(getToasts()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(getToasts().map((toast) => toast.message)).toEqual(["Profile picture updated."]));
    const inits = calls.filter((call) => call.path === "/api/uploads" && call.method === "POST");
    expect(inits).toHaveLength(2);
    expect(inits[1]!.body).toMatchObject({ purpose: "avatar", name: "me.png", size: 4 });
    expect(screen.queryByText("The virus scanner is starting up. Try again in a minute.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("any other failure keeps its own message and offers no 'Try again' (the control)", async () => {
    api(() => envelope("internal", 500));
    renderRoutes(buildRoutes(), ["/account"]);
    await choosePicture();
    expect(await screen.findByText("Couldn't check that image. Try again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
