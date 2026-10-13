// A stand-in upload API for the uploader's jsdom tests: JSON routes through the shell helpers'
// fetch router, bodies through the manager's injected transport (no XMLHttpRequest, no Worker).
import { vi } from "vitest";
import type { ZodType } from "zod";
import type { CompleteUploadBody, InitUploadBody } from "../../../../src/shared/schemas/upload";
import { resetRibbonFeedForTests } from "../../../../src/client/features/upload/ribbon";
import { purgeUploads, setUploadRuntimeForTests } from "../../../../src/client/features/upload/manager";
import type { PutOptions } from "../../../../src/client/features/upload/protocol";
import { ApiError } from "../../../../src/client/lib/api";
import {
  envelope,
  json,
  mockFetch,
  seedConfig,
  seedSession,
  sessionOf,
  type MockCall,
} from "../shell/helpers";
import {
  FOLDER_ID,
  initResponse,
  nodeDetail,
  nodeDto,
  openUploadsResponse,
  partResponse,
  rowId,
  singleResponse,
  usageDto,
} from "./fixtures";

export const DIGEST = "c".repeat(64);

/** Timers only: the stand-in database of the resume tests schedules on `setImmediate`. */
export const FAKED_TIMERS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

export interface PutCall {
  uploadId: string;
  /** The part number, or "single". */
  n: number | "single";
  size: number;
  /** Milliseconds on the (possibly fake) clock when the request started. */
  at: number;
  signal?: AbortSignal;
  progress(loaded: number): void;
  resolve(): void;
  reject(error: unknown): void;
}

type JsonAnswer = Response | undefined;

export interface Server {
  /** Every JSON request, in order. */
  calls: MockCall[];
  /** Every body request, in order (answered or not). */
  puts: PutCall[];
  /** Body requests that are being held. */
  held: PutCall[];
  inits: InitUploadBody[];
  completes: CompleteUploadBody[];
  /** When true a body request waits until the test settles it. */
  hold: boolean;
  /** The part size the server hands out. */
  partBytes: number;
  scanStatus: "pending" | "clean" | "infected" | "error" | "skipped";
  /** Overrides, asked first; `undefined` falls through to the default answer. */
  onInit?: (body: InitUploadBody, nth: number) => JsonAnswer;
  onComplete?: (body: CompleteUploadBody, nth: number) => JsonAnswer;
  onPut?: (call: PutCall, nth: number) => ApiError | undefined;
  onJson?: (call: MockCall) => JsonAnswer;
  /** In-flight body requests right now, and the most there ever were. */
  inFlight: number;
  peak: number;
  count(method: string, path: RegExp): number;
}

export function apiError(status: number, code: string, details?: Record<string, unknown>): ApiError {
  return new ApiError({
    status,
    code: code as ApiError["code"],
    message: `${code} message`,
    requestId: "req-1234",
    details,
  });
}

/** Install the stand-in API and transport. Call inside a test or `beforeEach`. */
export function installServer(): Server {
  let uploads = 0;
  const server: Server = {
    calls: [],
    puts: [],
    held: [],
    inits: [],
    completes: [],
    hold: false,
    partBytes: 67_108_864,
    scanStatus: "clean",
    inFlight: 0,
    peak: 0,
    count: (method, path) => server.calls.filter((c) => c.method === method && path.test(c.path)).length,
  };
  const names = new Map<string, { name: string; parentId: string | null; size: number }>();
  const landed = new Map<string, string>();

  server.calls = mockFetch((call) => {
    const custom = server.onJson?.(call);
    if (custom) return custom;
    if (call.method === "POST" && call.path === "/api/uploads") {
      const body = call.body as InitUploadBody;
      server.inits.push(body);
      const answer = server.onInit?.(body, server.inits.length);
      if (answer) return answer;
      uploads += 1;
      const uploadId = rowId(0x1000 + uploads);
      names.set(uploadId, { name: body.name, parentId: body.parentId, size: body.size });
      return json(initResponse(body.size, { uploadId, partBytes: server.partBytes, finalName: body.name }));
    }
    const complete = /^\/api\/uploads\/([^/]+)\/complete$/.exec(call.path);
    if (call.method === "POST" && complete) {
      const body = call.body as CompleteUploadBody;
      server.completes.push(body);
      const answer = server.onComplete?.(body, server.completes.length);
      if (answer) return answer;
      const session = names.get(complete[1]!);
      landed.set(rowId(0x2000 + server.completes.length), session?.name ?? "notes.txt");
      return json(
        nodeDto({
          id: rowId(0x2000 + server.completes.length),
          name: session?.name ?? "notes.txt",
          parentId: session?.parentId ?? null,
          size: session?.size ?? 0,
          scanStatus: server.scanStatus === "clean" ? "clean" : "pending",
        }),
      );
    }
    if (call.method === "DELETE" && /^\/api\/uploads\/[^/]+$/.test(call.path)) {
      return new Response(null, { status: 204 });
    }
    if (call.path === "/api/uploads/open") return json(openUploadsResponse());
    if (call.path === "/api/account/usage") return json(usageDto());
    if (call.method === "POST" && call.path === "/api/nodes/folder") {
      const body = call.body as { parentId: string | null; name: string };
      return json(
        nodeDto({
          id: rowId(0x3000 + server.calls.length),
          kind: "folder",
          name: body.name,
          parentId: body.parentId,
        }),
      );
    }
    const node = /^\/api\/nodes\/([^/]+)$/.exec(call.path);
    if (call.method === "GET" && node) {
      if (node[1] === FOLDER_ID) return json(nodeDetail({ id: FOLDER_ID, kind: "folder", name: "Projects" }));
      return json(
        nodeDetail({ id: node[1]!, name: landed.get(node[1]!) ?? "notes.txt", scanStatus: server.scanStatus }),
      );
    }
    return undefined;
  });

  setUploadRuntimeForTests({
    put: <T>(path: string, body: Blob, schema: ZodType<T>, options: PutOptions = {}) =>
      new Promise<T>((resolve, reject) => {
        const match = /^\/api\/uploads\/([^/]+)\/(?:parts\/(\d+)|single)$/.exec(path)!;
        const n = match[2] ? Number(match[2]) : ("single" as const);
        const { signal } = options;
        let settled = false;
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          server.inFlight -= 1;
          server.held = server.held.filter((entry) => entry !== call);
          signal?.removeEventListener("abort", aborted);
          settle();
        };
        const aborted = () => finish(() => reject(new DOMException("stopped", "AbortError")));
        const call: PutCall = {
          uploadId: match[1]!,
          n,
          size: body.size,
          at: Date.now(),
          signal,
          progress: (loaded) => options.onProgress?.(loaded),
          resolve: () =>
            finish(() => resolve(schema.parse(n === "single" ? singleResponse() : partResponse(n)))),
          reject: (error) => finish(() => reject(error)),
        };
        server.puts.push(call);
        server.inFlight += 1;
        server.peak = Math.max(server.peak, server.inFlight);
        if (signal?.aborted) {
          aborted();
          return;
        }
        signal?.addEventListener("abort", aborted);
        const failure = server.onPut?.(call, server.puts.length);
        if (failure) call.reject(failure);
        else if (server.hold) server.held.push(call);
        else {
          call.progress(body.size);
          call.resolve();
        }
      }),
    startHash: () => ({ promise: Promise.resolve(DIGEST), cancel: () => {} }),
  });
  return server;
}

/** A file of any size without its bytes: only what the manager reads (name, size, date, slice). */
export function bigFile(name: string, size: number, lastModified = 1_760_000_000_000): File {
  const slice = (from = 0, to = size) => ({ size: Math.min(size, to) - Math.min(size, from) }) as Blob;
  return { name, size, lastModified, type: "application/octet-stream", slice } as unknown as File;
}

export function smallFile(name: string, bytes = 10, lastModified = 1_760_000_000_000): File {
  return new File(["x".repeat(bytes)], name, { type: "text/plain", lastModified });
}

/** Signed in, config known, an empty queue, the ribbon feed in step. For `beforeEach`, after `setupShell()`. */
export async function freshUploader(): Promise<void> {
  await purgeUploads();
  resetRibbonFeedForTests();
  seedSession(sessionOf());
  seedConfig();
}

/** Let promise chains run. With fake timers, pass the time to move the clock by. */
export async function settle(ms = 0): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
  else for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

export { envelope, json };
