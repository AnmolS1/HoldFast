// The dialog: what it shows for each scan status, its error states, prev/next, the keyboard,
// focus, Download, and that a public source never touches the signed-in API.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PreviewItem, PublicPreviewSource } from "../../../../src/client/components/slots";
import { getToasts } from "../../../../src/client/components/Toaster";
import { PreviewDialog } from "../../../../src/client/features/preview";
import { SCAN_POLL_MS } from "../../../../src/client/features/preview/useItem";
import { useShortcut } from "../../../../src/client/lib/shortcuts";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { detailOf, filesUrl, ID, NODES, nodeOf, pageOf } from "./fixtures";
import {
  advance,
  dialog,
  envelope,
  installFetch,
  json,
  ownerApi,
  preloadRenderers,
  renderPreview,
  renderer,
  setupPreview,
  settle,
  state,
} from "./helpers";

setupPreview();

const noop = () => {};

function open(node: NodeDto, props: Partial<Parameters<typeof PreviewDialog>[0]> = {}) {
  return renderPreview(<PreviewDialog open nodeId={node.id} onClose={noop} source="owner" {...props} />);
}

describe("scan status — only clean files are previewed", () => {
  type Row = [
    status: NodeDto["scanStatus"],
    role: NodeDto["role"],
    shows: "image" | "none" | null,
    token: string | null,
    download: boolean,
  ];
  const TABLE: Row[] = [
    ["clean", "owner", "image", null, true],
    ["clean", "viewer", "image", null, true],
    ["pending", "owner", null, null, false],
    ["infected", "owner", "none", "danger", false],
    ["infected", "viewer", "none", "danger", false],
    ["under_review", "owner", "none", "textSecondary", false],
    ["under_review", "editor", "none", "textSecondary", false],
    ["skipped", "owner", "none", "attention", true],
    ["skipped", "viewer", "none", "attention", false],
    ["error", "owner", "none", "attention", true],
    ["error", "editor", "none", "attention", false],
  ];

  it.each(TABLE)(
    "%s as %s → renderer %s, status token %s, download %s",
    async (status, role, shows, token, download) => {
      await preloadRenderers();
      const node = nodeOf({ scanStatus: status, role, scanReason: status === "skipped" ? "size" : null });
      const api = ownerApi([node]);
      installFetch({ api: api.handler });
      open(node);
      await screen.findByText("sample.png");
      await settle();
      expect(renderer()).toBe(shows);
      const dot = dialog()!.querySelector("[data-status]");
      expect(dot?.getAttribute("data-token") ?? null).toBe(token);
      expect(dialog()!.querySelectorAll("[data-preview-download]").length > 0).toBe(download);
      if (status === "pending") {
        expect(state()).toBe("scanning");
        expect(screen.getByText("Scanning…")).toBeTruthy();
        expect(screen.getByRole("progressbar", { name: "Scanning sample.png" })).toBeTruthy();
      }
      // Nothing is minted for a file that is not clean.
      if (status !== "clean") expect(api.minted).toEqual([]);
      if (status === "infected" || status === "under_review") {
        expect(screen.getByText("This file can't be previewed or downloaded.")).toBeTruthy();
      }
      if ((status === "skipped" || status === "error") && role === "owner") {
        expect(
          screen.getByText(
            "This file couldn't be scanned. Download it only if you trust where it came from.",
          ),
        ).toBeTruthy();
      }
    },
  );

  it("a status the owner is never told about is shown exactly like `under_review`", async () => {
    const item: PreviewItem = { ...NODES.png, scanStatus: "suspected_csam" };
    const source: PublicPreviewSource = { getItem: async () => item, getUrl: vi.fn() };
    renderPreview(<PreviewDialog open nodeId={ID.png} onClose={noop} source={source} />);
    await screen.findByText("sample.png");
    expect(renderer()).toBe("none");
    expect(dialog()!.querySelector("[data-status]")!.getAttribute("data-token")).toBe("textSecondary");
    expect(source.getUrl).not.toHaveBeenCalled();
  });

  it("pending: polls GET /nodes/:id every 5 s, reads `.node.scanStatus`, and opens by itself", async () => {
    await preloadRenderers();
    vi.useFakeTimers();
    let status: NodeDto["scanStatus"] = "pending";
    const api = ownerApi([NODES.png], (call) =>
      call.url.pathname === `/api/nodes/${ID.png}`
        ? // A status beside `node` is not the contract: only `.node.scanStatus` counts.
          json({ ...detailOf(nodeOf({ scanStatus: status })), scanStatus: "clean" })
        : undefined,
    );
    const network = installFetch({ api: api.handler });
    open(NODES.png);
    await advance(0);
    expect(state()).toBe("scanning");
    expect(network.api(`/api/nodes/${ID.png}`).length).toBe(1);

    await advance(SCAN_POLL_MS - 1);
    expect(network.api(`/api/nodes/${ID.png}`).length).toBe(1);
    await advance(1);
    expect(network.api(`/api/nodes/${ID.png}`).length).toBe(2);
    expect(state()).toBe("scanning");
    expect(api.minted).toEqual([]);

    status = "clean";
    await advance(SCAN_POLL_MS);
    await advance(0);
    expect(state()).toBeNull();
    expect(renderer()).toBe("image");
    expect(api.minted.map((mint) => mint.kind)).toContain("inline");
    // Clean: the polling is over.
    const reads = network.api(`/api/nodes/${ID.png}`).filter((call) => call.method === "GET").length;
    await advance(10 * SCAN_POLL_MS);
    expect(network.api(`/api/nodes/${ID.png}`).filter((call) => call.method === "GET").length).toBe(reads);
  });
});

describe("errors never throw", () => {
  it.each([
    [404, "not_found", "This file isn't here"],
    [500, "internal", "Couldn't open this preview"],
    [403, "forbidden", "Couldn't open this preview"],
  ])("node load answered %i → the error state with the request id", async (status, code, title) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    installFetch({ api: () => envelope(code, status) });
    open(NODES.png);
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(state()).toBe("error");
    // The dialog is not still called "Loading preview" once loading has failed.
    expect(screen.getByRole("dialog", { name: "Preview" })).toBe(dialog());
    expect(within(dialog()!).getByText("req req-1234")).toBeTruthy();
    expect(renderer()).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it("a body that is not the contract → the error state", async () => {
    installFetch({ api: () => json({ node: { id: "nope" } }) });
    open(NODES.png);
    expect(await screen.findByRole("heading", { name: "Couldn't open this preview" })).toBeTruthy();
  });

  it("the network failing → the error state; Try again loads it", async () => {
    let down = true;
    const api = ownerApi([NODES.svg]);
    installFetch({
      api: (call) => {
        if (down) throw new TypeError("Failed to fetch");
        return api.handler(call);
      },
    });
    open(NODES.svg);
    await screen.findByRole("heading", { name: "Couldn't open this preview" });
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(renderer()).toBe("none"));
    expect(state()).toBeNull();
  });

  it("closed, or without a node, it renders nothing and asks for nothing", async () => {
    const network = installFetch();
    renderPreview(<PreviewDialog open={false} nodeId={ID.png} onClose={noop} source="owner" />);
    renderPreview(<PreviewDialog open nodeId={null} onClose={noop} source="owner" />);
    await settle(10);
    expect(dialog()).toBeNull();
    expect(network.calls).toEqual([]);
  });
});

describe("the dialog's chrome", () => {
  it("is a modal dialog named by the file, with type and size", async () => {
    installFetch({ api: ownerApi([NODES.svg]).handler });
    open(NODES.svg);
    await screen.findByText("sample.svg");
    const element = dialog()!;
    expect(element.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: "sample.svg" })).toBe(element);
    expect(element.querySelector("[data-preview-meta]")!.textContent).toBe("SVG · Image193 B");
    expect(screen.getByRole("button", { name: "Close preview" })).toBeTruthy();
  });

  it("SVG and HTML are never rendered: no image, no markup of theirs, no URL minted", async () => {
    for (const node of [NODES.svg, NODES.html]) {
      const api = ownerApi([node]);
      installFetch({ api: api.handler });
      const view = open(node);
      await screen.findByText(node.name);
      await settle();
      expect(renderer()).toBe("none");
      expect(dialog()!.querySelector("img, svg[onload], script, iframe, object, embed")).toBeNull();
      expect(api.minted).toEqual([]);
      view.unmount();
    }
  });

  it("prev/next walk the ids it was given: buttons, arrow keys, and the ends", async () => {
    const nodes = [NODES.svg, NODES.html, NODES.png];
    const network = installFetch({ api: ownerApi(nodes).handler });
    const onNavigate = vi.fn();
    open(NODES.html, { siblingIds: nodes.map((node) => node.id), onNavigate });
    await screen.findByText("sample.html");
    expect(dialog()!.querySelector("[data-preview-meta]")!.textContent).toContain("2 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous file" }));
    fireEvent.keyDown(dialog()!, { key: "ArrowRight" });
    fireEvent.keyDown(dialog()!, { key: "ArrowLeft" });
    expect(onNavigate.mock.calls.map(([id]) => id)).toEqual([ID.png, ID.svg, ID.png, ID.svg]);
    // With a modifier the arrows are the browser's (back / forward).
    fireEvent.keyDown(dialog()!, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(dialog()!, { key: "ArrowRight", metaKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(4);
    // The ids were given: the folder is not listed.
    expect(network.api().some((call) => /children|\/root/.test(call.url.pathname))).toBe(false);
  });

  it("at the first and the last file the button that leads nowhere is disabled, and its key does nothing", async () => {
    const nodes = [NODES.svg, NODES.html];
    installFetch({ api: ownerApi(nodes).handler });
    const onNavigate = vi.fn();
    const view = open(NODES.svg, { siblingIds: nodes.map((node) => node.id), onNavigate });
    await screen.findByText("sample.svg");
    expect((screen.getByRole("button", { name: "Previous file" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next file" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(dialog()!, { key: "ArrowLeft" });
    expect(onNavigate).not.toHaveBeenCalled();
    view.unmount();

    open(NODES.html, { siblingIds: nodes.map((node) => node.id), onNavigate });
    await screen.findByText("sample.html");
    expect((screen.getByRole("button", { name: "Next file" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog()!, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("a cold link lists the file's own folder for prev/next (files only), and the top level for a root file", async () => {
    const nodes = [NODES.svg, NODES.html];
    const api = ownerApi(nodes, (call) =>
      call.url.pathname === `/api/nodes/${ID.folder}/children` ? json(pageOf(nodes)) : undefined,
    );
    const network = installFetch({ api: api.handler });
    const onNavigate = vi.fn();
    const view = open(NODES.svg, { onNavigate });
    await screen.findByRole("button", { name: "Next file" });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(onNavigate).toHaveBeenCalledWith(ID.html);
    const listing = network.api().filter((call) => call.url.pathname.endsWith("/children"));
    expect(listing.map((call) => call.url.pathname + call.url.search)).toEqual([
      `/api/nodes/${ID.folder}/children?kind=file&limit=200`,
    ]);
    view.unmount();

    const rootFile = nodeOf({ ...NODES.svg, parentId: null });
    const rootApi = ownerApi([rootFile], (call) =>
      call.url.pathname === "/api/nodes/root" ? json(pageOf([rootFile, NODES.html])) : undefined,
    );
    const rootNetwork = installFetch({ api: rootApi.handler });
    open(rootFile, { onNavigate });
    await screen.findByRole("button", { name: "Next file" });
    expect(rootNetwork.api("/api/nodes/root").map((call) => call.url.pathname + call.url.search)).toEqual([
      "/api/nodes/root?kind=file&limit=200",
    ]);
  });

  it("a folder that cannot be listed leaves the preview working, without prev/next", async () => {
    installFetch({ api: ownerApi([NODES.svg]).handler });
    open(NODES.svg, { onNavigate: vi.fn() });
    await screen.findByText("sample.svg");
    await settle(10);
    expect(renderer()).toBe("none");
    expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
  });

  it("Escape and the close button close it", async () => {
    installFetch({ api: ownerApi([NODES.svg]).handler });
    const onClose = vi.fn();
    open(NODES.svg, { onClose });
    await screen.findByText("sample.svg");
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a key pressed in the preview is never a shortcut of the page underneath", async () => {
    const trash = vi.fn();
    const search = vi.fn();
    function Underneath() {
      useShortcut("trash", trash);
      useShortcut("search", search);
      return null;
    }
    installFetch({ api: ownerApi([NODES.svg]).handler });
    const view = renderPreview(
      <>
        <Underneath />
        <PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />
      </>,
    );
    await screen.findByText("sample.svg");
    const close = screen.getByRole("button", { name: "Close preview" });
    for (const key of ["Delete", "Backspace", "/"]) fireEvent.keyDown(close, { key });
    // Nor when the key lands on the page itself while the preview is open.
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(trash).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    // Control: once the preview is closed the same keys are the page's again.
    view.rerender(
      <>
        <Underneath />
        <PreviewDialog open={false} nodeId={ID.svg} onClose={noop} source="owner" />
      </>,
    );
    await waitFor(() => expect(dialog()).toBeNull());
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(trash).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("focus is trapped in the dialog and returns to what opened it", async () => {
    installFetch({ api: ownerApi([NODES.svg]).handler });
    function Page() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button onClick={() => setShown(true)}>open sample.svg</button>
          <PreviewDialog open={shown} nodeId={ID.svg} onClose={() => setShown(false)} source="owner" />
        </>
      );
    }
    renderPreview(<Page />);
    const opener = screen.getByRole("button", { name: "open sample.svg" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByText("sample.svg");
    await waitFor(() => expect(dialog()!.parentElement!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(opener);
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("Download and Share", () => {
  it("Download mints a `download` URL — the only one in the preview — and starts it", async () => {
    const api = ownerApi([NODES.svg]);
    const network = installFetch({ api: api.handler });
    const clicked: string[] = [];
    const opened: Array<[string, string]> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.href);
      opened.push([this.target, this.rel]);
    });
    open(NODES.svg);
    await screen.findByText("sample.svg");
    expect(api.minted).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clicked.length).toBe(1));
    expect(api.minted.map((mint) => mint.kind)).toEqual(["download"]);
    expect(clicked[0]).toBe(filesUrl("download", ID.svg, "tok-1"));
    // One Download in the dialog, even beside a file that has no preview.
    expect(screen.getAllByRole("button", { name: "Download" }).length).toBe(1);
    expect(
      network
        .api()
        .filter((call) => call.method === "POST")
        .map((call) => call.body),
    ).toEqual([{ kind: "download" }]);
    // In a tab of its own: a files-host refusal (plain text) must never replace the app, nor
    // leave the URL in the app's address bar.
    expect(opened).toEqual([["_blank", "noopener noreferrer"]]);
  });

  it("a minted address that is not http(s) is never opened", async () => {
    const api = ownerApi([NODES.svg], (call) =>
      call.url.pathname.endsWith("/download-url")
        ? json({ url: "javascript:alert(1)", expiresAt: new Date(Date.now() + 300_000).toISOString() })
        : undefined,
    );
    const network = installFetch({ api: api.handler });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    open(NODES.svg);
    await screen.findByText("sample.svg");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(network.api().some((call) => call.method === "POST")).toBe(true));
    await settle(10);
    expect(click).not.toHaveBeenCalled();
  });

  it("a folder whose pages keep carrying a cursor and no files is not listed for ever", async () => {
    const api = ownerApi([NODES.svg], (call) =>
      call.url.pathname.endsWith("/children") ? json(pageOf([], "more")) : undefined,
    );
    const network = installFetch({ api: api.handler });
    open(NODES.svg, { onNavigate: vi.fn() });
    await screen.findByText("sample.svg");
    await settle(30);
    expect(network.api().filter((call) => call.url.pathname.endsWith("/children")).length).toBe(5);
    expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
  });

  it("a refused download is said in a toast with the request id, and nothing is started", async () => {
    const api = ownerApi([NODES.svg], (call) =>
      call.url.pathname.endsWith("/download-url") ? envelope("scan_blocked", 403) : undefined,
    );
    installFetch({ api: api.handler });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    open(NODES.svg);
    await screen.findByText("sample.svg");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(getToasts().length).toBe(1));
    expect(getToasts()[0]).toMatchObject({ message: "scan_blocked message", requestId: "req-1234" });
    expect(click).not.toHaveBeenCalled();
  });

  it("Share is the owner's: shown for role owner, not for an editor or a viewer", async () => {
    for (const [role, shown] of [
      ["owner", true],
      ["editor", false],
      ["viewer", false],
    ] as const) {
      const node = nodeOf({ ...NODES.svg, role });
      installFetch({ api: ownerApi([node]).handler });
      const view = open(node);
      await screen.findByText("sample.svg");
      expect(screen.queryByRole("button", { name: "Share" }) !== null).toBe(shown);
      view.unmount();
    }
  });
});

describe("a public source", () => {
  function publicSource(item: PreviewItem) {
    let count = 0;
    const source = {
      getItem: vi.fn(async () => item),
      getUrl: vi.fn<PublicPreviewSource["getUrl"]>(async (nodeId, kind, size) => {
        count += 1;
        return {
          url: filesUrl(kind, nodeId, `pub-${count}`, size),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        };
      }),
    };
    return source;
  }
  /** What a public page knows about a file: no scan status, no thumbnail flag. */
  const bare = (node: NodeDto): PreviewItem => ({
    id: node.id,
    name: node.name,
    size: node.size,
    mimeCategory: node.mimeCategory,
    ext: node.ext,
    mimeSniffed: node.mimeSniffed,
  });

  it("an item without `scanStatus` is previewed as clean: no Scanning, no poll", async () => {
    await preloadRenderers();
    vi.useFakeTimers();
    const network = installFetch();
    const source = publicSource(bare(NODES.png));
    renderPreview(<PreviewDialog open nodeId={ID.png} onClose={noop} source={source} />);
    await advance(0);
    await advance(0);
    expect(state()).toBeNull();
    expect(renderer()).toBe("image");
    expect(screen.queryByText("Scanning…")).toBeNull();
    await advance(12 * SCAN_POLL_MS);
    expect(source.getItem).toHaveBeenCalledTimes(1);
    expect(network.api()).toEqual([]);
  });

  it("an item that says `pending` is polled through the source, not through the API", async () => {
    vi.useFakeTimers();
    const network = installFetch();
    const source = publicSource({ ...bare(NODES.png), scanStatus: "pending" });
    renderPreview(<PreviewDialog open nodeId={ID.png} onClose={noop} source={source} />);
    await advance(0);
    expect(state()).toBe("scanning");
    await advance(SCAN_POLL_MS);
    expect(source.getItem).toHaveBeenCalledTimes(2);
    expect(source.getUrl).not.toHaveBeenCalled();
    expect(network.api()).toEqual([]);
  });

  it("has no Download, no Share, no prev/next of its own — and never calls /api/nodes", async () => {
    const network = installFetch();
    const source = publicSource(bare(NODES.svg));
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} onNavigate={vi.fn()} source={source} />);
    await screen.findByText("sample.svg");
    await settle(10);
    expect(renderer()).toBe("none");
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
    expect(screen.getByText("No preview for this type")).toBeTruthy();
    expect(network.calls).toEqual([]);
  });

  it("walks the ids the page gives it", async () => {
    installFetch();
    const source = publicSource(bare(NODES.svg));
    const onNavigate = vi.fn();
    renderPreview(
      <PreviewDialog
        open
        nodeId={ID.svg}
        siblingIds={[ID.svg, ID.html]}
        onClose={noop}
        onNavigate={onNavigate}
        source={source}
      />,
    );
    await screen.findByText("sample.svg");
    fireEvent.keyDown(dialog()!, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith(ID.html);
  });

  it("a rejected getItem is the error state, with no request id to show", async () => {
    installFetch();
    const source: PublicPreviewSource = {
      getItem: async () => {
        throw new Error("gone");
      },
      getUrl: vi.fn(),
    };
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source={source} />);
    await screen.findByRole("heading", { name: "Couldn't open this preview" });
    expect(within(dialog()!).queryByText(/^req /)).toBeNull();
  });

  it("moving to another file leaves nothing of the last one", async () => {
    installFetch();
    const items: Record<string, PreviewItem> = { [ID.svg]: bare(NODES.svg), [ID.html]: bare(NODES.html) };
    const source: PublicPreviewSource = { getItem: async (id) => items[id]!, getUrl: vi.fn() };
    const view = renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source={source} />);
    await screen.findByText("sample.svg");
    act(() => {
      view.rerender(<PreviewDialog open nodeId={ID.html} onClose={noop} source={source} />);
    });
    await screen.findByText("sample.html");
    expect(screen.queryByText("sample.svg")).toBeNull();
  });
});
