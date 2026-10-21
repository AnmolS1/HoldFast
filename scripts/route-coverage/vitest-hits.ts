// Route coverage, the Vitest half, INSIDE the test (a setup file of the Workers config): every
// request a test hands to a Hono app — `app.request(…)`, `app.fetch(…)`, the Worker entry — is
// recorded with its answer, and the list is put on the test's `meta`, which Vitest carries to the
// reporter in the main process (./vitest-reporter.ts writes the hit file).
//
// Registered by scripts/route-coverage/vitest.workers.config.ts (the main config gets it by the
// orchestrator's seam edit). It wraps `Hono`, a library — this file imports no application code
// (a setup module that did would bind the app's modules before a test's own `vi.mock`).
import { afterAll, afterEach, vi } from "vitest";
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
  // Only TOP-LEVEL apps are asked through `fetch`: a router mounted with `app.route()` is copied
  // into its parent, so a request is recorded once.
  class Hono<E extends import("hono").Env = import("hono").Env> extends hono.Hono<E> {
    constructor(...args: ConstructorParameters<typeof hono.Hono<E>>) {
      super(...args);
      const fetch = this.fetch;
      this.fetch = async (request, ...rest) => {
        const response = await fetch(request, ...rest);
        const url = new URL(request.url);
        shared.hits.push({
          source: "vitest",
          // The test origins (tests/setup/test-vars.ts): files.localhost is the files host.
          host: url.hostname.startsWith("files.") ? "files" : url.pathname.startsWith("/api/") ? "app" : null,
          method: request.method.toUpperCase(),
          path: url.pathname,
          status: response.status,
        });
        return response;
      };
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
