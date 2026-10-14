// `/preview/:nodeId` inside the real frame: the dialog over the list that opened it, prev/next
// through the ids in the route's state, where Close goes, and where focus goes.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useLocation, useNavigate, useParams, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import { routes as previewRoutes } from "../../../../src/client/features/preview";
import { adoptIdentity } from "../../../../src/client/lib/query";
import { Frame } from "../../../../src/client/routes/frame/Frame";
import { renderRoutes, seedConfig, seedSession, sessionOf } from "../shell/helpers";
import { ID, NODES, nodeOf } from "./fixtures";
import {
  dialog,
  envelope,
  installFetch,
  json,
  ownerApi,
  renderer,
  setupPreview,
  settle,
  state,
} from "./helpers";

setupPreview();

const SIBLINGS = [ID.svg, ID.html, ID.other];
const third = nodeOf({ ...NODES.svg, id: ID.other, name: "third.svg" });

function ListPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  return (
    <div data-testid="list">
      <span data-testid="list-state">
        folder={id ?? "root"} count={count}
      </span>
      <button onClick={() => setCount((value) => value + 1)}>increment</button>
      <button
        onClick={() =>
          void navigate(`/preview/${ID.svg}`, { state: { siblingIds: SIBLINGS, from: location.pathname } })
        }
      >
        open sample.svg
      </button>
    </div>
  );
}

const children: RouteObject[] = [
  { index: true, element: <ListPage />, handle: { title: "Files" } },
  { path: "folder/:id", element: <ListPage />, handle: { title: "Files" } },
  ...previewRoutes,
];
const background = children.filter((route) => !(route.handle as { overlay?: boolean }).overlay);
const routes: RouteObject[] = [{ path: "/", element: <Frame backgroundRoutes={background} />, children }];

function arrange(extra?: Parameters<typeof ownerApi>[1]) {
  const api = ownerApi([NODES.svg, NODES.html, third], (call) => {
    const answered = extra?.(call);
    if (answered) return answered;
    if (call.url.pathname === "/api/auth/get-session") return json(sessionOf());
    if (call.url.pathname === "/api/account/deletion-status") return json({ scheduledFor: null });
    return undefined;
  });
  const network = installFetch({ api: api.handler });
  seedSession(sessionOf());
  seedConfig();
  return { api, network };
}

describe("the preview route", () => {
  it("is one overlay route, deep-linkable by node id", () => {
    expect(previewRoutes.map((route) => [route.path, route.handle])).toEqual([
      ["preview/:nodeId", { overlay: true, title: "Preview" }],
    ]);
  });

  it("opened from a list: the dialog is over it, prev/next replace the entry, Close goes back and focus returns", async () => {
    arrange();
    const { router } = renderRoutes(routes, [`/folder/${ID.folder}`]);
    await screen.findByTestId("list");
    act(() => screen.getByText("increment").click());
    const opener = screen.getByText("open sample.svg");
    opener.focus();
    act(() => opener.click());

    await screen.findByText("sample.svg");
    expect(router.state.location.pathname).toBe(`/preview/${ID.svg}`);
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    // The list is still mounted underneath, with its state.
    expect(screen.getByTestId("list-state").textContent).toBe(`folder=${ID.folder} count=1`);
    expect(document.querySelector("[data-overlay]")).not.toBeNull();

    // Next, by the button and by the key: the same history entry, the next file.
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    await screen.findByText("sample.html");
    expect(router.state.location.pathname).toBe(`/preview/${ID.html}`);
    fireEvent.keyDown(dialog()!, { key: "ArrowRight" });
    await screen.findByText("third.svg");
    expect(router.state.location.pathname).toBe(`/preview/${ID.other}`);
    fireEvent.keyDown(dialog()!, { key: "ArrowLeft" });
    await screen.findByText("sample.html");
    expect(router.state.location.state).toEqual({ siblingIds: SIBLINGS, from: `/folder/${ID.folder}` });

    // Escape: back to the list — the same instance — and focus is on what opened the preview.
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${ID.folder}`));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByTestId("list-state").textContent).toBe(`folder=${ID.folder} count=1`);
    expect(document.activeElement).toBe(opener);
    // One step back was enough: prev/next never grew the history.
    expect(router.state.historyAction).toBe("POP");
  });

  it("the close button does the same as Escape", async () => {
    arrange();
    const { router } = renderRoutes(routes, [`/folder/${ID.folder}`]);
    await screen.findByTestId("list");
    act(() => screen.getByText("open sample.svg").click());
    await screen.findByText("sample.svg");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${ID.folder}`));
  });

  it("a cold link: the file's folder becomes the page underneath, and Close goes there", async () => {
    const { network } = arrange();
    const { router } = renderRoutes(routes, [`/preview/${ID.svg}`]);
    await screen.findByText("sample.svg");
    await waitFor(() =>
      expect(router.state.location.state).toMatchObject({ from: `/folder/${ID.folder}`, cold: true }),
    );
    expect(router.state.location.pathname).toBe(`/preview/${ID.svg}`);
    await waitFor(() =>
      expect(screen.getByTestId("list-state").textContent).toContain(`folder=${ID.folder}`),
    );
    // Without ids in the state the folder is listed for prev/next.
    await waitFor(() =>
      expect(network.api().some((call) => call.url.pathname === `/api/nodes/${ID.folder}/children`)).toBe(
        true,
      ),
    );

    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${ID.folder}`));
    // Nothing was behind the link: the folder replaced it rather than being pushed after it.
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("a cold link to a file at the top level closes to /", async () => {
    const rootFile = nodeOf({ ...NODES.svg, parentId: null });
    arrange((call) =>
      call.url.pathname === `/api/nodes/${ID.svg}` ? json({ node: rootFile, breadcrumbs: [] }) : undefined,
    );
    const { router } = renderRoutes(routes, [`/preview/${ID.svg}`]);
    await screen.findByText("sample.svg");
    await waitFor(() => expect(router.state.location.state).toMatchObject({ from: "/" }));
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it.each([
    [404, "not_found"],
    [500, "internal"],
  ])(
    "a cold link whose node load answers %i: the dialog's error state, and Close goes to /",
    async (status, code) => {
      arrange((call) => (call.url.pathname.startsWith("/api/nodes/") ? envelope(code, status) : undefined));
      const { router } = renderRoutes(routes, ["/preview/node-1"]);
      await waitFor(() => expect(state()).toBe("error"));
      expect(renderer()).toBeNull();
      expect(document.querySelector("[data-overlay]")).not.toBeNull();
      fireEvent.keyDown(dialog()!, { key: "Escape" });
      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    },
  );

  it("an off-site `from`, or ids that are not strings, are ignored", async () => {
    arrange();
    const { router } = renderRoutes(routes, [
      { pathname: `/preview/${ID.svg}`, state: { from: "//evil.example", siblingIds: [1, 2] } },
    ]);
    await screen.findByText("sample.svg");
    await waitFor(() => expect(router.state.location.state).toMatchObject({ from: `/folder/${ID.folder}` }));
    await settle(10);
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${ID.folder}`));
  });
});

describe("the account stamp on the route's history state", () => {
  // As the app's frame route: a loader that takes a moment (the session read), so a navigation
  // to the preview's own address is "loading" for a while before it lands.
  const slow: RouteObject[] = [
    {
      path: "/",
      loader: () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
      element: <Frame backgroundRoutes={background} />,
      children,
    },
  ];

  it("opened with an opener's unstamped state: stamped once, and the navigation settles", async () => {
    arrange();
    await act(async () => void (await adoptIdentity(sessionOf())));
    const { router } = renderRoutes(slow, [`/folder/${ID.folder}`]);
    await screen.findByTestId("list");
    const navigations: string[] = [];
    const stop = router.subscribe((next) => {
      if (next.navigation.state === "loading") navigations.push(next.navigation.location?.pathname ?? "");
      // A loop is cut off here, so the test fails on the count below instead of hanging the worker.
      if (navigations.length > 20) router.dispose();
    });
    act(() => screen.getByText("open sample.svg").click());
    await screen.findByText("sample.svg");
    // Long enough for a loop to show itself many times over (each turn is one 20 ms loader).
    await settle(400);
    stop();
    // The opener's push, and the one replace that stamps it — not one after another for ever.
    expect(navigations.length).toBeLessThanOrEqual(2);
    expect(router.state.navigation.state).toBe("idle");
    expect(router.state.location.state).toEqual({
      siblingIds: SIBLINGS,
      from: `/folder/${ID.folder}`,
      account: sessionOf().user.id,
    });
    // Still usable: Next moves on.
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    await screen.findByText("sample.html");
  });
});
