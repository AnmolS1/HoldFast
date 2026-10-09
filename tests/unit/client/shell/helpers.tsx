// Shared helpers of the shell's unit tests (jsdom). Network is never real: `fetch` is a router.
import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { afterEach, beforeEach, vi } from "vitest";
import { resetBreadcrumbsForTests } from "../../../../src/client/components/Breadcrumbs";
import { resetCommandsForTests } from "../../../../src/client/components/CommandPalette";
import { resetDetailsPanelForTests } from "../../../../src/client/components/DetailsPanel";
import { resetThumbCacheForTests } from "../../../../src/client/components/ThumbImage";
import { clearToasts } from "../../../../src/client/components/Toaster";
import { resetRibbonForTests } from "../../../../src/client/components/TransferRibbon";
import { resetApiForTests } from "../../../../src/client/lib/api";
import type { PublicConfig, SessionShape, SessionUserShape } from "../../../../src/client/lib/contracts";
import { resetPrefsForTests } from "../../../../src/client/lib/prefs";
import { publicConfigQuery, queryClient, resetIdentityForTests, sessionQuery } from "../../../../src/client/lib/query";
import { connectRouter } from "../../../../src/client/router";
import { closeShortcuts } from "../../../../src/client/routes/help";
import { HoldfastThemeProvider } from "../../../../src/client/theme";

export const CONFIG: PublicConfig = {
  signupMode: "invite",
  quotaBytes: 5368709120,
  maxFileBytes: 2000000000,
  partBytes: 67108864,
  turnstileSiteKey: "",
  appOrigin: "http://localhost:3000",
  filesOrigin: "http://files.localhost:3000",
  termsVersion: "2026-10",
  uploadsEnabled: true,
  linksEnabled: true,
  readOnly: false,
  sentryDsnWeb: null,
  sentryEnvironment: "test",
  release: "test",
};

export const USER: SessionUserShape = {
  id: "a".repeat(32),
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  role: "user",
  timezone: "UTC",
  termsVersion: "2026-10",
  deleteScheduledAt: null,
};

export function sessionOf(patch: Partial<SessionUserShape> = {}, session: { impersonatedBy?: string | null } = {}): NonNullable<SessionShape> {
  return { user: { ...USER, ...patch }, session };
}

// --- viewport ---------------------------------------------------------------------------------

let viewportWidth = 1280;
let coarse = false;
let darkScheme = false;
const mediaListeners = new Set<() => void>();

function evaluate(query: string): boolean {
  return query.split(",").some((part) => {
    const q = part.trim();
    const min = /\(min-width:\s*([\d.]+)px\)/.exec(q);
    const max = /\(max-width:\s*([\d.]+)px\)/.exec(q);
    if (min) return viewportWidth >= Number(min[1]);
    if (max) return viewportWidth <= Number(max[1]);
    if (q.includes("pointer: coarse")) return coarse;
    if (q.includes("prefers-color-scheme: dark")) return darkScheme;
    return false;
  });
}

export function setViewport(width: number, options: { coarse?: boolean; dark?: boolean } = {}): void {
  viewportWidth = width;
  coarse = options.coarse ?? false;
  darkScheme = options.dark ?? false;
  for (const listener of mediaListeners) listener();
}

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => {
    const handlers = new Map<unknown, () => void>();
    const list = {
      get matches() {
        return evaluate(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, handler: (event: { matches: boolean }) => void) => {
        const wrapped = () => handler({ matches: evaluate(query) });
        handlers.set(handler, wrapped);
        mediaListeners.add(wrapped);
      },
      removeEventListener: (_: string, handler: unknown) => {
        const wrapped = handlers.get(handler);
        if (wrapped) mediaListeners.delete(wrapped);
      },
      addListener: (handler: (event: { matches: boolean }) => void) => list.addEventListener("change", handler),
      removeListener: (handler: unknown) => list.removeEventListener("change", handler),
      dispatchEvent: () => false,
    };
    return list;
  }) as unknown as typeof window.matchMedia;
}

// --- IntersectionObserver ---------------------------------------------------------------------

type IoCallback = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
const observers = new Set<{ callback: IoCallback; targets: Set<Element> }>();

/** Make every observed element (or the ones matching `filter`) intersect. */
export function intersect(filter: (element: Element) => boolean = () => true): void {
  for (const observer of Array.from(observers)) {
    const hits = Array.from(observer.targets).filter(filter);
    if (hits.length) observer.callback(hits.map((target) => ({ isIntersecting: true, target })));
  }
}

export function observedCount(): number {
  let count = 0;
  for (const observer of observers) count += observer.targets.size;
  return count;
}

function installObservers(): void {
  class FakeIntersectionObserver {
    private readonly record: { callback: IoCallback; targets: Set<Element> };
    constructor(callback: IoCallback) {
      this.record = { callback, targets: new Set() };
      observers.add(this.record);
    }
    observe(element: Element) {
      this.record.targets.add(element);
    }
    unobserve(element: Element) {
      this.record.targets.delete(element);
    }
    disconnect() {
      this.record.targets.clear();
      observers.delete(this.record);
    }
    takeRecords() {
      return [];
    }
  }
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(window, { IntersectionObserver: FakeIntersectionObserver, ResizeObserver: FakeResizeObserver });
  Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver, ResizeObserver: FakeResizeObserver });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = (() => {}) as Element["scrollTo"];
}

/** jsdom lays nothing out: give every element a size so the list virtualizer has a viewport. */
export function stubLayout(width = 1000, height = 600): () => void {
  const spies = [
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height),
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width),
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width),
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height),
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

// --- fetch ------------------------------------------------------------------------------------

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type MockHandler = (call: MockCall) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function envelope(error: string, status: number, details?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return json({ error, message: `${error} message`, requestId: "req-1234", details }, status, headers);
}

/** Install a fetch router. Returns the list of calls made; an unhandled path is a 404 envelope. */
export function mockFetch(handler: MockHandler): MockCall[] {
  const calls: MockCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, "http://localhost:3000");
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // not JSON
      }
    }
    const call: MockCall = { method: (init.method ?? "GET").toUpperCase(), path: url.pathname + url.search, body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return (await handler(call)) ?? envelope("not_found", 404);
  });
  return calls;
}

/** The two requests every guarded route makes, plus whatever `extra` answers. */
export function shellFetch(options: { session?: SessionShape | (() => SessionShape); config?: Partial<PublicConfig> | (() => PublicConfig); extra?: MockHandler } = {}): MockCall[] {
  return mockFetch((call) => {
    const extra = options.extra?.(call);
    if (extra) return extra;
    if (call.path === "/api/auth/get-session") return json(typeof options.session === "function" ? options.session() : (options.session ?? null));
    if (call.path === "/api/public/config") return json(typeof options.config === "function" ? options.config() : { ...CONFIG, ...options.config });
    if (call.path === "/api/account/deletion-status") return json({ scheduledFor: null });
    return undefined;
  });
}

// --- rendering --------------------------------------------------------------------------------

export function Providers({ children }: { children: ReactNode }) {
  return (
    <HoldfastThemeProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </HoldfastThemeProvider>
  );
}

export function renderShell(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: Providers });
}

/** Render a route tree in a memory router wired to the API client like the real one. */
export function renderRoutes(routes: RouteObject[], initialEntries: Array<string | { pathname: string; search?: string; state?: unknown }>, extra?: ReactNode) {
  const router = createMemoryRouter(routes, { initialEntries });
  connectRouter(router);
  const view = render(
    <>
      <RouterProvider router={router} />
      {extra}
    </>,
    { wrapper: Providers },
  );
  return { router, ...view };
}

export function seedSession(session: SessionShape): void {
  queryClient.setQueryData(sessionQuery.queryKey, session);
}

export function seedConfig(config: Partial<PublicConfig> = {}): void {
  queryClient.setQueryData(publicConfigQuery.queryKey, { ...CONFIG, ...config });
}

/** Resolve a `var(--hf-…)` value against the stylesheet of the active scheme. */
export function resolveVar(value: string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!match) return value.trim();
  return getComputedStyle(document.documentElement).getPropertyValue(match[1]!).trim();
}

export async function flush(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Call once at the top of a test file: installs the stubs and resets every store between tests. */
export function setupShell(): void {
  beforeEach(() => {
    installMatchMedia();
    installObservers();
    setViewport(1280);
    localStorage.clear();
    sessionStorage.clear();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 15_000 } });
    resetApiForTests();
    resetIdentityForTests();
    resetPrefsForTests();
    resetRibbonForTests();
    resetDetailsPanelForTests();
    resetBreadcrumbsForTests();
    resetCommandsForTests();
    resetThumbCacheForTests();
    clearToasts();
    closeShortcuts();
    // query.ts registered these with the API client at import; resetApiForTests dropped them.
    return import("../../../../src/client/lib/query").then((query) => query.reconnectApiForTests());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    observers.clear();
    mediaListeners.clear();
    document.documentElement.removeAttribute("data-dark");
    document.documentElement.removeAttribute("data-light");
  });
}
