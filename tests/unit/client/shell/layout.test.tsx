// The frame: the 1024 breakpoint, the sidebar's six destinations, the three-item bottom nav.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDetailsPanel } from "../../../../src/client/components/DetailsPanel";
import { buildRoutes } from "../../../../src/client/router";
import { DESKTOP_MIN } from "../../../../src/client/theme/breakpoints";
import { renderRoutes, sessionOf, setupShell, setViewport, shellFetch } from "./helpers";

setupShell();

async function openAt(width: number, path = "/", role = "user") {
  setViewport(width, { coarse: width < DESKTOP_MIN });
  shellFetch({ session: sessionOf({ role }) });
  const view = renderRoutes(buildRoutes(), [path]);
  await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
  return view;
}

const frame = () => document.querySelector("[data-frame]")!.getAttribute("data-frame");

describe("breakpoint", () => {
  it("is 1024", () => {
    expect(DESKTOP_MIN).toBe(1024);
  });

  it("1024 px is desktop: sidebar and details panel, no bottom nav", async () => {
    await openAt(1024);
    expect(frame()).toBe("desktop");
    expect(document.querySelector("[data-sidebar]")).not.toBeNull();
    expect(document.querySelector("[data-details-panel]")).not.toBeNull();
    expect(document.querySelector("[data-bottom-nav]")).toBeNull();
    expect(document.querySelector("[data-new-fab]")).toBeNull();
  });

  it("1023 px is mobile: bottom nav and FAB, no sidebar, no details panel", async () => {
    await openAt(1023);
    expect(frame()).toBe("mobile");
    expect(document.querySelector("[data-sidebar]")).toBeNull();
    expect(document.querySelector("[data-details-panel]")).toBeNull();
    expect(document.querySelector("[data-bottom-nav]")).not.toBeNull();
    expect(document.querySelector("[data-new-fab]")).not.toBeNull();
  });

  it("flips live when the viewport crosses it", async () => {
    await openAt(1024);
    expect(frame()).toBe("desktop");
    act(() => setViewport(1023));
    await waitFor(() => expect(frame()).toBe("mobile"));
    act(() => setViewport(1024));
    await waitFor(() => expect(frame()).toBe("desktop"));
  });
});

describe("desktop frame", () => {
  it("the sidebar has exactly the six destinations, in order, with the current one marked", async () => {
    await openAt(1280, "/recent");
    const nav = document.querySelector<HTMLElement>("[data-sidebar]")!;
    const links = Array.from(nav.querySelectorAll("[data-nav]"));
    expect(links.map((link) => link.textContent)).toEqual(["Files", "Shared with me", "Shared by me", "Recent", "Starred", "Trash"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/", "/shared", "/shared-by-me", "/recent", "/starred", "/trash"]);
    expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent)).toEqual(["Recent"]);
  });

  it("has a skip link, one main landmark, one h1, and the header controls", async () => {
    await openAt(1280, "/trash");
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
    expect(screen.getAllByRole("main").length).toBe(1);
    expect(screen.getByRole("main").id).toBe("main");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Trash"]);
    expect(screen.getByRole("searchbox", { name: "Search files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Command palette" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  });

  it("the storage bar shows its skeleton while usage is unknown", async () => {
    await openAt(1280);
    expect(within(document.querySelector<HTMLElement>("[data-sidebar]")!).getByLabelText("Loading storage use")).toBeTruthy();
  });

  it("the details panel shows its empty state, then what a feature sets", async () => {
    function Feature() {
      const details = useDetailsPanel();
      return <button onClick={() => details.setContent(<div>details of notes.md</div>)}>select</button>;
    }
    await openAt(1280);
    const panel = document.querySelector<HTMLElement>("[data-details-panel]")!;
    expect(panel.getAttribute("aria-label")).toBe("Details");
    expect(panel.textContent).toContain("Nothing selected");
    const { unmount } = (await import("@testing-library/react")).render(<Feature />);
    fireEvent.click(screen.getByText("select"));
    await waitFor(() => expect(panel.textContent).toContain("details of notes.md"));
    unmount();
  });

  it("a route with handle.details === false hides the panel", async () => {
    await openAt(1280, "/storage");
    expect(document.querySelector("[data-details-panel]")).toBeNull();
  });

  it("the view toggle writes the shared view-mode preference", async () => {
    await openAt(1280);
    const grid = screen.getByRole("button", { name: "Grid view" });
    expect(grid.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(grid);
    expect(grid.getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem("hf.prefs.v1")!).viewMode).toBe("grid");
  });

  it("New: 'New folder' is disabled until the explorer registers it; menu items show their shortcuts", async () => {
    await openAt(1280);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const menu = await screen.findByRole("menu");
    const [folder, upload] = within(menu).getAllByRole("menuitem");
    expect(folder!.textContent).toContain("New folder");
    expect(folder!.getAttribute("aria-disabled")).toBe("true");
    expect(folder!.querySelector("kbd")).not.toBeNull();
    expect(upload!.textContent).toContain("Upload files…");
    expect(upload!.getAttribute("aria-disabled")).not.toBe("true");
    expect(upload!.querySelector("kbd")).not.toBeNull();
  });

  it("the user menu: account, storage, theme, help, shortcuts, support, legal, sign out — and Admin only for admins", async () => {
    await openAt(1280);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu", { name: "Account menu" });
    const text = menu.textContent!;
    for (const label of ["Account settings", "Manage storage", "Theme: Match system", "Theme: Light", "Theme: Dark", "Help", "Keyboard shortcuts", "Contact support", "Terms", "Privacy", "DMCA", "Sign out"]) expect(text).toContain(label);
    expect(text).not.toContain("Admin");
    expect(within(menu).getByRole("menuitem", { name: /Help/ }).getAttribute("href")).toBe("https://ponderance.dev/support/holdfast");
    expect(within(menu).getByRole("menuitem", { name: "DMCA" }).getAttribute("href")).toBe("/dmca");
  });

  it("an admin sees Admin in the user menu", async () => {
    await openAt(1280, "/", "admin");
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect((await screen.findByRole("menu", { name: "Account menu" })).textContent).toContain("Admin");
  });
});

describe("mobile frame", () => {
  it("the bottom nav has exactly three items: Files · Shared · Account", async () => {
    await openAt(390);
    const nav = document.querySelector<HTMLElement>("[data-bottom-nav]")!;
    const items = Array.from(nav.querySelectorAll("[data-bottom-nav-item]"));
    expect(items.map((item) => item.textContent)).toEqual(["Files", "Shared", "Account"]);
    expect(nav.querySelectorAll("a, button").length).toBe(3);
    expect(items.filter((item) => item.getAttribute("aria-current") === "page").map((item) => item.textContent)).toEqual(["Files"]);
  });

  it("Recent, Starred and Trash are reached through the Files switcher; the nav item stays Files", async () => {
    const { router } = await openAt(390);
    for (const [label, path, title] of [["Recent", "/recent", "Recent"], ["Starred", "/starred", "Starred"], ["Trash", "/trash", "Trash"], ["My files", "/", "Files"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Switch files view" }));
      const sheet = await screen.findByRole("dialog", { name: "Files" });
      expect(within(sheet).getAllByRole("button").filter((b) => b.hasAttribute("data-nav")).map((b) => b.textContent)).toEqual(["My files", "Recent", "Starred", "Trash"]);
      fireEvent.click(within(sheet).getByRole("button", { name: label }));
      await waitFor(() => expect(router.state.location.pathname).toBe(path));
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title));
      expect(document.querySelector('[data-bottom-nav-item="files"]')!.getAttribute("aria-current")).toBe("page");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull());
    }
  });

  it("Shared has a two-segment control: With me · By me", async () => {
    const { router } = await openAt(390, "/shared");
    const control = screen.getByRole("group", { name: "Shared files view" });
    expect(within(control).getAllByRole("link").map((link) => link.textContent)).toEqual(["With me", "By me"]);
    expect(document.querySelector('[data-bottom-nav-item="shared"]')!.getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(control).getByRole("link", { name: "By me" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/shared-by-me"));
    expect(document.querySelector('[data-bottom-nav-item="shared"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("Account opens a sheet with settings, storage, help and sign-out", async () => {
    const { router } = await openAt(390);
    fireEvent.click(document.querySelector<HTMLElement>('[data-bottom-nav-item="account"]')!);
    const sheet = await screen.findByRole("dialog", { name: "Ada Lovelace" });
    const labels = Array.from(sheet.querySelectorAll("[data-account-action]"), (node) => node.textContent);
    expect(labels).toEqual(["Account settings", "Manage storage", "Help", "Contact support", "Terms", "Privacy", "DMCA", "Sign out"]);
    expect(within(sheet).getByLabelText("Loading storage use")).toBeTruthy();
    expect(within(sheet).getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    fireEvent.click(within(sheet).getByText("Account settings"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
    expect(document.querySelector('[data-bottom-nav-item="account"]')!.getAttribute("aria-current")).toBe("page");
  });

  it("the FAB offers New folder and Upload in a sheet", async () => {
    await openAt(390);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const sheet = await screen.findByRole("dialog", { name: "New" });
    expect(Array.from(sheet.querySelectorAll("[data-new-action]"), (n) => n.getAttribute("data-new-action"))).toEqual(["new-folder", "upload"]);
  });

  it("read-only disables New and says why", async () => {
    setViewport(1280);
    shellFetch({ session: sessionOf(), config: { readOnly: true } });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const menu = await screen.findByRole("menu");
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.getAttribute("title")).toBe("Not available while Holdfast is read-only.");
    }
  });
});
