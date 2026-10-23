// The ribbon's "N files are still being checked" (prod demo, 2026-10-23): a folder upload's ribbon
// stayed on it until a reload although every file had its verdict within 2 min 38 s (a cold
// scanner). The ribbon follows a file until its verdict — time the tab was hidden or the frame
// was gone does not count against the bound — and, past the bound, the row can be asked about
// again; a verdict the explorer's listing learns reaches the ribbon's row too.
import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { addFiles, scanVerdictsSeen } from "../../../../src/client/features/upload/manager";
import { SCAN_FOLLOW_LIMIT_MS } from "../../../../src/client/features/upload/plan";
import { getUploads } from "../../../../src/client/features/upload/store";
import { summarise } from "../../../../src/client/features/upload/summary";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { purgeUserState } from "../../../../src/client/lib/query";
import { renderShell, setupShell } from "../shell/helpers";
import { nodeDetail, nodeDto } from "./fixtures";
import {
  FAKED_TIMERS,
  freshUploader,
  installServer,
  json,
  keepResumeListInMemory,
  settle,
  smallFile,
  type Server,
} from "./helpers";

setupShell();

let server: Server;
/** The fake clock's time at which each node's verdict exists on the server; absent: never. */
let verdictAt: Map<string, number>;
let verdict: NodeDto["scanStatus"];
/** Node requests on their way right now, and the most at once. */
let asking = 0;
let peak = 0;

beforeEach(async () => {
  await freshUploader();
  server = installServer();
  server.scanStatus = "pending";
  verdictAt = new Map();
  verdict = "clean";
  asking = 0;
  peak = 0;
  // A verdict per node, at its own time: the scanner answers each file when it is done with it.
  server.onJson = (call) => {
    const node = /^\/api\/nodes\/([^/]+)$/.exec(call.path);
    if (call.method !== "GET" || !node) return undefined;
    asking += 1;
    peak = Math.max(peak, asking);
    const at = verdictAt.get(node[1]!);
    const status = at !== undefined && Date.now() >= at ? verdict : "pending";
    return Promise.resolve().then(() => {
      asking -= 1;
      return json(nodeDetail({ id: node[1]!, scanStatus: status }));
    });
  };
  vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
});

const items = () => getUploads().items;
const polls = () => server.count("GET", /^\/api\/nodes\//);
const ribbon = () => summarise(getUploads());
const hide = (hidden: boolean) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(hidden ? "hidden" : "visible");
  document.dispatchEvent(new Event("visibilitychange"));
};

/** `count` files landed and waiting for the scanner; their verdicts come `after` ms from now. */
async function land(count: number, after?: number): Promise<string[]> {
  await addFiles(
    Array.from({ length: count }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
    null,
  );
  for (let turn = 0; turn < count + 50 && items().some((row) => row.state !== "scanning"); turn += 1) {
    await settle(0);
  }
  expect(items().filter((row) => row.state === "scanning").length).toBe(count);
  const ids = items().map((row) => row.nodeId!);
  if (after !== undefined) for (const id of ids) verdictAt.set(id, Date.now() + after);
  return ids;
}

describe("the ribbon follows the scan to its verdict", () => {
  it("a cold scanner: verdicts after 2 min 38 s clear the ribbon", async () => {
    await land(5, 158_000);
    await settle(150_000);
    expect(ribbon()?.sentence).toBe("Scanning 5 files");
    await settle(40_000);
    expect(items()).toEqual([]);
    expect(ribbon()).toMatchObject({ sentence: "5 uploads complete", status: "done" });
  });

  it("a verdict after 10 minutes in a tab that stays in front still clears the ribbon", async () => {
    await land(5, 10 * 60_000);
    await settle(9 * 60_000);
    expect(ribbon()?.sentence).toBe("Scanning 5 files");
    await settle(2 * 60_000);
    expect(items()).toEqual([]);
  });

  it("the tab hidden for six minutes: nothing is asked meanwhile, and the files are asked about again when it is back — not given up unasked", async () => {
    await land(5, 158_000);
    await settle(30_000);
    hide(true);
    const before = polls();
    await settle(6 * 60_000);
    expect(polls()).toBe(before);
    hide(false);
    await settle(10_000);
    expect(polls()).toBeGreaterThan(before);
    expect(items()).toEqual([]);
  });

  it("time hidden does not count against the bound: hidden for an hour, the file is followed for its whole bound after", async () => {
    await land(1);
    await settle(10_000);
    hide(true);
    await settle(60 * 60_000);
    hide(false);
    await settle(SCAN_FOLLOW_LIMIT_MS - 30_000);
    expect(items()[0]).toMatchObject({ state: "scanning" });
    await settle(60_000);
    expect(items()[0]).toMatchObject({ state: "done", scanStatus: "pending" });
  });

  it("the frame gone for ten minutes does not count against the bound either", async () => {
    const { frameMounted } = await import("../../../../src/client/features/upload/manager");
    await land(1);
    await settle(10_000);
    frameMounted(false);
    const before = polls();
    await settle(10 * 60_000);
    expect(polls()).toBe(before);
    frameMounted(true);
    await settle(SCAN_FOLLOW_LIMIT_MS - 30_000);
    expect(items()[0]).toMatchObject({ state: "scanning" });
  });

  it("one waiting file costs a few requests a minute once it has waited a while: backs off to one ask every 30 s", async () => {
    await land(1);
    await settle(3 * 60_000);
    const before = polls();
    await settle(5 * 60_000);
    expect(polls() - before).toBeLessThanOrEqual(11);
    expect(polls() - before).toBeGreaterThanOrEqual(9);
  });

  it("100 files waiting: one request at a time, at most one a second, for the whole bound — then nothing more", async () => {
    keepResumeListInMemory();
    await land(100);
    await settle(SCAN_FOLLOW_LIMIT_MS + 60_000);
    expect(peak).toBe(1);
    expect(polls()).toBeLessThanOrEqual((SCAN_FOLLOW_LIMIT_MS + 60_000) / 1_000 + 1);
    expect(items().every((row) => row.state === "done" && row.scanStatus === "pending")).toBe(true);
    expect(ribbon()?.sentence).toBe("100 files are still being checked");
    const asked = polls();
    await settle(30 * 60_000);
    expect(polls()).toBe(asked);
  });
});

describe("past the bound", () => {
  it("a row still being checked can be checked again from the panel; its verdict then clears the ribbon", async () => {
    const [id] = await land(1);
    await settle(SCAN_FOLLOW_LIMIT_MS + 60_000);
    expect(items()[0]).toMatchObject({ state: "done", scanStatus: "pending" });
    verdictAt.set(id!, Date.now());
    const asked = polls();
    renderShell(<UploadPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check f0.txt again" }));
      await settle(1_000);
    });
    expect(polls()).toBe(asked + 1);
    expect(items()).toEqual([]);
    expect(ribbon()).toMatchObject({ sentence: "1 upload complete", status: "done" });
  });
});

describe("one source of truth: a verdict the listing learns", () => {
  const seen = (id: string, scanStatus: NodeDto["scanStatus"]) => nodeDto({ id, scanStatus });

  it("settles a row still scanning, and the loop asks about it no more", async () => {
    const [first, second] = await land(2);
    scanVerdictsSeen([seen(first!, "clean"), seen(second!, "pending")]);
    // (A clean row leaves the list once nothing is on its way any more.)
    expect(items().map((row) => [row.nodeId, row.state, row.scanStatus])).toEqual([
      [first, "done", "clean"],
      [second, "scanning", null],
    ]);
    const asked = () => server.count("GET", new RegExp(`^/api/nodes/${first}$`));
    const before = asked();
    await settle(60_000);
    expect(asked()).toBe(before);
  });

  it("settles a row the bound gave up on: blocked stays on the ribbon as blocked, clean clears it", async () => {
    const [first, second] = await land(2);
    await settle(SCAN_FOLLOW_LIMIT_MS + 60_000);
    expect(ribbon()?.sentence).toBe("2 files are still being checked");
    scanVerdictsSeen([seen(first!, "infected")]);
    expect(items().find((row) => row.nodeId === first)).toMatchObject({
      state: "done",
      scanStatus: "infected",
    });
    scanVerdictsSeen([seen(second!, "clean")]);
    expect(items().map((row) => row.nodeId)).toEqual([first]);
    expect(ribbon()?.sentence).not.toMatch(/still being checked/);
  });

  it("after the account changed, a verdict from the old listing touches nothing", async () => {
    const [first] = await land(1);
    await purgeUserState({ keepSession: true });
    await settle(0);
    expect(items()).toEqual([]);
    expect(() => scanVerdictsSeen([seen(first!, "clean")])).not.toThrow();
    expect(items()).toEqual([]);
    expect(ribbon()).toBeNull();
  });
});
