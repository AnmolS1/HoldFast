// Route coverage, the Vitest half, INSIDE the test (a setup file of the Workers config): a hit is
// recorded when a ROUTE'S HANDLER runs — the last handler of every route any Hono app registers
// (`get`/`post`/…/`all`/`on`) is wrapped as it is registered, when the Worker's own code
// (src/worker/**) registers it — a test's probe router never counts. A request a middleware answers
// first (the pipeline's 401/403/429, a CSRF refusal, the impersonation guard) runs no handler and
// covers nothing (review M2). The list is put on the test's `meta`, which Vitest carries to the
// reporter in the main process (./vitest-reporter.ts writes the hit file).
//
// Registered by scripts/route-coverage/vitest.workers.config.ts (the main config gets it by the
// orchestrator's seam edit). It wraps `Hono`, a library — this file imports no application code
// (a setup module that did would bind the app's modules before a test's own `vi.mock`).
import { afterAll, afterEach, expect, vi } from "vitest";
import type { RouteHandler } from "./handler-hit";
import type { Hit } from "./routes";

declare module "vitest" {
  interface TaskMeta {
    routeHits?: Hit[];
  }
}

type Bucket = { hits: Hit[] };
const KEY = "__holdfastRouteHits";
const bucket = ((globalThis as unknown as Record<string, Bucket>)[KEY] ??= { hits: [] });

vi.mock("hono", async (importOriginal) => {
  const hono = await importOriginal<typeof import("hono")>();
  const shared = (globalThis as unknown as Record<string, Bucket>)["__holdfastRouteHits"]!;
  const { wrapRouteHandler } = await import("./handler-hit");
  const testFile = () =>
    String(expect.getState().testPath ?? "").replace(/^.*\/tests\/unit\//, "tests/unit/");
  /** The route's own handler (the LAST one given), wrapped: a hit is recorded when it runs. */
  const wrapLast = (args: unknown[]): unknown[] => {
    const index = args.findLastIndex((arg) => typeof arg === "function");
    if (index === -1) return args;
    const wrapped = wrapRouteHandler(args[index] as RouteHandler, (hit) => shared.hits.push(hit), testFile);
    return [...args.slice(0, index), wrapped, ...args.slice(index + 1)];
  };
  /**
   * Was this route registered by the Worker's own code (src/worker/**)? A test's own probe router
   * (`router.all("/*", …)` in pipeline.test.ts) answers every path, and its handler running is not
   * the route's (review D1). The caller is the first frame outside this file and Hono.
   */
  const registeredByWorker = (): boolean => {
    const frames = (new Error().stack ?? "").split("\n").slice(1);
    const caller = frames.find((frame) => !/vitest-hits|\/hono\//.test(frame));
    return caller !== undefined && /\/src\/worker\//.test(caller);
  };
  class Hono<E extends import("hono").Env = import("hono").Env> extends hono.Hono<E> {
    constructor(...args: ConstructorParameters<typeof hono.Hono<E>>) {
      super(...args);
      // Class fields of the base (hono-base.js): replaced on the instance, `use` left alone.
      const self = this as unknown as Record<string, (...given: unknown[]) => unknown>;
      for (const method of ["get", "post", "put", "delete", "options", "patch", "all"]) {
        const register = self[method]!;
        self[method] = (...given: unknown[]) => register(...(registeredByWorker() ? wrapLast(given) : given));
      }
      const on = self.on!;
      self.on = (method: unknown, path: unknown, ...handlers: unknown[]) =>
        on(method, path, ...(registeredByWorker() ? wrapLast(handlers) : handlers));
    }
  }
  return { ...hono, Hono };
});

afterEach(({ task }) => {
  task.meta.routeHits = bucket.hits.splice(0);
});

// Requests made in a file's own beforeAll / afterAll.
// eslint-disable-next-line no-empty-pattern -- Vitest requires the destructuring pattern.
afterAll(({}, suite) => {
  suite.meta.routeHits = bucket.hits.splice(0);
});
