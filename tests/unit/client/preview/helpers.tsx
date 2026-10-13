// Helpers of the preview's unit tests (jsdom). The network is a router: `/api/*` answers come
// from fixtures, and the files host is a second handler keyed on the full URL.
import { act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, vi } from "vitest";
import { TOKEN_TTL } from "../../../../src/shared/constants";
import type { LoadedItem } from "../../../../src/client/features/preview/source";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { envelope, json, renderShell, setupShell } from "../shell/helpers";
import { detailOf, downloadUrlOf, FILES_ORIGIN, filesUrl, thumbUrlOf } from "./fixtures";

export { envelope, json };

export interface Call {
  method: string;
  url: URL;
  body: unknown;
  /** The request's abort signal, when it has one. */
  signal: AbortSignal | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response> | undefined;

export interface Network {
  calls: Call[];
  /** Calls to the app's API whose path starts with `prefix`. */
  api(prefix?: string): Call[];
  /** Calls to the files host. */
  files(): Call[];
}

/** Install the fetch router. Unanswered: the API's 404 envelope, the files host's plain 404. */
export function installFetch(handlers: { api?: Handler; files?: Handler } = {}): Network {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
      "http://localhost:3000",
    );
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // not JSON
      }
    }
    const call: Call = {
      method: (init.method ?? "GET").toUpperCase(),
      url,
      body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (url.origin === FILES_ORIGIN) {
      return (await handlers.files?.(call)) ?? new Response("Not found.", { status: 404 });
    }
    return (await handlers.api?.(call)) ?? envelope("not_found", 404);
  });
  return {
    calls,
    api: (prefix = "/api/") =>
      calls.filter((call) => call.url.origin !== FILES_ORIGIN && call.url.pathname.startsWith(prefix)),
    files: () => calls.filter((call) => call.url.origin === FILES_ORIGIN),
  };
}

export interface OwnerApi {
  handler: Handler;
  /** Every URL minted so far, in order, with its kind. */
  minted: Array<{ kind: "inline" | "download" | "thumb"; nodeId: string; url: string; size?: number }>;
}

/**
 * The signed-in API for a set of nodes: `GET /api/nodes/:id`, `download-url`, `thumb-url`.
 * An inline or download mint answers a NEW URL each time (`tok-1`, `tok-2`, …). A THUMBNAIL mint
 * answers the SAME URL every time, as the real API does within a 600 s bucket — a test that
 * wants distinct thumbnail URLs (a mint that straddles a bucket) says `distinctThumbs`.
 */
export function ownerApi(
  nodes: NodeDto[],
  extra?: Handler,
  options: { distinctThumbs?: boolean } = {},
): OwnerApi {
  const minted: OwnerApi["minted"] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const handler: Handler = (call) => {
    const answered = extra?.(call);
    if (answered) return answered;
    const match = /^\/api\/nodes\/([^/]+)(\/[a-z-]+)?$/.exec(call.url.pathname);
    if (!match) return undefined;
    const node = byId.get(decodeURIComponent(match[1]!));
    if (!node) return undefined;
    if (!match[2] && call.method === "GET") return json(detailOf(node));
    if (match[2] === "/download-url" && call.method === "POST") {
      const kind = (call.body as { kind: "inline" | "download" }).kind;
      const url = filesUrl(kind, node.id, `tok-${minted.length + 1}`);
      minted.push({ kind, nodeId: node.id, url });
      return json(downloadUrlOf(url, Date.now(), TOKEN_TTL[kind]));
    }
    if (match[2] === "/thumb-url" && call.method === "GET") {
      const size = Number(call.url.searchParams.get("size"));
      const token = options.distinctThumbs ? `tok-${minted.length + 1}` : "thumb-bucket";
      const url = filesUrl("thumb", node.id, token, size);
      minted.push({ kind: "thumb", nodeId: node.id, url, size });
      return json(thumbUrlOf(url, Date.now()));
    }
    return undefined;
  };
  return { handler, minted };
}

/** A files-host answer whose body must never be read: every reader is a spy that throws. */
export function unreadable(status: number): { response: Response; read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(() => {
    throw new Error("the body of a files-host failure was read");
  });
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
    text: read,
    json: read,
    arrayBuffer: read,
    blob: read,
    formData: read,
    clone: read,
    get body() {
      return read();
    },
  } as unknown as Response;
  return { response, read };
}

/** Let promises settle and effects run (works with real and with fake timers). */
export async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Run the fake clock forward, with effects flushed. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Call once at the top of a test file. */
export function setupPreview(): void {
  setupShell();
  beforeEach(() => {
    // jsdom implements none of these; the element's state is driven by the test.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });
}

export function renderPreview(ui: ReactElement): RenderResult {
  return renderShell(ui);
}

/**
 * The renderer chunks, loaded up front so `React.lazy` resolves without real I/O in a test. The
 * PDF renderer is left to its own test file, which replaces pdf.js first.
 */
export async function preloadRenderers(): Promise<void> {
  await Promise.all([
    import("../../../../src/client/features/preview/renderers/ImagePreview"),
    import("../../../../src/client/features/preview/renderers/MediaPreview"),
    import("../../../../src/client/features/preview/renderers/TextPreview"),
  ]);
}

/**
 * A node as a renderer receives it. For tests that render ONE renderer without the dialog — the
 * long fake-clock ones: an open dialog's focus trap ticks every 50 ms, and an hour of that is slow.
 */
export function loadedOf(node: NodeDto): LoadedItem {
  return {
    id: node.id,
    name: node.name,
    size: node.size,
    mimeCategory: node.mimeCategory,
    ext: node.ext,
    mimeSniffed: node.mimeSniffed,
    scanStatus: node.scanStatus,
    scanReason: node.scanReason,
    thumb: node.thumb,
    versionKey: node.etag,
    node,
  };
}

export const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
export const renderer = () =>
  document.querySelector<HTMLElement>("[data-preview-renderer]")?.getAttribute("data-preview-renderer") ??
  null;
export const state = () =>
  document.querySelector<HTMLElement>("[data-preview-state]")?.getAttribute("data-preview-state") ?? null;
