// A failed NEXT page: the list keeps what it has, says so with a "Try again", and asks nothing
// more until the user does. The observer here behaves like a browser's — it reports a visible
// target as soon as it is observed — because that is what turns "ask again when in view" into a
// loop when the list is re-armed after a failure.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setupShell, type MockHandler } from "../shell/helpers";
import { node, result, SEARCH, STARRED, TRASH, trashItem, trashPage } from "./fixtures";
import { envelope, json, openView, queryOf, requests, rowNames, type AnswerFn } from "./helpers";

setupShell();

beforeEach(() => {
  class EagerObserver {
    constructor(
      private readonly callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void,
    ) {}
    observe(target: Element) {
      queueMicrotask(() => this.callback([{ isIntersecting: true, target }]));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  Object.assign(window, { IntersectionObserver: EagerObserver });
  Object.assign(globalThis, { IntersectionObserver: EagerObserver });
});

const LISTS = [
  {
    path: "/starred",
    view: "starred",
    api: "/api/starred",
    first: { ...STARRED, nextCursor: "c2" },
    second: { items: [node(77, { starred: true })], nextCursor: null },
  },
  {
    path: "/trash",
    view: "trash",
    api: "/api/trash",
    first: trashPage(TRASH.items, "c2"),
    second: trashPage([trashItem(77)]),
  },
  {
    path: "/search?q=report",
    view: "search",
    api: "/api/search",
    first: { ...SEARCH, nextCursor: "c2" },
    second: { items: [result(77)], nextCursor: null },
  },
] as const;

const FAILURES: Array<
  [name: string, answer: () => ReturnType<MockHandler> | Promise<never>, requestId: string | null]
> = [
  ["429", () => envelope("rate_limited", 429), "req-1234"],
  [
    "500",
    () =>
      new Response(JSON.stringify({ error: "internal", message: "x", requestId: "req-500" }), {
        status: 500,
      }),
    "req-500",
  ],
  ["400 (a refused cursor)", () => envelope("validation", 400), "req-1234"],
  ["no answer", () => Promise.reject(new TypeError("Failed to fetch")), null],
];

const notice = (view: string) => document.querySelector(`[data-list-notice="${view}"]`);
const sentinel = () => document.querySelector("[data-load-more-sentinel]");

describe.each(LISTS)("$path: the next page fails", ({ path, view, api, first, second }) => {
  it.each(FAILURES)(
    "%s → the rows stay, an inline error with a retry, ONE request, no more",
    async (_name, failure, requestId) => {
      let fail = true;
      const pageTwo: AnswerFn = (call) => {
        if (queryOf(call).get("cursor") !== "c2") return json(first);
        return fail ? (failure() as Response) : json(second);
      };
      const { calls } = await openView(path, { [`GET ${api}`]: pageTwo });
      const second2 = () =>
        requests(calls, "GET", api).filter((call) => queryOf(call).get("cursor") === "c2");
      await waitFor(() => expect(notice(view)).not.toBeNull());
      expect(notice(view)!.getAttribute("role")).toBe("alert");
      expect(notice(view)!.textContent).toContain("Couldn't load more of this list.");
      if (requestId) expect(notice(view)!.textContent).toContain(`req ${requestId}`);
      expect(rowNames()).toHaveLength(first.items.length);
      // Not the page's "nothing to show" state: the rows are there.
      expect(document.querySelector("[data-view-error]")).toBeNull();
      // The scroll trigger is gone, so nothing can ask again by itself — however often the page
      // renders, and although the observer would fire the moment it was armed.
      expect(sentinel()).toBeNull();
      expect(second2()).toHaveLength(1);
      act(() => window.dispatchEvent(new Event("resize")));
      await act(async () => {
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      });
      expect(sentinel()).toBeNull();
      expect(second2()).toHaveLength(1);

      // The user asks: one more request, the rows arrive, the notice goes.
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(rowNames()).toHaveLength(first.items.length + 1));
      expect(notice(view)).toBeNull();
      expect(second2()).toHaveLength(2);
    },
  );

  it("while it works, the pages keep coming by themselves", async () => {
    await openView(path, {
      [`GET ${api}`]: (call) => json(queryOf(call).get("cursor") === "c2" ? second : first),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(first.items.length + 1));
    expect(notice(view)).toBeNull();
    expect(sentinel()).toBeNull();
  });
});

describe("a 429 that names a wait (Retry-After)", () => {
  const limited = (seconds: string) => () =>
    envelope("rate_limited", 429, undefined, { "retry-after": seconds });
  const retry = () => screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;

  it("on a next page: 'Try again' stays off until the wait has passed, and says why", async () => {
    let fail = true;
    const { calls } = await openView("/starred", {
      "GET /api/starred": (call) => {
        if (queryOf(call).get("cursor") !== "c2") return json({ ...STARRED, nextCursor: "c2" });
        return fail ? limited("1")() : json({ items: [node(77, { starred: true })], nextCursor: null });
      },
    });
    await waitFor(() => expect(notice("starred")).not.toBeNull());
    expect(retry().disabled).toBe(true);
    expect(notice("starred")!.querySelector("[data-retry-wait]")!.textContent).toBe(
      "Too many requests just now. You can try again shortly.",
    );
    fireEvent.click(retry());
    expect(requests(calls, "GET", "/api/starred")).toHaveLength(2);
    // The API's own second, awaited as the button coming back.
    await waitFor(() => expect(retry().disabled).toBe(false), { timeout: 4000 });
    expect(notice("starred")!.querySelector("[data-retry-wait]")).toBeNull();
    fail = false;
    fireEvent.click(retry());
    await waitFor(() => expect(rowNames()).toHaveLength(3));
  });

  it("on the first page: the error state's 'Try again' waits too; a failure without the header does not", async () => {
    let answer = limited("1");
    await openView("/starred", { "GET /api/starred": () => answer() });
    await waitFor(() => expect(document.querySelector('[data-view-error="starred"]')).not.toBeNull());
    expect(retry().disabled).toBe(true);
    await waitFor(() => expect(retry().disabled).toBe(false), { timeout: 4000 });
    answer = () => envelope("rate_limited", 429);
    fireEvent.click(retry());
    await waitFor(() => expect(document.querySelector("[data-retry-wait]")).toBeNull());
    await waitFor(() => expect(retry().disabled).toBe(false));
  });
});
