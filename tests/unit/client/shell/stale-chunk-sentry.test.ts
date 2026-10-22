// A chunk-load failure the stale-chunk handler RECOVERS from (it reloads, or asks to) is not an
// error report; one it does NOT recover from (the entry was already reloaded within the window) is.
// The real `@sentry/react` with the app's options and a transport that records instead of sending;
// the failure travels as Vite's does (`vite:preloadError` with the error as `payload`, then the
// same error thrown on to the error boundary, which reports it).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publish } from "../../../../src/client/components/TransferRibbon";
import { reportError, initSentry, resetSentryForTests } from "../../../../src/client/lib/sentry";
import { installStaleChunkReload, RELOAD_WINDOW_MS } from "../../../../src/client/lib/stale-chunk";
import { setupShell } from "./helpers";

setupShell();

const sent: string[] = [];
const realFetch = globalThis.fetch;
let client: { flush(timeout: number): PromiseLike<boolean>; close(timeout: number): PromiseLike<boolean> };

let now = 0;
let reloads = 0;
let uninstall: () => void = () => {};

/** What Vite's preload helper does with a chunk it cannot fetch, then what the error boundary does. */
function chunkFails(name: string): void {
  const error = new TypeError(`Failed to fetch dynamically imported module: /assets/${name}-x1y2z3.js`);
  const event = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
  event.payload = error;
  window.dispatchEvent(event);
  if (!event.defaultPrevented) reportError(error, { componentStack: "\n    at LazyRoutePage" });
}

/** The error events that left the browser (session envelopes and the like are not counted). */
async function errorEvents(): Promise<string[]> {
  await client.flush(2000);
  return sent.filter((body) => /"type":"event"/.test(body));
}

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  resetSentryForTests();
  const real = await import("@sentry/react");
  const transport = () =>
    real.createTransport({ recordDroppedEvent: () => {} }, async (request) => {
      sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
      return { statusCode: 200 };
    });
  const started = await initSentry(
    {
      sentryDsnWeb: "https://public@o0.ingest.sentry.example.test/1",
      sentryEnvironment: "test",
      release: "abc",
    }, // made up
    async () =>
      ({
        ...real,
        init: (options: Record<string, unknown>) =>
          real.init({ ...options, transport } as Parameters<typeof real.init>[0]),
      }) as typeof real,
  );
  expect(started).toBe(true);
  client = real.getClient()!;
});

afterAll(async () => {
  await client.close(100);
  resetSentryForTests();
  vi.stubGlobal("fetch", realFetch);
});

beforeEach(() => {
  sent.length = 0;
  now = 1_000_000;
  reloads = 0;
  window.history.replaceState({ usr: null, key: "default", idx: 0 }, "", "/trash");
  uninstall = installStaleChunkReload({
    now: () => now,
    reload: () => {
      reloads += 1;
    },
  });
});

afterEach(() => uninstall());

describe("chunk-load failures and error reports", () => {
  it("a failure the handler recovers from by reloading sends no error event", async () => {
    chunkFails("TrashPage");
    expect(reloads).toBe(1);
    expect(await errorEvents()).toEqual([]);
  });

  it("a failure it recovers from with the reload prompt (an upload open) sends no error event", async () => {
    publish("upload", { progress: 0.5, sentence: "Uploading 1 of 2", status: "active" });
    chunkFails("TrashPage");
    expect(reloads).toBe(0);
    expect(await errorEvents()).toEqual([]);
  });

  it("the loop-guarded second failure (no reload) IS reported, once", async () => {
    chunkFails("TrashPage");
    now += RELOAD_WINDOW_MS - 1;
    chunkFails("RecentPage");
    expect(reloads).toBe(1);
    const events = await errorEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("RecentPage");
    expect(events[0]).not.toContain("TrashPage");
  });

  it("a failure when the entry cannot be stamped (no reload) IS reported", async () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("too many calls", "SecurityError");
    });
    chunkFails("TrashPage");
    vi.mocked(window.history.replaceState).mockRestore();
    expect(reloads).toBe(0);
    expect(await errorEvents()).toHaveLength(1);
  });

  it("any other error is still reported (only the recovered chunk error is dropped)", async () => {
    chunkFails("TrashPage");
    reportError(new TypeError("Failed to fetch dynamically imported module: /assets/TrashPage-x1y2z3.js"));
    expect(await errorEvents()).toHaveLength(1);
  });
});
