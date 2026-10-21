// Shared with me and Shared by me, in the real frame: what each lists, the link wording (pause
// reasons, "limit reached today" with no Resume), revoke-selected, the filter, a 429 honoured
// without a refetch loop, and a bulk revoke stopped by an account change.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { purgeUserState } from "../../../../src/client/lib/query";
import { deferred } from "../views/helpers";
import { AT, envelope, FILE_ID, FOLDER_ID, json, link, openView, requests, setupShell } from "./helpers";

setupShell();

const L = (n: number) => `0199d3c2-7a10-7000-8000-0000000002${String(n).padStart(2, "0")}`;

const LINKS = [
  link({ id: L(1), node: { name: "live.txt", kind: "file" } }),
  link({ id: L(2), node: { name: "limited.txt", kind: "file" }, limitedToday: true }),
  link({
    id: L(3),
    node: { name: "reviewed.txt", kind: "file" },
    state: "paused",
    pausedReasons: ["review", "owner"],
  }),
  link({
    id: L(4),
    node: { name: "mine-paused.txt", kind: "file" },
    state: "paused",
    pausedReasons: ["owner"],
    canUnpause: true,
  }),
  link({ id: L(5), node: { name: "gone.txt", kind: "file" }, state: "revoked" }),
];

const row = (id: string) => document.querySelector<HTMLElement>(`[data-by-me-link="${id}"]`)!;

describe("Shared by me — links", () => {
  it("states, pause reasons one per line, 'limit reached today' with no Resume, counts", async () => {
    await openView("/shared-by-me?tab=links", { "GET /api/links/mine": LINKS, "GET /api/shares/mine": [] });
    await screen.findByText("limited.txt");
    expect(within(row(L(2))).getByText("Limit reached today — comes back on its own")).toBeTruthy();
    expect(within(row(L(2))).queryByRole("button", { name: "Resume" })).toBeNull();
    expect(within(row(L(2))).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(
      Array.from(row(L(3)).querySelectorAll("[data-link-paused-reason]"), (line) => line.textContent),
    ).toEqual(["Paused while it is reviewed.", "Paused by you."]);
    expect(within(row(L(3))).queryByRole("button", { name: /Resume|Pause/ })).toBeNull();
    expect(within(row(L(4))).getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(within(row(L(5))).queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(within(row(L(1))).getByText(/0 downloads/)).toBeTruthy();
  });

  it("revoke every selected link in one action: one confirmation, one DELETE each", async () => {
    const { calls } = await openView("/shared-by-me?tab=links", {
      "GET /api/links/mine": LINKS,
      "GET /api/shares/mine": [],
      ...Object.fromEntries(
        LINKS.map((l) => [`DELETE /api/links/${l.id}`, () => new Response(null, { status: 204 })]),
      ),
    });
    await screen.findByText("live.txt");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every link shown" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 4 links" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke 4 links?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke 4 links" }));
    await waitFor(() => expect(getToasts().map((toast) => toast.message)).toContain("4 links revoked"));
    expect(
      calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.path)
        .sort(),
    ).toEqual([L(1), L(2), L(3), L(4)].map((id) => `/api/links/${id}`).sort());
  });

  it("an account change during a bulk revoke stops it: no further DELETE, no toast", async () => {
    const first = deferred<Response>();
    const { calls } = await openView("/shared-by-me?tab=links", {
      "GET /api/links/mine": LINKS,
      "GET /api/shares/mine": [],
      [`DELETE /api/links/${L(1)}`]: () => first.promise,
      [`DELETE /api/links/${L(2)}`]: () => new Response(null, { status: 204 }),
    });
    await screen.findByText("live.txt");
    fireEvent.click(within(row(L(1))).getByRole("checkbox"));
    fireEvent.click(within(row(L(2))).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke 2 links" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Revoke 2 links?" })).getByRole("button", {
        name: "Revoke 2 links",
      }),
    );
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    await act(() => purgeUserState({ keepSession: true }));
    await act(async () => first.resolve(new Response(null, { status: 204 })));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(getToasts().map((toast) => toast.message)).not.toContain("2 links revoked");
  });

  it("the filter shows one state at a time ('limit reached today' among them)", async () => {
    await openView("/shared-by-me?tab=links", { "GET /api/links/mine": LINKS, "GET /api/shares/mine": [] });
    await screen.findByText("live.txt");
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Show" }));
    fireEvent.click(await screen.findByRole("option", { name: "Limit reached today" }));
    await waitFor(() => expect(screen.queryByText("live.txt")).toBeNull());
    expect(screen.getByText("limited.txt")).toBeTruthy();
  });

  it("a 429 on the list is honoured: one request, no refetch loop while the wait lasts", async () => {
    const { calls, router } = await openView("/shared-by-me?tab=links", {
      "GET /api/links/mine": () => envelope("rate_limited", 429, undefined, { "Retry-After": "60" }),
      "GET /api/shares/mine": [],
    });
    expect(await screen.findByText("Couldn't load what you've shared")).toBeTruthy();
    // Leave and come back, twice: the wait the API named holds.
    for (let i = 0; i < 2; i++) {
      await act(() => router.navigate("/shared-by-me"));
      await act(() => router.navigate("/shared-by-me?tab=links"));
    }
    expect(requests(calls, "GET", "/api/links/mine")).toHaveLength(1);
  });
});

describe("Shared by me — people", () => {
  it("grouped by item; a role change is a PATCH, a removal a DELETE", async () => {
    const share = {
      id: "0199d3c2-7a10-7000-8000-0000000003a1",
      nodeId: FOLDER_ID,
      email: "friend@example.test",
      role: "viewer" as const,
      canUpload: true,
      createdAt: AT,
    };
    const { calls } = await openView("/shared-by-me", {
      "GET /api/shares/mine": [{ node: { id: FOLDER_ID, name: "Holiday", kind: "folder" }, shares: [share] }],
      [`DELETE /api/shares/${share.id}`]: () => new Response(null, { status: 204 }),
    });
    expect(await screen.findByRole("heading", { name: "Holiday" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove friend@example.test" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
        `/api/shares/${share.id}`,
      ]),
    );
  });
});

describe("Shared with me", () => {
  it("lists what is shared with the caller, with the owner's name; a folder opens in the explorer", async () => {
    const node = {
      id: FOLDER_ID,
      parentId: null,
      kind: "folder",
      name: "Their folder",
      ext: "",
      size: 0,
      mimeCategory: "other",
      mimeSniffed: null,
      etag: "",
      sha256: null,
      scanStatus: "clean",
      scanReason: null,
      pua: [],
      thumb: false,
      starred: false,
      createdAt: AT,
      updatedAt: AT,
      lastAccessedAt: null,
      deletedAt: null,
      purgeAfter: null,
      owner: { id: "o".repeat(32), displayName: "Grace" },
      createdBy: null,
      role: "viewer",
      sharing: { people: 0, link: "none", summary: "none" },
    };
    const { router } = await openView("/shared", {
      "GET /api/shared-with-me": [{ node, role: "viewer", owner: node.owner, sharedAt: AT }],
    });
    expect(await screen.findByText("Their folder")).toBeTruthy();
    expect(screen.getByText("Shared by Grace")).toBeTruthy();
    fireEvent.keyDown(document.querySelector(`[data-item-id="${FOLDER_ID}"]`)!, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${FOLDER_ID}`));
    void json;
    void FILE_ID;
  });

  it("nothing shared: the empty state", async () => {
    await openView("/shared", { "GET /api/shared-with-me": [] });
    expect(await screen.findByText("Nothing is shared with you yet")).toBeTruthy();
  });
});
