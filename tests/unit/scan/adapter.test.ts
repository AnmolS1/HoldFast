// The real scanner behind `getScanner` (scan/adapter.ts, R6) against T20's fake-container seam,
// and `scanSmallObject` (fold #15: it RETURNS error/engine, never throws) — down to the avatar
// route that relies on it.
import { describe, expect, it, vi } from "vitest";
import {
  ScannerBusyError,
  ScannerNotReadyError,
  ScannerRefusedError,
  ScannerTransportError,
  scanSmall,
  type ScannerInstance,
  type ScannerStub,
  type ShimVerdict,
} from "../../../src/worker/scan/container";
import { scannerOver, verdictOf } from "../../../src/worker/scan/adapter";
import { classify, isDeployReset, DEPLOY_RESET_MESSAGE } from "../../../src/worker/scan/consumer";
import { scanSmallObject } from "../../../src/worker/services/scanning";
import { pngBytes } from "../../setup/fixture-bytes";
import { nodeById } from "../services-core/helpers";
import { complete, init, putSingle, uploader, userRow } from "../uploads/helpers";
import { enc, infectedBytes, sha256Of } from "./helpers";

vi.mock("../../../src/worker/scan/container", async (original) => {
  const real = await original<typeof import("../../../src/worker/scan/container")>();
  return { ...real, scanSmall: vi.fn(real.scanSmall) };
});

const env = {} as Pick<Env, "SCANNER">;

function shim(overrides: Partial<ShimVerdict> = {}): ShimVerdict {
  return {
    status: "clean",
    signatures: [],
    pua: [],
    sha256: "a".repeat(64),
    bytes: 3,
    engine: "ClamAV 1.5.4",
    dbVersion: "28160",
    dbAgeHours: 1,
    durationMs: 4,
    ...overrides,
  };
}

/** A fake container: every instance answers `answer`. */
function fake(answer: (request: Request) => Promise<Response>) {
  const names: ScannerInstance[] = [];
  const stub = (name: ScannerInstance): ScannerStub => ({
    async fetch(input, init) {
      names.push(name);
      return answer(new Request(input, init));
    },
  });
  return { names, stub };
}

const body = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

describe("verdictOf: the shim's verdict as a ScanVerdict", () => {
  it("maps every status; carries the server hash; error is never clean", () => {
    expect(verdictOf(shim())).toMatchObject({
      status: "clean",
      sha256: "a".repeat(64),
      engine: "ClamAV 1.5.4",
    });
    expect(verdictOf(shim({ status: "infected", signatures: ["X"] }))).toMatchObject({
      status: "infected",
      signatures: ["X"],
    });
    expect(verdictOf(shim({ status: "limits_exceeded", reason: "limits" }))).toMatchObject({
      status: "skipped",
      reason: "limits",
    });
    expect(verdictOf(shim({ status: "encrypted", reason: "encrypted" }))).toMatchObject({
      status: "skipped",
      reason: "encrypted",
    });
    expect(verdictOf(shim({ status: "error", reason: "timeout" }))).toMatchObject({
      status: "error",
      reason: "timeout",
    });
    expect(verdictOf(shim({ status: "error", reason: "engine" }))).toMatchObject({
      status: "error",
      reason: "engine",
    });
    expect(verdictOf(shim({ status: "bogus" as never }))).toMatchObject({
      status: "error",
      reason: "engine",
    });
  });
});

describe("scannerOver", () => {
  it("streams to /scan and answers the mapped verdict", async () => {
    const bytes = enc("abc");
    const { stub, names } = fake(async (request) => {
      expect(new URL(request.url).pathname).toBe("/scan");
      expect(request.headers.get("X-Scan-Size")).toBe("3");
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
      return Response.json(shim({ sha256: await sha256Of(bytes) }));
    });
    const verdict = await scannerOver(env, { stub }).scanStream(body(bytes), { key: "u/a/b/c", size: 3 });
    expect(verdict).toMatchObject({ status: "clean", sha256: await sha256Of(bytes), bytes: 3 });
    expect(names).toHaveLength(1);
    expect((await scannerOver(env, { stub }).scanBytes(bytes)).status).toBe("clean");
  });

  it("passes T20's typed errors through untouched", async () => {
    const cases: [() => Promise<Response>, new (...args: never[]) => Error][] = [
      [
        async () => Response.json({ status: "busy" }, { status: 503, headers: { "X-Scan-Status": "busy" } }),
        ScannerBusyError,
      ],
      [
        async () =>
          new Response(null, {
            status: 503,
            headers: { "X-Scan-Status": "not_ready", "X-Scan-Reason": "signatures" },
          }),
        ScannerNotReadyError,
      ],
      [async () => Response.json({ error: "too_large" }, { status: 413 }), ScannerRefusedError],
      [async () => new Response("bad gateway", { status: 502 }), ScannerTransportError],
      [async () => Promise.reject(new Error(DEPLOY_RESET_MESSAGE)), ScannerTransportError],
    ];
    for (const [answer, type] of cases) {
      const { stub } = fake(answer);
      await expect(
        scannerOver(env, { stub }).scanStream(body(enc("abc")), { key: "u/a/b/c", size: 3 }),
      ).rejects.toBeInstanceOf(type);
    }
  });

  it("a deploy reset is recognised on the cause; another cause, or the message on the wrapper, is not", async () => {
    const reset = new ScannerTransportError("engine", "scanner call failed", {
      cause: new Error(DEPLOY_RESET_MESSAGE),
    });
    expect(isDeployReset(reset)).toBe(true);
    expect(classify(reset)).toEqual({ error: "reset", minDelay: 0 });
    const other = new ScannerTransportError("engine", "scanner call failed", {
      cause: new Error("Network connection lost."),
    });
    expect(isDeployReset(other)).toBe(false);
    expect(classify(other)).toEqual({ error: "engine", minDelay: 0 });
    expect(isDeployReset(new ScannerTransportError("engine", DEPLOY_RESET_MESSAGE))).toBe(false);
    expect(isDeployReset(new Error(DEPLOY_RESET_MESSAGE))).toBe(false);
    expect(classify(new ScannerBusyError(60))).toEqual({ error: "busy", minDelay: 60 });
    expect(classify(new ScannerNotReadyError("clamd_loading", null, 30))).toEqual({
      error: "not_ready",
      minDelay: 30,
    });
  });
});

describe("scanSmallObject (fold #15)", () => {
  const STUB = { SCAN_STUB: "1", SENTRY_ENVIRONMENT: "test", SCANNER: {} as never };
  const OFF = { SCAN_STUB: "0", SENTRY_ENVIRONMENT: "test", SCANNER: {} as never };

  it("clean and EICAR with the stub, each with the server sha256", async () => {
    const clean = enc("nothing to see");
    expect(await scanSmallObject(STUB, clean)).toMatchObject({
      status: "clean",
      sha256: await sha256Of(clean),
    });
    const bad = infectedBytes();
    expect(await scanSmallObject(STUB, bad)).toMatchObject({
      status: "infected",
      sha256: await sha256Of(bad),
    });
  });

  it("the real scanner's answer, through the adapter", async () => {
    const bytes = enc("xyz");
    vi.mocked(scanSmall).mockResolvedValueOnce(
      shim({ status: "infected", signatures: ["Y"], sha256: await sha256Of(bytes) }),
    );
    expect(await scanSmallObject(OFF, bytes)).toMatchObject({
      status: "infected",
      sha256: await sha256Of(bytes),
    });
  });

  it("unavailable, not ready, busy, transport, refused → RETURNS error/engine with the server sha256 — never throws", async () => {
    const bytes = enc("an avatar");
    const errors = [
      new ScannerNotReadyError("signatures", 99, 30),
      new ScannerBusyError(15),
      new ScannerTransportError("engine", "scanner call failed"),
      new ScannerTransportError("timeout", "no answer"),
      new ScannerRefusedError(400, "short_body"),
    ];
    for (const error of errors) {
      vi.mocked(scanSmall).mockRejectedValueOnce(error);
      expect(await scanSmallObject(OFF, bytes), error.name).toMatchObject({
        status: "error",
        reason: "engine",
        sha256: await sha256Of(bytes),
      });
    }
    // No SCANNER binding at all.
    expect(await scanSmallObject({ ...OFF, SCANNER: undefined as never }, bytes)).toMatchObject({
      status: "error",
      reason: "engine",
    });
  });

  it("the avatar route: a busy scanner stores the avatar error and never makes it current (no 5xx)", async () => {
    const user = await uploader();
    // A picture of its own (bytes after the PNG's end): nothing another test listed.
    const base = pngBytes(32, 32);
    const PNG = new Uint8Array(base.length + 16);
    PNG.set(base);
    PNG.set(crypto.getRandomValues(new Uint8Array(16)), base.length);
    const session = await init(user, {
      purpose: "avatar",
      mimeDeclared: "image/png",
      name: "me.png",
      size: PNG.byteLength,
    });
    expect((await putSingle(user, session.uploadId, PNG)).status).toBe(200);
    vi.mocked(scanSmall).mockRejectedValueOnce(new ScannerBusyError(15));
    const answer = await complete(user, session.uploadId, {}, { env: { SCAN_STUB: "0" }, sent: [] });
    expect(answer.status).toBe(201);
    const node = (await nodeById(String((answer.body as { id: string }).id)))!;
    expect(node).toMatchObject({ scanStatus: "error", system: "avatar" });
    expect((await userRow(user.id)).avatarNodeId).not.toBe(node.id);
  });
});
