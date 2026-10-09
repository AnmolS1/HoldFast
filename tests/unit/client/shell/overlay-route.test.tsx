// A `handle.overlay` route renders ABOVE the page that was open, which stays mounted.
import { act, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import { Frame } from "../../../../src/client/routes/frame/Frame";
import { renderRoutes, seedConfig, seedSession, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

let mounts = 0;
let unmounts = 0;

function ListPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  useEffect(() => {
    mounts += 1;
    return () => {
      unmounts += 1;
    };
  }, []);
  return (
    <div data-testid="list">
      <span data-testid="list-state">
        folder={id} count={count}
      </span>
      <button onClick={() => setCount((c) => c + 1)}>increment</button>
      <button onClick={() => navigate("/preview/node-9", { state: { from: `/folder/${id}` } })}>open preview</button>
    </div>
  );
}

function PreviewPage() {
  const { nodeId } = useParams();
  const navigate = useNavigate();
  return (
    <div data-testid="preview">
      preview of {nodeId}
      <button onClick={() => navigate("/preview/node-10", { replace: true, state: { from: "/folder/7" } })}>next</button>
      <button onClick={() => navigate(-1)}>close</button>
    </div>
  );
}

const children: RouteObject[] = [
  { index: true, element: <div data-testid="root-page">root page</div>, handle: { title: "Files" } },
  { path: "folder/:id", element: <ListPage />, handle: { title: "Folder" } },
  { path: "preview/:nodeId", element: <PreviewPage />, handle: { overlay: true, title: "Preview" } },
];
const background = children.filter((route) => !(route.handle as { overlay?: boolean }).overlay);
const routes: RouteObject[] = [{ path: "/", element: <Frame backgroundRoutes={background} />, children }];

function arrange() {
  mounts = 0;
  unmounts = 0;
  shellFetch({ session: sessionOf() });
  seedSession(sessionOf());
  seedConfig();
}

describe("overlay routes", () => {
  it("the list stays mounted under the preview: same instance, same state, same params", async () => {
    arrange();
    const { router } = renderRoutes(routes, ["/folder/7"]);
    await screen.findByTestId("list");
    act(() => screen.getByText("increment").click());
    act(() => screen.getByText("increment").click());
    expect(screen.getByTestId("list-state").textContent).toBe("folder=7 count=2");

    act(() => screen.getByText("open preview").click());
    await screen.findByTestId("preview");
    expect(router.state.location.pathname).toBe("/preview/node-9");
    // Both are in the document; the list kept its state and ITS route params.
    expect(screen.getByTestId("list-state").textContent).toBe("folder=7 count=2");
    expect(screen.getByTestId("preview").textContent).toContain("preview of node-9");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);

    // The overlay sits above the list in the same pane, and the list is inert underneath.
    const overlay = document.querySelector("[data-overlay]")!;
    const kept = document.querySelector('[data-background="kept"]')!;
    expect(overlay.contains(screen.getByTestId("preview"))).toBe(true);
    expect(kept.contains(screen.getByTestId("list"))).toBe(true);
    expect(kept.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(kept.hasAttribute("inert")).toBe(true);

    // Moving between previews keeps the same background.
    act(() => screen.getByText("next").click());
    await waitFor(() => expect(screen.getByTestId("preview").textContent).toContain("preview of node-10"));
    expect(screen.getByTestId("list-state").textContent).toBe("folder=7 count=2");
    expect(mounts).toBe(1);

    // Closing returns to the list — still the same instance.
    act(() => screen.getByText("close").click());
    await waitFor(() => expect(screen.queryByTestId("preview")).toBeNull());
    expect(router.state.location.pathname).toBe("/folder/7");
    expect(screen.getByTestId("list-state").textContent).toBe("folder=7 count=2");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(document.querySelector("[data-overlay]")).toBeNull();
  });

  it("a cold deep link renders the page named by state.from underneath", async () => {
    arrange();
    renderRoutes(routes, [{ pathname: "/preview/node-3", state: { from: "/folder/42" } }]);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("list-state").textContent).toBe("folder=42 count=0");
    expect(document.querySelector("[data-overlay]")!.contains(screen.getByTestId("preview"))).toBe(true);
  });

  it("a cold deep link with no state falls back to the root page", async () => {
    arrange();
    renderRoutes(routes, ["/preview/node-3"]);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("root-page")).toBeTruthy();
  });

  it("a cold deep link ignores an off-site `from`", async () => {
    arrange();
    renderRoutes(routes, [{ pathname: "/preview/node-3", state: { from: "//evil.example" } }]);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("root-page")).toBeTruthy();
  });

  it("control: a route WITHOUT handle.overlay replaces the list (it unmounts)", async () => {
    arrange();
    const plain: RouteObject[] = [
      { path: "/", element: <Frame backgroundRoutes={background} />, children: [children[0]!, children[1]!, { path: "preview/:nodeId", element: <PreviewPage />, handle: { title: "Preview" } }] },
    ];
    renderRoutes(plain, ["/folder/7"]);
    await screen.findByTestId("list");
    act(() => screen.getByText("open preview").click());
    await screen.findByTestId("preview");
    expect(screen.queryByTestId("list")).toBeNull();
    expect(unmounts).toBe(1);
    expect(document.querySelector("[data-overlay]")).toBeNull();
  });
});
