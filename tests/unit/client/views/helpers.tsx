// Helpers of the views' jsdom tests. The API is stubbed per test: `openView` renders the REAL
// route tree (frame, sidebar, page) over a fetch router answering what the test names.
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { clearWaits } from "../../../../src/client/features/starred/waits";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { buildRoutes } from "../../../../src/client/router";
import { DESKTOP_MIN } from "../../../../src/client/theme/breakpoints";
import {
  envelope,
  json,
  renderRoutes,
  sessionOf,
  setViewport,
  shellFetch,
  type MockCall,
  type MockHandler,
} from "../shell/helpers";
import { USAGE } from "./fixtures";

export { envelope, json };

/** `"GET /api/trash"` → an answer, or a function of the call. The query string is not part of the key. */
export type AnswerFn = (call: MockCall) => Response | Promise<Response | undefined> | undefined;
export type Answers = Record<string, object | AnswerFn>;

export const pathOf = (call: MockCall): string => call.path.split("?")[0]!;
export const queryOf = (call: MockCall): URLSearchParams =>
  new URLSearchParams(call.path.split("?")[1] ?? "");

export function answering(answers: Answers): MockHandler {
  return (call) => {
    const answer = answers[`${call.method} ${pathOf(call)}`];
    if (answer === undefined) return undefined;
    if (typeof answer === "function") return (answer as AnswerFn)(call) as ReturnType<MockHandler>;
    return answer instanceof Response ? answer.clone() : json(answer);
  };
}

export interface OpenOptions {
  width?: number;
  timezone?: string;
}

/** Open a path of the app, signed in. Unnamed `/api/*` requests get the 404 envelope. */
export async function openView(path: string, answers: Answers = {}, options: OpenOptions = {}) {
  // A wait the API named during the previous test (a page still mounted at its purge may have
  // read once more) is not this test's.
  clearWaits();
  const width = options.width ?? 1280;
  setViewport(width, { coarse: width < DESKTOP_MIN });
  const calls = shellFetch({
    session: sessionOf({ timezone: options.timezone ?? "UTC" }),
    extra: answering({ "GET /api/account/usage": USAGE, ...answers }),
  });
  const view = renderRoutes(buildRoutes(), [path]);
  await waitFor(() => {
    if (!document.querySelector("[data-frame]")) throw new Error("the frame is not up yet");
  });
  return { calls, ...view };
}

export const requests = (calls: MockCall[], method: string, path: string): MockCall[] =>
  calls.filter((call) => call.method === method && pathOf(call) === path);

/** Every `parentIds` the tree-changed event carried during a test, in order. */
export function recordNodesChanged(): Array<(string | null)[]> {
  const seen: Array<(string | null)[]> = [];
  let stop = () => {};
  beforeEach(() => {
    seen.length = 0;
    stop = onNodesChanged((detail) => seen.push(detail.parentIds));
  });
  afterEach(() => stop());
  return seen;
}

/** A promise a test settles by hand. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export const viewError = (view: string) => document.querySelector(`[data-view-error="${view}"]`);
export const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]"));
export const rowNames = () => rows().map((row) => row.getAttribute("data-item-id"));
