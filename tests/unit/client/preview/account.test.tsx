// An account change while the preview is open. After the account's state is purged (sign-out,
// another identity) the preview shows nothing of the old account, asks nothing with its URLs,
// and does not hang: it starts over for whoever is signed in now.
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { type RouteObject } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { PreviewDialog, routes as previewRoutes } from "../../../../src/client/features/preview";
import ImagePreview from "../../../../src/client/features/preview/renderers/ImagePreview";
import MediaPreview from "../../../../src/client/features/preview/renderers/MediaPreview";
import TextPreview from "../../../../src/client/features/preview/renderers/TextPreview";
import { openScope, openScopeCount } from "../../../../src/client/features/preview/scope";
import { listSiblingIds } from "../../../../src/client/features/preview/source";
import { SCAN_POLL_MS } from "../../../../src/client/features/preview/useItem";
import { usePreviewUrl } from "../../../../src/client/features/preview/usePreviewUrl";
import { adoptIdentity, purgeUserState, refreshSession } from "../../../../src/client/lib/query";
import { Frame } from "../../../../src/client/routes/frame/Frame";
import { renderRoutes, seedConfig, seedSession, sessionOf } from "../shell/helpers";
import { ID, NODES, nodeOf } from "./fixtures";
import {
  advance,
  dialog,
  envelope,
  installFetch,
  json,
  loadedOf,
  ownerApi,
  preloadRenderers,
  renderPreview,
  renderer,
  setupPreview,
  settle,
  state,
  type Handler,
} from "./helpers";

setupPreview();

const noop = () => {};
/** A sign-out: the session and the remembered account are forgotten. */
const purge = () => act(async () => void (await purgeUserState()));
/** Another account adopted (what `adoptIdentity` does): the session stays for the new one. */
const switchAccount = () => act(async () => void (await purgeUserState({ keepSession: true })));

/** A response the test releases when it chooses. */
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The API as account A sees it — until `gone.now` is set: from then on every node route answers
 * as it does for someone who has no such file.
 */
function accountA(nodes: Parameters<typeof ownerApi>[0], extra?: Handler) {
  const gone = { now: false };
  const api = ownerApi(nodes, extra);
  const handler: Handler = (call) => (gone.now ? envelope("not_found", 404) : api.handler(call));
  return { api, handler, gone };
}

describe("the scope every late continuation goes through", () => {
  it("ends when it is closed, and when the account is purged — and a purge ends every open one", async () => {
    const before = openScopeCount();
    const first = openScope();
    const second = openScope();
    expect(openScopeCount()).toBe(before + 2);
    expect(first.alive()).toBe(true);
    first.close();
    expect(first.alive()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(second.alive()).toBe(true);
    await purgeUserState();
    expect(second.alive()).toBe(false);
    expect(second.signal.aborted).toBe(true);
    expect(openScopeCount()).toBe(0);
    // Between the purge STARTING and this feature's purger running, the scope is already dead:
    // it reads the account epoch itself.
    const during = openScope();
    const purging = purgeUserState();
    expect(during.signal.aborted).toBe(false);
    expect(during.alive()).toBe(false);
    await purging;
    // A scope opened afterwards belongs to whoever is signed in now.
    const third = openScope();
    expect(third.alive()).toBe(true);
    third.close();
  });
});

describe("the URL hook across a purge", () => {
  it("a mint still on its way: its URL is never published, and no refresh is ever scheduled", async () => {
    vi.useFakeTimers();
    const gate = held<null>();
    const api = ownerApi([NODES.mp4]);
    let mints = 0;
    const network = installFetch({
      api: async (call) => {
        if (!call.url.pathname.endsWith("/download-url")) return api.handler(call);
        mints += 1;
        await gate.promise;
        return api.handler(call);
      },
    });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    expect(mints).toBe(1);
    await purge();
    gate.release(null);
    await advance(0);
    expect(result.current.url).toBeNull();
    expect(result.current.failure).toBeNull();
    await advance(10 * 900_000);
    expect(mints).toBe(1);
    expect(network.files()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a refresh timer: after the purge it asks for nothing; nor does a failure reported by an element", async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    expect(api.minted.length).toBe(1);
    await purge();
    await advance(10 * 900_000);
    expect(api.minted.length).toBe(1);
    await act(async () => void (await result.current.reportFailure()));
    expect(api.minted.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a RETRY timer of a failed refresh: after the purge the retry is never sent", async () => {
    vi.useFakeTimers();
    let mints = 0;
    const api = ownerApi([NODES.mp4], (call) => {
      if (!call.url.pathname.endsWith("/download-url")) return undefined;
      mints += 1;
      return mints >= 2 ? envelope("internal", 503) : undefined;
    });
    installFetch({ api: api.handler });
    renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    await advance(720_000);
    // The refresh failed: a retry is waiting for its 15 s.
    expect(mints).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await purge();
    await advance(10 * 900_000);
    expect(mints).toBe(2);
  });

  it("control: without a purge the same clock does retry", async () => {
    vi.useFakeTimers();
    let mints = 0;
    const api = ownerApi([NODES.mp4], (call) => {
      if (!call.url.pathname.endsWith("/download-url")) return undefined;
      mints += 1;
      return mints >= 2 ? envelope("internal", 503) : undefined;
    });
    installFetch({ api: api.handler });
    renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    await advance(720_000);
    await advance(15_000);
    expect(mints).toBe(3);
  });
});

describe("the dialog across a purge: nothing of the old account stays, and nothing hangs", () => {
  it("a file without a preview: its name, type and Download are gone; the dialog reads again for the new account", async () => {
    const a = accountA([NODES.svg]);
    const network = installFetch({ api: a.handler });
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />);
    await screen.findByText("sample.svg");
    a.gone.now = true;
    await switchAccount();
    await waitFor(() => expect(state()).toBe("error"));
    expect(screen.queryByText("sample.svg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.getByRole("heading", { name: "This file isn't here" })).toBeTruthy();
    expect(renderer()).toBeNull();
    // One read as the old account, one as the new.
    expect(network.api(`/api/nodes/${ID.svg}`).length).toBe(2);
  });

  it("text on screen: the text is gone", async () => {
    await preloadRenderers();
    const a = accountA([NODES.ts]);
    installFetch({ api: a.handler, files: () => new Response("const secret = 1;\n") });
    renderPreview(<PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />);
    await waitFor(() => expect(dialog()?.querySelector("pre")?.textContent).toContain("secret"));
    a.gone.now = true;
    await switchAccount();
    await waitFor(() => expect(state()).toBe("error"));
    expect(document.body.textContent).not.toContain("secret");
    expect(dialog()!.querySelector("pre")).toBeNull();
  });

  it("text bytes still on their way: the transfer is aborted at the purge, and what arrives is never drawn", async () => {
    await preloadRenderers();
    const gate = held<Response>();
    const a = accountA([NODES.ts]);
    const network = installFetch({ api: a.handler, files: () => gate.promise });
    renderPreview(<PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />);
    await waitFor(() => expect(network.files().length).toBe(1));
    const signal = network.files()[0]!.signal!;
    expect(signal.aborted).toBe(false);
    a.gone.now = true;
    await switchAccount();
    expect(signal.aborted).toBe(true);
    gate.release(new Response("const secret = 1;\n"));
    await settle(50);
    expect(document.body.textContent).not.toContain("secret");
    expect(network.files().length).toBe(1);
    expect(state()).toBe("error");
  });

  it("a first mint still on its way: not a skeleton for ever — the dialog starts over", async () => {
    await preloadRenderers();
    vi.useFakeTimers();
    const gate = held<null>();
    const a = accountA([NODES.ts]);
    installFetch({
      api: async (call) => {
        // A's mint, sent before the account changed, answers after it — with A's URL.
        if (!a.gone.now && call.url.pathname.endsWith("/download-url")) {
          await gate.promise;
          return a.api.handler(call);
        }
        return a.handler(call);
      },
    });
    renderPreview(<PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />);
    await advance(0);
    await advance(0);
    expect(state()).toBe("loading");
    a.gone.now = true;
    await switchAccount();
    await advance(0);
    await advance(0);
    expect(state()).toBe("error");
    expect(screen.queryByText("sample.ts")).toBeNull();
    // The late answer arms nothing: a URL taken would schedule its refresh at once, so the
    // property is "no new timer", not "nothing happened in an hour" (fake time is not free: the
    // open dialog's focus trap ticks every 50 ms, and each fake tick is a real turn of the event
    // loop — an hour of them took seconds on a loaded machine).
    const timers = vi.getTimerCount();
    gate.release(null);
    await advance(0);
    await advance(0);
    expect(vi.getTimerCount()).toBe(timers);
    expect(state()).toBe("error");
  });

  it("a film that was playing: the element is stopped and gone, and no question goes to the files host", async () => {
    await preloadRenderers();
    const a = accountA([NODES.mp4]);
    const network = installFetch({ api: a.handler });
    renderPreview(<PreviewDialog open nodeId={ID.mp4} onClose={noop} source="owner" />);
    await waitFor(() => expect(renderer()).toBe("video"));
    await settle();
    const video = dialog()!.querySelector("video")!;
    expect(video.getAttribute("src")).toContain(`/i/${ID.mp4}/`);
    a.gone.now = true;
    await switchAccount();
    await waitFor(() => expect(state()).toBe("error"));
    expect(video.isConnected).toBe(false);
    expect(video.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(network.files()).toEqual([]);
    expect(a.api.minted.length).toBe(1);
  });

  it("the scan poll: the old account's poll stops; the new account's read is its own", async () => {
    vi.useFakeTimers();
    const a = accountA([nodeOf({ scanStatus: "pending" })]);
    const network = installFetch({ api: a.handler });
    renderPreview(<PreviewDialog open nodeId={ID.png} onClose={noop} source="owner" />);
    await advance(0);
    expect(state()).toBe("scanning");
    a.gone.now = true;
    await switchAccount();
    await advance(0);
    const after = network.api(`/api/nodes/${ID.png}`).length;
    expect(state()).toBe("error");
    await advance(6 * SCAN_POLL_MS);
    expect(network.api(`/api/nodes/${ID.png}`).length).toBe(after);
  });

  it("a Download still being minted: no download starts and nothing is said", async () => {
    for (const refuse of [false, true]) {
      const gate = held<null>();
      const api = ownerApi([NODES.svg]);
      installFetch({
        api: async (call) => {
          if (!call.url.pathname.endsWith("/download-url")) return api.handler(call);
          await gate.promise;
          return refuse ? envelope("scan_blocked", 403) : api.handler(call);
        },
      });
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      const view = renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />);
      await screen.findByText("sample.svg");
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      await settle(5);
      await switchAccount();
      gate.release(null);
      await settle(20);
      expect(click).not.toHaveBeenCalled();
      expect(getToasts()).toEqual([]);
      view.unmount();
    }
  });

  it("the folder listing for prev/next: a page that answers after the purge leads to no next page (its transfer is aborted with the scope)", async () => {
    const gate = held<null>();
    const a = accountA([NODES.svg]);
    let pages = 0;
    installFetch({
      api: async (call) => {
        if (a.gone.now || !call.url.pathname.endsWith("/children")) return a.handler(call);
        pages += 1;
        await gate.promise;
        return json({ items: [], nextCursor: "more" });
      },
    });
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} onNavigate={noop} source="owner" />);
    await screen.findByText("sample.svg");
    await waitFor(() => expect(pages).toBe(1));
    a.gone.now = true;
    await switchAccount();
    gate.release(null);
    await settle(30);
    // Page one answered after the purge: page two is never asked for.
    expect(pages).toBe(1);
  });
});

describe("the folder listing's own check", () => {
  it("asks for no next page once its scope is over — even before the scope's signal is aborted (a purge's first moment)", async () => {
    let alive = true;
    const network = installFetch({
      api: () => {
        // The account goes while page one is on its way; the purger has not aborted anything yet.
        alive = false;
        return json({ items: [], nextCursor: "more" });
      },
    });
    const scope = { signal: new AbortController().signal, alive: () => alive };
    expect(await listSiblingIds(ID.folder, scope)).toEqual([]);
    expect(network.api().length).toBe(1);
  });
});

describe("an element's own handlers after a purge (a renderer that is still mounted)", () => {
  it("text: bytes that arrive after the purge are not drawn (the renderer alone, nothing remounts it)", async () => {
    const gate = held<Response>();
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => gate.promise });
    const view = renderPreview(<TextPreview source="owner" item={loadedOf(NODES.ts)} />);
    await waitFor(() => expect(api.minted.length).toBe(1));
    await settle(10);
    await purge();
    // The mock hands the body over although the request was aborted: the check after the read
    // is what keeps it off the screen.
    gate.release(new Response("const secret = 1;\n"));
    await settle(30);
    expect(view.container.querySelector("pre")).toBeNull();
    expect(view.container.textContent).not.toContain("secret");
  });

  it("text: colours that arrive after the purge are not applied", async () => {
    const module = await import("../../../../src/client/features/preview/renderers/highlight");
    const gate = held<null>();
    vi.spyOn(module, "highlight").mockImplementation(async () => {
      await gate.promise;
      return [[{ text: "const secret = 1;", token: "keyword" }]];
    });
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => new Response("const secret = 1;\n") });
    const view = renderPreview(<TextPreview source="owner" item={loadedOf(NODES.ts)} />);
    const shown = () => view.container.querySelector('[data-preview-renderer="text"]');
    await waitFor(() => expect(shown()?.getAttribute("data-highlight")).toBe("running"));
    await purge();
    gate.release(null);
    await settle(30);
    expect(shown()!.getAttribute("data-highlighted")).toBe("false");
    expect(view.container.querySelector("[data-token]")).toBeNull();
  });

  it("text: an account that goes while the highlighter is on its way — no run starts, and nothing is left 'running'", async () => {
    const module = await import("../../../../src/client/features/preview/renderers/highlight");
    const run = vi.spyOn(module, "highlight");
    const languageFor = module.languageFor;
    let purging: Promise<void> | undefined;
    // The purge starts as the highlighter arrives: the account epoch has moved, the purger (which
    // aborts the scope's signal) has not run yet, and nothing remounts the renderer.
    vi.spyOn(module, "languageFor").mockImplementation((ext) => {
      purging ??= purgeUserState();
      return languageFor(ext);
    });
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => new Response("const secret = 1;\n") });
    const view = renderPreview(<TextPreview source="owner" item={loadedOf(NODES.ts)} />);
    await waitFor(() => expect(purging).toBeDefined());
    await act(async () => void (await purging));
    await settle(30);
    expect(run).not.toHaveBeenCalled();
    const shown = view.container.querySelector('[data-preview-renderer="text"]');
    expect(shown?.getAttribute("data-highlight") ?? "none").toBe("none");
  });

  it("control: without a purge the same colours are applied", async () => {
    const module = await import("../../../../src/client/features/preview/renderers/highlight");
    vi.spyOn(module, "highlight").mockImplementation(async () => [
      [{ text: "const secret = 1;", token: "keyword" }],
    ]);
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => new Response("const secret = 1;\n") });
    const view = renderPreview(<TextPreview source="owner" item={loadedOf(NODES.ts)} />);
    await waitFor(() => expect(view.container.querySelector("[data-token]")).not.toBeNull());
  });

  it("an image that finishes loading after the purge is not shown", async () => {
    const api = ownerApi([nodeOf({ thumb: false })]);
    installFetch({ api: api.handler });
    const view = renderPreview(
      <ImagePreview source="owner" item={loadedOf(nodeOf({ thumb: false }))} variant="inline" />,
    );
    await settle();
    const img = view.container.querySelector("img")!;
    await purge();
    fireEvent.load(img);
    expect(view.container.querySelector("[data-preview-blurup]")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Fit" }) as HTMLButtonElement).disabled).toBe(true);
    // Nor does its failing mint anything.
    fireEvent.error(img);
    await settle();
    expect(api.minted.length).toBe(1);
  });

  it("a film's errors after the purge: no re-mint, and no HEAD to the files host with the old account's URL", async () => {
    const api = ownerApi([NODES.mp4]);
    const network = installFetch({ api: api.handler });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await settle();
    const video = view.container.querySelector("video")!;
    await purge();
    for (let round = 0; round < 3; round += 1) {
      Object.defineProperty(video, "error", { configurable: true, value: { code: 2 } });
      fireEvent.error(video);
      await settle();
    }
    expect(network.files()).toEqual([]);
    expect(api.minted.length).toBe(1);
  });

  it("the probe is aborted when the preview closes", async () => {
    const api = ownerApi([NODES.mp4]);
    const network = installFetch({ api: api.handler, files: () => new Promise<Response>(() => {}) });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await settle();
    const video = view.container.querySelector("video")!;
    for (let round = 0; round < 2; round += 1) {
      Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
      fireEvent.error(video);
      await settle();
    }
    expect(network.files().map((call) => call.method)).toEqual(["HEAD"]);
    const signal = network.files()[0]!.signal!;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('after "can\'t play" nothing is minted any more behind the card', async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler, files: () => new Response(null, { status: 200 }) });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await advance(0);
    const video = view.container.querySelector("video")!;
    for (let round = 0; round < 2; round += 1) {
      Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
      fireEvent.error(video);
      await advance(0);
    }
    expect(screen.getByText("Your browser can't play this — download")).toBeTruthy();
    expect(api.minted.length).toBe(2);
    await advance(10 * 900_000);
    expect(api.minted.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("in the real frame: the session re-read names another account, with no navigation", () => {
  const children: RouteObject[] = [
    { index: true, element: <div data-testid="root-page">root</div>, handle: { title: "Files" } },
    ...previewRoutes,
  ];
  const background = children.filter((route) => !(route.handle as { overlay?: boolean }).overlay);
  const routes: RouteObject[] = [{ path: "/", element: <Frame backgroundRoutes={background} />, children }];
  const B = "b".repeat(32);

  it.each([
    ["a text file on screen", NODES.ts, "const secret = 1;"],
    ["a film", NODES.mp4, null],
    ["a file with no preview", NODES.svg, null],
  ] as const)(
    "%s: afterwards nothing of account A is on screen and nothing is left waiting",
    async (_name, node, text) => {
      await preloadRenderers();
      let who = sessionOf();
      const api = ownerApi([node]);
      const network = installFetch({
        api: (call) => {
          if (call.url.pathname === "/api/auth/get-session") return json(who);
          if (call.url.pathname === "/api/account/deletion-status") return json({ scheduledFor: null });
          // B has no such file.
          if (who.user.id === B && call.url.pathname.startsWith("/api/nodes"))
            return envelope("not_found", 404);
          return api.handler(call);
        },
        files: () => new Response(text ?? ""),
      });
      seedSession(sessionOf());
      seedConfig();
      const { router } = renderRoutes(routes, [`/preview/${node.id}`]);
      await screen.findByText(node.name);
      if (text) await waitFor(() => expect(document.body.textContent).toContain(text));
      const before = network.files().length;

      // Another tab signed A out and B in; this tab's session is read again (what a window focus does).
      who = sessionOf({ id: B, name: "Bea Other", email: "bea@example.com" });
      await act(async () => void (await refreshSession()));
      await settle(30);

      expect(router.state.location.pathname).toBe(`/preview/${node.id}`);
      expect(screen.queryByText(node.name)).toBeNull();
      if (text) expect(document.body.textContent).not.toContain(text);
      expect(document.querySelector("video, audio, img[alt]:not([alt=''])")).toBeNull();
      expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
      // Not a dead skeleton: the dialog says what B gets for this address.
      await waitFor(() => expect(state()).toBe("error"));
      expect(screen.getByRole("heading", { name: "This file isn't here" })).toBeTruthy();
      // Nothing more went to the files host with A's URL.
      expect(network.files().length).toBe(before);
    },
  );

  it("what account A put in history state (prev/next ids, the page underneath) is not offered to B", async () => {
    let who = sessionOf();
    const api = ownerApi([NODES.ts, NODES.png, NODES.pdf]);
    installFetch({
      api: (call) => {
        if (call.url.pathname === "/api/auth/get-session") return json(who);
        if (call.url.pathname === "/api/account/deletion-status") return json({ scheduledFor: null });
        if (who.user.id === B && call.url.pathname.startsWith("/api/nodes"))
          return envelope("not_found", 404);
        return api.handler(call);
      },
    });
    seedSession(who);
    seedConfig();
    await act(async () => void (await adoptIdentity(who)));
    const opened = { from: `/folder/${ID.folder}`, siblingIds: [ID.ts, ID.png, ID.pdf] };
    const { router } = renderRoutes(routes, [{ pathname: `/preview/${ID.png}`, state: opened }]);
    await screen.findByText(NODES.png.name);
    expect(screen.getByRole("button", { name: "Next file" })).toBeTruthy();
    // The opener's state is stamped with the account it was written for.
    await waitFor(() =>
      expect(router.state.location.state).toMatchObject({ ...opened, account: who.user.id }),
    );

    who = sessionOf({ id: B, name: "Bea Other", email: "bea@example.com" });
    await act(async () => void (await refreshSession()));
    await waitFor(() => expect(state()).toBe("error"));
    await settle(10);

    expect(screen.queryByRole("button", { name: "Previous file" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
    // Nor are A's ids left in the entry; and Close does not go to A's folder.
    expect(JSON.stringify(router.state.location.state)).not.toContain(ID.ts);
    expect(router.state.location.state).toEqual({ account: B });
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("a sign-out with the preview open: after the purge the dialog asks the API nothing (there is no session to ask with)", async () => {
    await preloadRenderers();
    const api = ownerApi([NODES.svg]);
    const network = installFetch({
      api: (call) => {
        if (call.url.pathname === "/api/auth/get-session") return json(null);
        if (call.url.pathname === "/api/account/deletion-status") return json({ scheduledFor: null });
        return api.handler(call);
      },
    });
    seedSession(sessionOf());
    seedConfig();
    renderRoutes(routes, [`/preview/${ID.svg}`]);
    await screen.findByText(NODES.svg.name);
    await settle(10);
    const before = network.api("/api/nodes").length;

    // What the sign-out action does before it navigates to /login: the purge, without keepSession.
    await act(async () => void (await purgeUserState()));
    await settle(30);

    expect(
      network
        .api("/api/nodes")
        .slice(before)
        .map((call) => call.url.pathname),
    ).toEqual([]);
    expect(screen.queryByText(NODES.svg.name)).toBeNull();
    expect(state()).toBeNull();
  });
});
