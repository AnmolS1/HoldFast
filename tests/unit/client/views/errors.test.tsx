// A page never throws on an API error: with its request answered 404 or 500 each view shows its
// OWN error state (not the frame's error boundary), and the sidebar's bar stays a skeleton.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUsageSummary } from "../../../../src/client/features/usage";
import { renderShell, setupShell, shellFetch } from "../shell/helpers";
import { RECENT, SEARCH, STARRED, TRASH, USAGE } from "./fixtures";
import { envelope, json, openView, requests, rowNames, viewError } from "./helpers";

setupShell();

const PAGES = [
  { path: "/trash", view: "trash", api: "/api/trash", title: "Couldn't load the trash", good: TRASH },
  {
    path: "/recent",
    view: "recent",
    api: "/api/recent",
    title: "Couldn't load your recent files",
    good: RECENT,
  },
  {
    path: "/starred",
    view: "starred",
    api: "/api/starred",
    title: "Couldn't load your starred items",
    good: STARRED,
  },
  {
    path: "/search?q=tax",
    view: "search",
    api: "/api/search",
    title: "Couldn't run this search",
    good: SEARCH,
  },
  {
    path: "/storage",
    view: "usage",
    api: "/api/account/usage",
    title: "Couldn't load your storage use",
    good: USAGE,
  },
] as const;

const FAILURES = [
  ["404", () => envelope("not_found", 404)],
  [
    "500",
    () =>
      new Response(JSON.stringify({ error: "internal", message: "boom", requestId: "req-500" }), {
        status: 500,
      }),
  ],
] as const;

describe.each(PAGES)("$path", ({ path, view, api, title, good }) => {
  it.each(FAILURES)("answered %s: the page's own error state, nothing thrown", async (_status, failure) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await openView(path, { [`GET ${api}`]: failure });
    await waitFor(() => expect(viewError(view)).not.toBeNull());
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    // The request id is shown, so support can find the call.
    expect(viewError(view)!.textContent).toMatch(/req req-(1234|500)/);
    // Not the frame's error boundary, and React reported no render error.
    expect(screen.queryByText("Something broke on this page")).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    expect(document.querySelector("[data-placeholder-page]")).toBeNull();
  });

  it("'Try again' asks again and the page recovers", async () => {
    let fail = true;
    const { calls } = await openView(path, {
      [`GET ${api}`]: () => (fail ? envelope("not_found", 404) : json(good)),
    });
    await waitFor(() => expect(viewError(view)).not.toBeNull());
    const before = requests(calls, "GET", api).length;
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(viewError(view)).toBeNull());
    expect(requests(calls, "GET", api).length).toBe(before + 1);
  });
});

describe("the storage slot", () => {
  function Probe({ onValue }: { onValue(value: unknown): void }) {
    onValue(useUsageSummary());
    return null;
  }

  it.each(FAILURES)(
    "useUsageSummary() is null when the request is answered %s — it never throws",
    async (_s, failure) => {
      const calls = shellFetch({
        extra: (call) => (call.path === "/api/account/usage" ? failure() : undefined),
      });
      const values: unknown[] = [];
      renderShell(<Probe onValue={(value) => values.push(value)} />);
      await waitFor(() => expect(requests(calls, "GET", "/api/account/usage")).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((value) => value === null)).toBe(true);
    },
  );

  it("is null while loading, then exactly { usedBytes, quotaBytes }", async () => {
    shellFetch({ extra: (call) => (call.path === "/api/account/usage" ? Response.json(USAGE) : undefined) });
    const values: unknown[] = [];
    renderShell(<Probe onValue={(value) => values.push(value)} />);
    expect(values[0]).toBeNull();
    await waitFor(() =>
      expect(values.at(-1)).toEqual({ usedBytes: 1_400_000_000, quotaBytes: 5_000_000_000 }),
    );
  });

  it("on every page of the frame the sidebar's bar is a skeleton when usage is unavailable", async () => {
    await openView("/recent", {
      "GET /api/account/usage": () => envelope("not_found", 404),
      "GET /api/recent": RECENT,
    });
    await waitFor(() => expect(rowNames().length).toBe(4));
    expect(screen.getByLabelText("Loading storage use").getAttribute("aria-busy")).toBe("true");
  });
});
