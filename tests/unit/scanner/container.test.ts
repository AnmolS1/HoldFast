// The scanner helpers (T20) against a fake container: every call goes through `new Request(…)`, so a
// body is locked by the first call exactly as the real Durable Object stub locks it. The SCANNER
// binding itself is never called here (containers are off in tests).
import { describe, expect, it } from "vitest";
import {
  BUDGET_HEADER,
  CAPACITY_RETRY_SECONDS,
  fnv1a,
  preferredInstance,
  SCAN_MAX_BYTES,
  SCAN_TIMEOUT_MS,
  SCANNER_INSTANCES,
  ScannerBusyError,
  ScannerNotReadyError,
  ScannerRefusedError,
  ScannerTransportError,
  scanObject,
  scannerHealth,
  scanSmall,
  SMALL_SCAN_BYTES,
  type ScannerInstance,
  type ScannerStub,
  type ShimVerdict,
} from "../../../src/worker/scan/container";
import { MAX_FILE_BYTES_DEFAULT } from "../../../src/shared/constants";

// The binding is never touched: every test passes its own stub factory.
const env = {} as Pick<Env, "SCANNER">;

type Answer = (request: Request) => Promise<Response>;

interface Call {
  name: ScannerInstance;
  size: string | null;
  url: string;
}

/** A fake container per instance name; records each call in order. */
function fakeScanner(answers: Partial<Record<ScannerInstance, Answer>>) {
  const calls: Call[] = [];
  const stub = (name: ScannerInstance): ScannerStub => ({
    async fetch(input, init) {
      const request = new Request(input, init); // locks a stream body, as the real stub does
      calls.push({ name, size: request.headers.get("X-Scan-Size"), url: request.url });
      const answer = answers[name];
      if (!answer) throw new Error(`no answer scripted for ${name}`);
      return answer(request);
    },
  });
  return { calls, stub };
}

function verdict(overrides: Partial<ShimVerdict> = {}): ShimVerdict {
  return {
    status: "clean",
    signatures: [],
    pua: [],
    sha256: "0".repeat(64),
    bytes: 0,
    engine: "ClamAV 1.5.4",
    dbVersion: "28160",
    dbAgeHours: 2.3,
    durationMs: 5,
    ...overrides,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const busy = () => json(503, { status: "busy" }, { "Retry-After": "15", "X-Scan-Status": "busy" });
/**
 * A refusal as it really arrives when the shim answers before reading an upload (integration run):
 * status and headers intact, the body lost — reading it throws "Network connection lost.".
 */
const headersOnly = (status: number, headers: Record<string, string>) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("Network connection lost."));
      },
    }),
    { status, headers },
  );
const MAX_INSTANCES =
  "Failed to start container: Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic bytes, and a stream of them in `chunk`-sized pieces. */
function bytesOf(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}
function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

/** Reads the whole request body and answers a clean verdict with its hash and length. */
const readAll: Answer = async (request) => {
  const body = new Uint8Array(await request.arrayBuffer());
  return json(200, verdict({ bytes: body.length, sha256: await sha256Hex(body) }));
};

/** Reads `chunks` chunks of the body, then answers busy without reading the rest. */
const readSomeThenBusy =
  (chunks: number): Answer =>
  async (request) => {
    const reader = request.body!.getReader();
    for (let i = 0; i < chunks; i++) if ((await reader.read()).done) break;
    return busy();
  };

/** A key whose preferred instance is `name`. */
function keyFor(name: ScannerInstance): string {
  for (let i = 0; ; i++) if (preferredInstance(`u/user/node/${i}`) === name) return `u/user/node/${i}`;
}

describe("instance choice", () => {
  it("is FNV-1a over the key, stable per key, and uses both instances", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
    const key = "u/0190a/0190b/0190c";
    expect(preferredInstance(key)).toBe(SCANNER_INSTANCES[fnv1a(key) % 2]);
    for (let i = 0; i < 5; i++) expect(preferredInstance(key)).toBe(preferredInstance(key));
    const seen = new Set(Array.from({ length: 50 }, (_, i) => preferredInstance(`u/x/${i}`)));
    expect([...seen].sort()).toEqual([...SCANNER_INSTANCES]);
  });

  it("is sent to the preferred instance once, with X-Scan-Size and the whole body", async () => {
    const bytes = bytesOf(300_000);
    const key = keyFor("scanner-1");
    const { calls, stub } = fakeScanner({ "scanner-1": readAll });
    const result = await scanObject(env, { key, size: bytes.length, body: streamOf(bytes) }, { stub });
    expect(calls).toEqual([{ name: "scanner-1", size: "300000", url: "http://scanner/scan" }]);
    expect(result).toMatchObject({ status: "clean", bytes: 300_000, sha256: await sha256Hex(bytes) });
  });
});

describe("busy", () => {
  it("on the preferred instance falls over to the other, which receives the whole body", async () => {
    const bytes = bytesOf(1_000_000);
    const { calls, stub } = fakeScanner({ "scanner-0": async () => busy(), "scanner-1": readAll });
    const result = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: streamOf(bytes) },
      { stub },
    );
    expect(calls.map((c) => c.name)).toEqual(["scanner-0", "scanner-1"]);
    expect(result).toMatchObject({ bytes: 1_000_000, sha256: await sha256Hex(bytes) });
  });

  it("after the first instance read part of the body, the other still receives all of it, in order", async () => {
    const bytes = bytesOf(1_000_000);
    const { calls, stub } = fakeScanner({ "scanner-0": readSomeThenBusy(3), "scanner-1": readAll });
    const result = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: streamOf(bytes) },
      { stub },
    );
    expect(calls.map((c) => c.name)).toEqual(["scanner-0", "scanner-1"]);
    expect(result).toMatchObject({ bytes: 1_000_000, sha256: await sha256Hex(bytes) });
  });

  it("when the first instance read more than can be replayed, is thrown — never a partial second send", async () => {
    const bytes = bytesOf(1_000_000);
    const { calls, stub } = fakeScanner({ "scanner-0": readSomeThenBusy(5), "scanner-1": readAll });
    const scan = scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: streamOf(bytes) },
      { stub, replayMaxBytes: 128 * 1024 },
    );
    await expect(scan).rejects.toBeInstanceOf(ScannerBusyError);
    expect(calls.map((c) => c.name)).toEqual(["scanner-0"]);
  });

  it("a read the first attempt left pending lands in the second attempt in order (in-flight guard, review m1)", async () => {
    // The source's second chunk arrives late; the first instance asks for it, then answers busy
    // without waiting. The second attempt must replay chunk 0, then that pending chunk 1, then the rest.
    const chunk = 64 * 1024;
    const bytes = bytesOf(chunk * 6);
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= 6) return controller.close();
        if (index === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(bytes.slice(index * chunk, (index + 1) * chunk));
        index++;
      },
    });
    const leavePending: Answer = async (request) => {
      const reader = request.body!.getReader();
      await reader.read(); // chunk 0
      void reader.read(); // chunk 1: still pending when busy is answered
      return busy();
    };
    const { calls, stub } = fakeScanner({ "scanner-0": leavePending, "scanner-1": readAll });
    const result = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: source },
      { stub },
    );
    expect(calls.map((c) => c.name)).toEqual(["scanner-0", "scanner-1"]);
    expect(result).toMatchObject({ bytes: bytes.length, sha256: await sha256Hex(bytes) });
  });

  it("a replay record that overflows after the fall-over started is busy, never a body with a hole (review m2)", async () => {
    // As above, but the pending chunk takes the record past its bound once the second attempt has
    // begun: the second send cannot be completed, so the outcome is ScannerBusyError.
    const chunk = 64 * 1024;
    const bytes = bytesOf(chunk * 6);
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= 6) return controller.close();
        if (index === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(bytes.slice(index * chunk, (index + 1) * chunk));
        index++;
      },
    });
    const leavePending: Answer = async (request) => {
      const reader = request.body!.getReader();
      await reader.read();
      void reader.read();
      return busy();
    };
    const second: Answer = async (request) => {
      const body = new Uint8Array(await request.arrayBuffer()); // errors when the replay breaks
      return json(200, verdict({ bytes: body.length, sha256: await sha256Hex(body) }));
    };
    const { stub } = fakeScanner({ "scanner-0": leavePending, "scanner-1": second });
    const thrown = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: source },
      { stub, replayMaxBytes: chunk + chunk / 2 },
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(ScannerBusyError);
  });

  it("is read from the headers when the 503's body is lost (the shim answered before reading the upload)", async () => {
    const bytes = bytesOf(1_000_000);
    const lost = async () => headersOnly(503, { "Retry-After": "15", "X-Scan-Status": "busy" });
    const { calls, stub } = fakeScanner({ "scanner-0": lost, "scanner-1": readAll });
    const result = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: streamOf(bytes) },
      { stub },
    );
    expect(calls.map((c) => c.name)).toEqual(["scanner-0", "scanner-1"]);
    expect(result.sha256).toBe(await sha256Hex(bytes));

    const notReady = fakeScanner({
      "scanner-0": async () =>
        headersOnly(503, {
          "Retry-After": "30",
          "X-Scan-Status": "not_ready",
          "X-Scan-Reason": "signatures",
          "X-Scan-Db-Age-Hours": "30.5",
        }),
    });
    const error = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
      { stub: notReady.stub },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ScannerNotReadyError);
    expect(error).toMatchObject({ reason: "signatures", dbAgeHours: 30.5, retryAfter: 30 });

    // A 503 that says nothing is not busy: it is an engine failure.
    const silent = fakeScanner({ "scanner-0": async () => headersOnly(503, {}) });
    await expect(
      scanObject(
        env,
        { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
        { stub: silent.stub },
      ),
    ).rejects.toMatchObject({ name: "ScannerTransportError", reason: "engine" });
  });

  it("on both instances throws ScannerBusyError after exactly two calls", async () => {
    const { calls, stub } = fakeScanner({ "scanner-0": async () => busy(), "scanner-1": async () => busy() });
    const error = await scanObject(
      env,
      { key: "u/a/b/c", size: 3, body: streamOf(bytesOf(3)) },
      { stub },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ScannerBusyError);
    expect(error.retryAfter).toBe(15);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.name)).size).toBe(2);
  });

  it("standing check (c): N calls against two busy instances cost exactly 2N container calls and N ScannerBusyErrors", async () => {
    const { calls, stub } = fakeScanner({ "scanner-0": async () => busy(), "scanner-1": async () => busy() });
    const n = 25;
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) =>
        scanObject(env, { key: `u/burst/${i}`, size: 10, body: streamOf(bytesOf(10)) }, { stub }),
      ),
    );
    expect(calls).toHaveLength(2 * n);
    expect(
      results.filter((r) => r.status === "rejected" && r.reason instanceof ScannerBusyError),
    ).toHaveLength(n);
  });

  it("a resolved 500 'Maximum number of running container instances exceeded' is busy, not a failure", async () => {
    // spike S9: the platform answers a full max_instances with a Response; stub.fetch() does not reject.
    const full = async () => new Response(MAX_INSTANCES, { status: 500 });
    const both = fakeScanner({ "scanner-0": full, "scanner-1": full });
    const error = await scanObject(
      env,
      { key: "u/a/b/c", size: 3, body: streamOf(bytesOf(3)) },
      { stub: both.stub },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ScannerBusyError);
    expect(error.retryAfter).toBe(CAPACITY_RETRY_SECONDS);
    expect(both.calls).toHaveLength(2);

    const bytes = bytesOf(70_000);
    const one = fakeScanner({ "scanner-0": full, "scanner-1": readAll });
    const result = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: bytes.length, body: streamOf(bytes) },
      { stub: one.stub },
    );
    expect(result.sha256).toBe(await sha256Hex(bytes));
  });
});

describe("not ready, transport and limits", () => {
  it("not_ready throws ScannerNotReadyError with the reason, age and Retry-After — and tries no other instance", async () => {
    const { calls, stub } = fakeScanner({
      "scanner-0": async () =>
        json(503, { status: "not_ready", reason: "signatures", dbAgeHours: 30.5 }, { "Retry-After": "30" }),
      "scanner-1": readAll,
    });
    const error = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
      { stub },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ScannerNotReadyError);
    expect(error).toMatchObject({ reason: "signatures", dbAgeHours: 30.5, retryAfter: 30 });
    expect(calls).toHaveLength(1);

    const loading = fakeScanner({
      "scanner-1": async () => json(503, { status: "not_ready", reason: "clamd_loading", dbAgeHours: 0 }),
    });
    const second = await scanSmall(env, bytesOf(3), {
      stub: (name) => (name === "scanner-0" ? { fetch: async () => busy() } : loading.stub(name)),
    }).catch((e) => e);
    expect(second).toMatchObject({ name: "ScannerNotReadyError", reason: "clamd_loading", retryAfter: 30 });
  });

  it("no answer within the budget throws ScannerTransportError('timeout') and aborts the call", async () => {
    // The abort is what frees the instance's large-scan slot (review m4): the shim sees the
    // connection go and stops.
    let signal: AbortSignal | null | undefined;
    const stub = () => ({
      fetch: (_input: string, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });
    const error = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
      { stub, timeoutMs: 30 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ScannerTransportError);
    expect(error.reason).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  it("sends its budget to the Durable Object, which cuts the container request off at it", async () => {
    const budgets: (string | null)[] = [];
    const stub = () => ({
      fetch: async (input: string, init?: RequestInit) => {
        budgets.push(new Request(input, init).headers.get(BUDGET_HEADER));
        return json(200, verdict({ bytes: 3 }));
      },
    });
    await scanObject(env, { key: "u/b", size: 3, body: streamOf(bytesOf(3)) }, { stub });
    await scanObject(env, { key: "u/b", size: 3, body: streamOf(bytesOf(3)) }, { stub, timeoutMs: 30_000 });
    await scanSmall(env, bytesOf(3), { stub });
    expect(budgets).toEqual([String(SCAN_TIMEOUT_MS), "30000", String(SCAN_TIMEOUT_MS)]);
  });

  it("a deploy's 'Durable Object reset because its code was updated.' rejection is a retryable engine failure", async () => {
    const { calls, stub } = fakeScanner({
      "scanner-0": async () => {
        throw new Error("Durable Object reset because its code was updated.");
      },
      "scanner-1": readAll,
    });
    const error = await scanObject(
      env,
      { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
      { stub },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ScannerTransportError);
    expect(error.reason).toBe("engine");
    expect((error.cause as Error).message).toBe("Durable Object reset because its code was updated.");
    expect(calls).toHaveLength(1);
  });

  it("413 and 400 are refusals of this body — ScannerRefusedError, not retryable, no other instance tried", async () => {
    for (const [status, error] of [
      [413, "overrun"],
      [413, "size"],
      [400, "short"],
      [400, "X-Scan-Size"],
    ] as const) {
      const { calls, stub } = fakeScanner({
        "scanner-0": async () => json(status, { error }),
        "scanner-1": readAll,
      });
      const thrown = await scanObject(
        env,
        { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
        { stub },
      ).catch((e) => e);
      expect(thrown).toBeInstanceOf(ScannerRefusedError);
      expect(thrown).toMatchObject({ status, reason: error });
      expect(calls).toHaveLength(1);
    }
  });

  it("any other answer is an engine failure, never a verdict", async () => {
    for (const answer of [
      async () => new Response("Internal Server Error", { status: 500 }),
      async () => json(503, { status: "something" }),
      async () => new Response("not json", { status: 200 }),
      async () => json(200, { status: "fine" }),
      // A 200 verdict that is not about this body (review m3): another length, or no real hash.
      async () => json(200, verdict({ bytes: 4, sha256: "a".repeat(64) })),
      async () => json(200, verdict({ bytes: 3, sha256: "not-a-hash" })),
      async () => json(200, verdict({ bytes: 3, sha256: "A".repeat(64) })),
    ]) {
      const { stub } = fakeScanner({ "scanner-0": answer, "scanner-1": readAll });
      const error = await scanObject(
        env,
        { key: keyFor("scanner-0"), size: 3, body: streamOf(bytesOf(3)) },
        { stub },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(ScannerTransportError);
      expect(error.reason).toBe("engine");
    }
  });

  it("passes the shim's verdicts through unchanged", async () => {
    for (const v of [
      verdict({ status: "infected", signatures: ["Eicar-Test-Signature"] }),
      verdict({
        status: "limits_exceeded",
        reason: "limits",
        signatures: ["Heuristics.Limits.Exceeded.MaxRecursion"],
      }),
      verdict({ status: "encrypted", reason: "encrypted", signatures: ["Heuristics.Encrypted.Zip"] }),
      verdict({ status: "error", reason: "timeout" }),
      verdict({ status: "clean" }),
    ].map((v) => ({ ...v, bytes: 3 }))) {
      const { stub } = fakeScanner({
        "scanner-0": async () => json(200, v),
        "scanner-1": async () => json(200, v),
      });
      expect(await scanObject(env, { key: "u/v", size: 3, body: streamOf(bytesOf(3)) }, { stub })).toEqual(v);
    }
  });

  it("above SCAN_MAX_BYTES throws RangeError and makes no container call; at it, it scans", async () => {
    const { calls, stub } = fakeScanner({
      "scanner-0": async () => json(200, verdict({ bytes: SCAN_MAX_BYTES })),
      "scanner-1": async () => json(200, verdict({ bytes: SCAN_MAX_BYTES })),
    });
    for (const size of [SCAN_MAX_BYTES + 1, -1, 1.5, Number.NaN]) {
      await expect(
        scanObject(env, { key: "u/big", size, body: streamOf(bytesOf(1)) }, { stub }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toHaveLength(0);
    // At the cap the call is made (the fake does not read the body).
    await scanObject(env, { key: "u/big", size: SCAN_MAX_BYTES, body: streamOf(bytesOf(1)) }, { stub });
    expect(calls).toEqual([
      { name: preferredInstance("u/big"), size: "2000000000", url: "http://scanner/scan" },
    ]);
  });

  it("SCAN_MAX_BYTES is the engine fact 2,000,000,000 and equals today's product cap", () => {
    expect(SCAN_MAX_BYTES).toBe(2_000_000_000);
    expect(SCAN_MAX_BYTES).toBe(MAX_FILE_BYTES_DEFAULT);
  });
});

describe("scanSmall", () => {
  it("scans on scanner-0 first, scanner-1 once on busy, and refuses more than 8 MiB without a call", async () => {
    const bytes = bytesOf(5_000_000);
    const one = fakeScanner({ "scanner-0": readAll });
    expect(await scanSmall(env, bytes, { stub: one.stub })).toMatchObject({
      bytes: 5_000_000,
      sha256: await sha256Hex(bytes),
    });
    expect(one.calls).toEqual([{ name: "scanner-0", size: "5000000", url: "http://scanner/scan" }]);

    const two = fakeScanner({ "scanner-0": async () => busy(), "scanner-1": readAll });
    expect(await scanSmall(env, bytes, { stub: two.stub })).toMatchObject({ sha256: await sha256Hex(bytes) });
    expect(two.calls.map((c) => c.name)).toEqual(["scanner-0", "scanner-1"]);

    const both = fakeScanner({ "scanner-0": async () => busy(), "scanner-1": async () => busy() });
    await expect(scanSmall(env, bytes, { stub: both.stub })).rejects.toBeInstanceOf(ScannerBusyError);
    expect(both.calls).toHaveLength(2);

    const none = fakeScanner({});
    await expect(
      scanSmall(env, new Uint8Array(SMALL_SCAN_BYTES + 1), { stub: none.stub }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(none.calls).toHaveLength(0);
    const edge = fakeScanner({ "scanner-0": readAll });
    expect((await scanSmall(env, new Uint8Array(SMALL_SCAN_BYTES), { stub: edge.stub })).bytes).toBe(
      SMALL_SCAN_BYTES,
    );
  });
});

describe("scannerHealth", () => {
  const health = {
    ready: true,
    clamd: "up",
    engine: "ClamAV 1.5.4",
    dbVersion: "28160",
    dbAgeHours: 2.3,
    freshclam: "ok",
    busy: false,
  };

  it("returns the instance's /health with one call", async () => {
    const { calls, stub } = fakeScanner({ "scanner-1": async () => json(200, health) });
    expect(await scannerHealth(env, "scanner-1", { stub })).toEqual(health);
    expect(calls).toEqual([{ name: "scanner-1", size: null, url: "http://scanner/health" }]);
  });

  it("refuses a name that is not one of the two instances, without a call", async () => {
    const { calls, stub } = fakeScanner({});
    await expect(scannerHealth(env, "scanner-2", { stub })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("times out (5 s by default; shortened here) and maps failures", async () => {
    const hang = fakeScanner({ "scanner-0": () => new Promise<Response>(() => {}) });
    await expect(scannerHealth(env, "scanner-0", { stub: hang.stub, timeoutMs: 30 })).rejects.toMatchObject({
      name: "ScannerTransportError",
      reason: "timeout",
    });
    const full = fakeScanner({ "scanner-0": async () => new Response(MAX_INSTANCES, { status: 500 }) });
    await expect(scannerHealth(env, "scanner-0", { stub: full.stub })).rejects.toBeInstanceOf(
      ScannerBusyError,
    );
    const broken = fakeScanner({ "scanner-0": async () => new Response("oops", { status: 502 }) });
    await expect(scannerHealth(env, "scanner-0", { stub: broken.stub })).rejects.toMatchObject({
      reason: "engine",
    });
  });
});
