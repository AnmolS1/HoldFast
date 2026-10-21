// Route coverage, the e2e half: every request a test makes that the Worker answers, appended to
// coverage/routes-hit.e2e.jsonl (scripts/route-coverage/ — the diff matches them to routes).
//
// OFF unless HOLDFAST_ROUTE_COVERAGE=1: then the `page` of every test (its whole context — popups
// too), the `request` fixture, `page.request` and every `playwright.request.newContext()` are
// watched. Nothing is changed on the way: a request is recorded after its answer arrived.
//
// Only answers the Worker wrote count — a spec's `route.fulfill` mock is not a hit on the route it
// imitates (`answeredByWorker`). The file is emptied once per run by playwright.config.ts.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { APIRequestContext, APIResponse, BrowserContext, Response } from "@playwright/test";
import { answeredByWorker, COVERAGE_DIR, hitLine, type Host } from "../../../scripts/route-coverage/routes";

export const ROUTE_COVERAGE = process.env.HOLDFAST_ROUTE_COVERAGE === "1";
export const E2E_HITS_FILE = `${COVERAGE_DIR}/routes-hit.e2e.jsonl`;
/** Set by the Worker, in test mode only, from inside a route's handler (SEAM): `<METHOD> <route path>`. */
export const ROUTE_HANDLED_HEADER = "x-holdfast-test-route";

/** Once per run, in the process that starts the run: an empty hit file. */
export function startHitFile(): void {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  writeFileSync(E2E_HITS_FILE, "");
}

export interface CoverageOrigins {
  app: string;
  files: string;
}

function hostOf(url: URL, origins: CoverageOrigins): Host | null {
  if (url.origin === origins.app) return "app";
  if (url.origin === origins.files) return "files";
  return null;
}

/** Appends one hit for an answer; anything not from this checkout's Worker is left out. */
export function recordHit(
  origins: CoverageOrigins,
  method: string,
  answer: { url: string; status: number; headers: Record<string, string> },
): void {
  const url = new URL(answer.url);
  const host = hostOf(url, origins);
  if (host === null || !answeredByWorker(answer.headers)) return;
  appendFileSync(
    E2E_HITS_FILE,
    hitLine({
      source: "e2e",
      host,
      method: method.toUpperCase(),
      path: url.pathname,
      status: answer.status,
      // The route's own handler ran: the Worker says so on the answer, in test mode only (the SEAM
      // in reports/T28-report.md). Until it does, no e2e answer counts (review M2).
      handler: answer.headers[ROUTE_HANDLED_HEADER] !== undefined,
    }),
  );
}

const watchedContexts = new WeakSet<BrowserContext>();

/** Every response the context's pages receive (once per context, however often it is asked). */
export function watchContext(context: BrowserContext, origins: CoverageOrigins): void {
  if (watchedContexts.has(context)) return;
  watchedContexts.add(context);
  context.on("response", (response: Response) => {
    recordHit(origins, response.request().method(), {
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
    });
  });
}

const watched = new WeakSet<APIRequestContext>();

/** Every answer of an API request context (`get`, `post`, … all go through its `fetch`). */
export function watchRequests(api: APIRequestContext, origins: CoverageOrigins): void {
  if (watched.has(api)) return;
  watched.add(api);
  const fetch = api.fetch.bind(api);
  api.fetch = async (...args: Parameters<APIRequestContext["fetch"]>): Promise<APIResponse> => {
    const [target, options] = args;
    const response = await fetch(...args);
    const method = options?.method ?? (typeof target === "string" ? "GET" : target.method());
    recordHit(origins, method, {
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
    });
    return response;
  };
}
