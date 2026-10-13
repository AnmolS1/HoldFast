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
import { resetSortForTests } from "../../../../src/client/features/explorer/queries";
import { resetZipForTests } from "../../../../src/client/features/explorer/zip";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import {
  json,
  mockFetch,
  renderRoutes,
  seedConfig,
  seedSession,
  sessionOf,
  setupShell,
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
    announce("");
  });
}

/** Route `fetch` to the fake drive; `extra` answers first (the files host, a held request). */
export function serveDrive(drive: FakeDrive, extra?: MockHandler): MockCall[] {
  return mockFetch((call) => {
    const own = extra?.(call);
    if (own) return own;
    const answer = drive.handle({ method: call.method, path: call.path, body: call.body });
    if (!answer) return undefined;
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
