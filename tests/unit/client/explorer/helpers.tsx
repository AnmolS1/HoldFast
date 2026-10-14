// Helpers of the explorer's unit tests (jsdom). The API is the in-memory FakeDrive behind a fetch
// stub; the page is rendered at its real routes inside a small stand-in for the app frame.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Outlet, type RouteObject } from "react-router";
import { beforeEach, expect } from "vitest";
import { Breadcrumbs } from "../../../../src/client/components/Breadcrumbs";
import { DetailsPanel } from "../../../../src/client/components/DetailsPanel";
import { getToasts, Toaster } from "../../../../src/client/components/Toaster";
import { routes } from "../../../../src/client/features/explorer";
import { announce } from "../../../../src/client/features/explorer/actions";
import {
  resetChangedForTests,
  resetEditsForTests,
  resetSortForTests,
} from "../../../../src/client/features/explorer/queries";
import { resetZipForTests, setZipSleepForTests } from "../../../../src/client/features/explorer/zip";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { buildRoutes } from "../../../../src/client/router";
import {
  envelope,
  json,
  mockFetch,
  renderRoutes,
  seedConfig,
  seedSession,
  sessionOf,
  setupShell,
  shellFetch,
  type MockCall,
  type MockHandler,
} from "../shell/helpers";
import type { FakeDrive } from "./fixtures/drive";

/** `setupShell()` plus this feature's own stores back to empty. */
export function setupExplorer(): void {
  setupShell();
  beforeEach(() => {
    resetSortForTests();
    resetZipForTests();
    resetChangedForTests();
    resetEditsForTests();
    setZipSleepForTests(null);
    announce("");
    // The files origin a minted URL is checked against.
    seedConfig();
  });
}

/** Route `fetch` to the fake drive; `extra` answers first (the files host, a held request). */
/** A handler of a test's own: it may be `async` and answer nothing (the drive then answers). */
export type DriveHandler = (call: MockCall) => Response | undefined | Promise<Response | undefined>;

export function serveDrive(drive: FakeDrive, extra?: DriveHandler): MockCall[] {
  return mockFetch(async (call) => {
    // Awaited: an `async` handler that answers nothing must fall through to the drive.
    const own = await extra?.(call);
    if (own) return own;
    const answer = drive.handle({ method: call.method, path: call.path, body: call.body });
    // Nobody's: the same 404 envelope the shell's helper answers an unknown path with.
    if (!answer) return envelope("not_found", 404);
    return answer.body === undefined
      ? new Response(null, { status: answer.status })
      : json(answer.body, answer.status);
  });
}

function TestFrame() {
  return (
    <>
      <header data-header="">
        <Breadcrumbs fallbackTitle="Files" />
      </header>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <Outlet />
      </div>
      <DetailsPanel />
      <Toaster />
    </>
  );
}

/** The explorer's real routes under a stand-in frame, with a marker where the preview route is. */
export function renderExplorer(path = "/") {
  seedSession(sessionOf());
  seedConfig();
  const tree: RouteObject[] = [
    {
      path: "/",
      element: <TestFrame />,
      children: [...routes, { path: "preview/:nodeId", element: <div data-preview-route="" /> }],
    },
  ];
  return renderRoutes(tree, [path]);
}

/** The whole app — the real frame, its key handler and route tree — over the fake drive. */
export function renderApp(drive: FakeDrive, path = "/", extra?: MockHandler) {
  shellFetch({
    session: sessionOf(),
    extra: (call) => {
      const own = extra?.(call);
      if (own) return own;
      const answer = drive.handle({ method: call.method, path: call.path, body: call.body });
      if (!answer) return undefined;
      return answer.body === undefined
        ? new Response(null, { status: answer.status })
        : json(answer.body, answer.status);
    },
  });
  return renderRoutes(buildRoutes(), [path]);
}

export const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]"));
export const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
export const selectedIds = () =>
  rows()
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => row.getAttribute("data-item-id"));

export async function waitForRows(count: number): Promise<void> {
  await waitFor(() => expect(rows().length).toBe(count));
}

/** Open the context menu of a row; returns the ids of its entries, in order. */
export async function openMenu(id: string): Promise<{ menu: HTMLElement; ids: string[] }> {
  fireEvent.contextMenu(rowOf(id)!);
  const menu = await screen.findByRole("menu");
  const ids = Array.from(menu.querySelectorAll("[data-action]"), (item) => item.getAttribute("data-action")!);
  return { menu, ids };
}

export function pick(menu: HTMLElement, action: string): void {
  fireEvent.click(menu.querySelector<HTMLElement>(`[data-action="${action}"]`)!);
}

export const toastMessages = () => getToasts().map((entry) => entry.message);

/** Record every tree-changed event sent while a test runs. */
export function recordNodesChanged(): { events: Array<(string | null)[]>; stop(): void } {
  const events: Array<(string | null)[]> = [];
  const stop = onNodesChanged((detail) => events.push([...detail.parentIds]));
  return { events, stop };
}

/** A promise a test settles by hand, to hold a request open. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
