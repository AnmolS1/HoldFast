// A view opened while the browser is offline: the query waits (no request is made), and the page
// says it cannot reach Holdfast instead of showing loading rows for as long as that lasts.
import { onlineManager } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UsagePage } from "../../../../src/client/features/usage/UsagePage";
import { renderRoutes, seedSession, sessionOf, setupShell, shellFetch } from "../shell/helpers";
import { RECENT, SEARCH, STARRED, TRASH, USAGE } from "./fixtures";
import { answering, openView, requests, rowNames, viewError } from "./helpers";

setupShell();
afterEach(() => onlineManager.setOnline(true));

const PAGES = [
  ["/trash", "trash", "/api/trash", TRASH, 3],
  ["/recent", "recent", "/api/recent", RECENT, 4],
  ["/starred", "starred", "/api/starred", STARRED, 2],
  ["/search?q=report", "search", "/api/search", SEARCH, 3],
] as const;

describe.each(PAGES)("%s opened offline", (path, view, api, fixture, rowCount) => {
  it("says it cannot reach Holdfast, asks nothing, and loads by itself when the connection is back", async () => {
    // The app is up (session and settings in hand); then the connection drops and the user
    // goes to the view.
    const { calls, router } = await openView("/help", { [`GET ${api}`]: fixture });
    onlineManager.setOnline(false);
    await act(() => router.navigate(path));
    await waitFor(() => expect(viewError(view)).not.toBeNull());
    expect(viewError(view)!.hasAttribute("data-view-offline")).toBe(true);
    expect(screen.getByRole("heading", { name: "Can't reach Holdfast" })).toBeTruthy();
    expect(viewError(view)!.textContent).toContain("loads by itself once you're back online");
    // Not loading rows, and not the "request failed" copy.
    expect(document.querySelector("[data-skeleton-rows]")).toBeNull();
    expect(viewError(view)!.textContent).not.toContain("req ");
    expect(requests(calls, "GET", api)).toEqual([]);

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(viewError(view)).toBeNull());
    await waitFor(() => expect(rowNames()).toHaveLength(rowCount));
    expect(requests(calls, "GET", api)).toHaveLength(1);
  });
});

describe("/storage opened offline", () => {
  // The frame reads the same numbers for its own bar on every page, so inside the app they are
  // usually in hand already (and shown, which is right). The page alone, with nothing in hand:
  it("says it cannot reach Holdfast instead of a skeleton, then shows the numbers", async () => {
    onlineManager.setOnline(false);
    const calls = shellFetch({
      extra: answering({ "GET /api/account/usage": USAGE, "GET /api/trash": TRASH }),
    });
    seedSession(sessionOf());
    renderRoutes([{ path: "/storage", element: <UsagePage /> }], ["/storage"]);
    await waitFor(() => expect(viewError("usage")).not.toBeNull());
    expect(viewError("usage")!.hasAttribute("data-view-offline")).toBe(true);
    expect(screen.queryByLabelText("Loading storage use")).toBeNull();
    expect(requests(calls, "GET", "/api/account/usage")).toEqual([]);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(document.querySelector("[data-usage-part]")).not.toBeNull());
    expect(viewError("usage")).toBeNull();
  });
});
