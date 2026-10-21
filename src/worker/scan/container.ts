// The scanner container (T20): the `ScannerContainer` Durable Object class that wrangler.jsonc binds as
// SCANNER, and the helpers the Worker calls it through. The container is containers/clamav — clamd
// behind a small HTTP shim on :8080 (POST /scan, GET /health; contract in its Dockerfile header).
//
// The helpers return the shim's own verdict shape; T21 adapts it to `ScanVerdict`
// (services/scanning.ts). They never retry on their own: busy / not ready / transport failures are
// thrown as typed errors carrying the delay the queue should wait. No keep-warm: nothing here runs
// on a schedule.

import { Container, getContainer } from "@cloudflare/containers";

export class ScannerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
}

/**
 * ClamAV's scan limit as this deployment uses it — an engine fact, not the policy var
 * `MAX_FILE_BYTES`. Objects above it are never sent to the container.
 */
export const SCAN_MAX_BYTES = 2_000_000_000;
/** At or below this size a scan bypasses the instance's single large-scan slot. */
export const SMALL_SCAN_BYTES = 8 * 1024 * 1024;
/**
 * The two fixed instance names. `max_instances` is 2 and a third name is refused for up to
 * `sleepAfter`, so names are never derived per file (spike S9). T25 repeats these two literals.
 */
export const SCANNER_INSTANCES = ["scanner-0", "scanner-1"] as const;
export type ScannerInstance = (typeof SCANNER_INSTANCES)[number];
/** One scan's budget, under the queue consumer's 15-minute wall (C10). */
export const SCAN_TIMEOUT_MS = 12 * 60 * 1000;
export const HEALTH_TIMEOUT_MS = 5_000;
/**
 * How much of a body is kept to send it again to the other instance after `busy`. The shim
 * answers busy from the headers alone, so only what the runtime pulled before that answer is
 * held; past this, the first instance is reading the body and has accepted the scan.
 */
export const REPLAY_MAX_BYTES = 16 * 1024 * 1024;

/** `Failed to start container: …` — the platform's answer when `max_instances` are all running (S9). */
const MAX_INSTANCES_BODY =
  "Failed to start container: Maximum number of running container instances exceeded";
/** Seconds to wait when the platform has no instance to start; one counts as running for `sleepAfter`. */
export const CAPACITY_RETRY_SECONDS = 60;
const BUSY_RETRY_SECONDS = 15;
const NOT_READY_RETRY_SECONDS = 30;

/** The shim's verdict JSON (containers/clamav). */
export interface ShimVerdict {
  status: "clean" | "infected" | "limits_exceeded" | "encrypted" | "error";
  reason?: "encrypted" | "limits" | "timeout" | "engine";
  signatures: string[];
  pua: string[];
  sha256: string;
  bytes: number;
  engine: string;
  dbVersion: string;
  dbAgeHours: number;
  durationMs: number;
}

/** The shim's `GET /health` JSON. */
export interface ScannerHealth {
  ready: boolean;
  clamd: "up" | "loading" | "down";
  engine: string;
  dbVersion: string;
  dbAgeHours: number;
  freshclam: "pending" | "ok" | "failed";
  busy: boolean;
}

/** Both instances are busy, or the platform has no instance to start. Retry after `retryAfter` s. */
export class ScannerBusyError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number, message = "scanner busy") {
    super(message);
    this.name = "ScannerBusyError";
    this.retryAfter = retryAfter;
  }
}

/** The instance's signatures are stale (or clamd is loading): it gives no verdict yet. */
export class ScannerNotReadyError extends Error {
  readonly reason: "signatures" | "clamd_loading";
  readonly dbAgeHours: number | null;
  readonly retryAfter: number;
  constructor(reason: "signatures" | "clamd_loading", dbAgeHours: number | null, retryAfter: number) {
    super(`scanner not ready: ${reason}`);
    this.name = "ScannerNotReadyError";
    this.reason = reason;
    this.dbAgeHours = dbAgeHours;
    this.retryAfter = retryAfter;
  }
}

/** The call failed (a reset, a crash, an unexpected answer) or ran out of time. Retryable. */
export class ScannerTransportError extends Error {
  readonly reason: "timeout" | "engine";
  constructor(reason: "timeout" | "engine", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScannerTransportError";
    this.reason = reason;
  }
}

/** What the helpers need of a Durable Object stub. */
export interface ScannerStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Test seams; production callers pass nothing. */
export interface ScannerDeps {
  stub?: (name: ScannerInstance) => ScannerStub;
  timeoutMs?: number;
  replayMaxBytes?: number;
}

type ScannerEnv = Pick<Env, "SCANNER">;

const stubFor = (env: ScannerEnv, deps: ScannerDeps | undefined) =>
  deps?.stub ?? ((name: ScannerInstance): ScannerStub => getContainer(env.SCANNER, name));

/** 32-bit FNV-1a over the key's UTF-8 bytes. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The instance a key is sent to first: the same one for the same key, every time. */
export function preferredInstance(key: string): ScannerInstance {
  return SCANNER_INSTANCES[fnv1a(key) % SCANNER_INSTANCES.length]!;
}

const otherInstance = (name: ScannerInstance): ScannerInstance =>
  name === SCANNER_INSTANCES[0] ? SCANNER_INSTANCES[1] : SCANNER_INSTANCES[0];

function retryAfterOf(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isInteger(seconds) && seconds > 0 ? seconds : fallback;
}

const VERDICT_STATUSES = new Set(["clean", "infected", "limits_exceeded", "encrypted", "error"]);

function isVerdict(value: unknown): value is ShimVerdict {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === "string" &&
    VERDICT_STATUSES.has(v.status) &&
    Array.isArray(v.signatures) &&
    Array.isArray(v.pua) &&
    typeof v.sha256 === "string" &&
    typeof v.bytes === "number"
  );
}

/** Runs `work` against a deadline; on expiry `onTimeout` runs and the call throws a timeout. */
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new ScannerTransportError("timeout", `scanner did not answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a scanner answer. The status is inspected, not only caught: the platform answers a full
 * `max_instances` with a resolved 500 (S9).
 */
async function verdictOf(response: Response): Promise<ShimVerdict> {
  if (response.status === 200) {
    const body: unknown = await response.json().catch(() => null);
    if (isVerdict(body)) return body;
    throw new ScannerTransportError("engine", "scanner answered 200 without a verdict");
  }
  const text = await response.text().catch(() => "");
  if (response.status === 503) {
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not the shim's answer
    }
    if (body?.status === "busy") throw new ScannerBusyError(retryAfterOf(response, BUSY_RETRY_SECONDS));
    if (body?.status === "not_ready") {
      const reason = body.reason === "signatures" ? "signatures" : "clamd_loading";
      const age = typeof body.dbAgeHours === "number" ? body.dbAgeHours : null;
      throw new ScannerNotReadyError(reason, age, retryAfterOf(response, NOT_READY_RETRY_SECONDS));
    }
  }
  if (response.status === 500 && text.startsWith(MAX_INSTANCES_BODY)) {
    throw new ScannerBusyError(CAPACITY_RETRY_SECONDS, "no scanner instance could be started");
  }
  throw new ScannerTransportError("engine", `scanner answered ${response.status}`);
}

/**
 * A body that can be sent a second time, if the first receiver read little of it. Every chunk taken
 * from the source is recorded up to `maxBytes`; a new attempt replays the record, then continues
 * with the source. Past `maxBytes` the record is dropped and no new attempt is possible.
 */
class ReplayableBody {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #maxBytes: number;
  #recorded: Uint8Array[] = [];
  #recordedBytes = 0;
  #replayable = true;
  #attempt = 0;
  #inflight: Promise<unknown> | null = null;

  constructor(source: ReadableStream<Uint8Array>, maxBytes: number) {
    this.#reader = source.getReader();
    this.#maxBytes = maxBytes;
  }

  get replayable(): boolean {
    return this.#replayable;
  }

  /** A fresh stream of the whole body; the previous attempt's stream ends where it is. */
  next(): ReadableStream<Uint8Array> {
    const id = ++this.#attempt;
    let index = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            // A read the previous attempt started lands in the record first.
            if (this.#inflight) await this.#inflight.catch(() => {});
            if (id !== this.#attempt) return controller.close();
            if (this.#replayable && index < this.#recorded.length) {
              controller.enqueue(this.#recorded[index++]!);
              return;
            }
            const read = this.#reader.read();
            this.#inflight = read;
            const result = await read;
            if (this.#inflight === read) this.#inflight = null;
            if (!result.done && this.#replayable) {
              this.#recordedBytes += result.value.byteLength;
              if (this.#recordedBytes > this.#maxBytes) {
                this.#replayable = false;
                this.#recorded = [];
              } else {
                this.#recorded.push(result.value);
              }
            }
            if (id !== this.#attempt) return controller.close();
            if (result.done) return controller.close();
            if (this.#replayable) index = this.#recorded.length;
            controller.enqueue(result.value);
          } catch (error) {
            controller.error(error);
          }
        },
      },
      { highWaterMark: 0 },
    );
  }

  /** Stops the source (an error path: nothing more will be sent). */
  async cancel(reason: unknown): Promise<void> {
    this.#attempt++;
    this.#recorded = [];
    await this.#reader.cancel(reason).catch(() => {});
  }
}

async function scanOn(
  stub: ScannerStub,
  body: ReadableStream<Uint8Array> | Uint8Array,
  size: number,
  timeoutMs: number,
): Promise<ShimVerdict> {
  const call = (async () => {
    let response: Response;
    try {
      response = await stub.fetch("http://scanner/scan", {
        method: "POST",
        headers: { "X-Scan-Size": String(size), "Content-Type": "application/octet-stream" },
        body,
      });
    } catch (error) {
      // e.g. "Durable Object reset because its code was updated." on every deploy (S9): retryable.
      throw new ScannerTransportError("engine", "scanner call failed", { cause: error });
    }
    return verdictOf(response);
  })();
  // Once the deadline has passed, the call's own outcome no longer matters.
  call.catch(() => {});
  return withDeadline(call, timeoutMs, () => {
    if (body instanceof ReadableStream) body.cancel("scan timed out").catch(() => {});
  });
}

/**
 * Scans one object, streaming `body` (exactly `size` bytes) into the container. Tries the key's
 * preferred instance, and the other one once if the first is busy. Throws `RangeError` above
 * `SCAN_MAX_BYTES` (no container call), `ScannerBusyError`, `ScannerNotReadyError` or
 * `ScannerTransportError`. At most two container calls; never retries otherwise.
 */
export async function scanObject(
  env: ScannerEnv,
  object: { key: string; size: number; body: ReadableStream<Uint8Array> },
  deps?: ScannerDeps,
): Promise<ShimVerdict> {
  const { key, size } = object;
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`invalid scan size ${size}`);
  if (size > SCAN_MAX_BYTES) throw new RangeError(`object of ${size} bytes is above SCAN_MAX_BYTES`);
  const stub = stubFor(env, deps);
  const timeoutMs = deps?.timeoutMs ?? SCAN_TIMEOUT_MS;
  const replay = new ReplayableBody(object.body, deps?.replayMaxBytes ?? REPLAY_MAX_BYTES);
  const first = preferredInstance(key);
  try {
    try {
      return await scanOn(stub(first), replay.next(), size, timeoutMs);
    } catch (error) {
      if (!(error instanceof ScannerBusyError) || !replay.replayable) throw error;
    }
    return await scanOn(stub(otherInstance(first)), replay.next(), size, timeoutMs);
  } catch (error) {
    await replay.cancel(error);
    throw error;
  }
}

/**
 * Scans a buffer of at most `SMALL_SCAN_BYTES` (avatars and other small files). `scanner-0` first
 * — the instance most likely awake, so a small scan rarely wakes a second one — then `scanner-1`
 * once on busy. Same errors as `scanObject`.
 */
export async function scanSmall(
  env: ScannerEnv,
  bytes: Uint8Array,
  deps?: ScannerDeps,
): Promise<ShimVerdict> {
  if (bytes.byteLength > SMALL_SCAN_BYTES) {
    throw new RangeError(`buffer of ${bytes.byteLength} bytes is above SMALL_SCAN_BYTES`);
  }
  const stub = stubFor(env, deps);
  const timeoutMs = deps?.timeoutMs ?? SCAN_TIMEOUT_MS;
  const [first, second] = SCANNER_INSTANCES;
  try {
    return await scanOn(stub(first), bytes, bytes.byteLength, timeoutMs);
  } catch (error) {
    if (!(error instanceof ScannerBusyError)) throw error;
  }
  return scanOn(stub(second), bytes, bytes.byteLength, timeoutMs);
}

/**
 * One instance's `/health`, on demand only (5 s). Note: asking a sleeping instance starts it.
 * Throws `RangeError` for a name that is not one of `SCANNER_INSTANCES` (a third name would take
 * a container of its own), `ScannerBusyError` when no instance can be started, and
 * `ScannerTransportError` otherwise.
 */
export async function scannerHealth(
  env: ScannerEnv,
  name: string,
  deps?: ScannerDeps,
): Promise<ScannerHealth> {
  if (!(SCANNER_INSTANCES as readonly string[]).includes(name))
    throw new RangeError(`unknown scanner instance ${name}`);
  const stub = stubFor(env, deps)(name as ScannerInstance);
  const call = (async () => {
    let response: Response;
    try {
      response = await stub.fetch("http://scanner/health");
    } catch (error) {
      throw new ScannerTransportError("engine", "scanner health call failed", { cause: error });
    }
    const text = await response.text().catch(() => "");
    if (response.status === 500 && text.startsWith(MAX_INSTANCES_BODY)) {
      throw new ScannerBusyError(CAPACITY_RETRY_SECONDS, "no scanner instance could be started");
    }
    if (response.status !== 200)
      throw new ScannerTransportError("engine", `scanner health answered ${response.status}`);
    try {
      return JSON.parse(text) as ScannerHealth;
    } catch (error) {
      throw new ScannerTransportError("engine", "scanner health is not JSON", { cause: error });
    }
  })();
  call.catch(() => {});
  return withDeadline(call, deps?.timeoutMs ?? HEALTH_TIMEOUT_MS, () => {});
}
