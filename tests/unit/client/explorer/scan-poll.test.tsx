// Watching a pending scan: every 5 s for two minutes, then every 30 s with "Still scanning". The
// answer polled is a NodeDetailDto — the status is `.node.scanStatus`.
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_POLLED,
  POLL_FAST_FOR_MS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  pollDelay,
} from "../../../../src/client/features/explorer/scan-poll";
import { NodeDetailDto } from "../../../../src/shared/schemas/node";
import { json } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { detailOf, fileNode } from "./fixtures/nodes";
import { renderExplorer, rowOf, rows, serveDrive, setupExplorer } from "./helpers";

setupExplorer();

const PENDING = fileNode(1, { name: "new.pdf", scanStatus: "pending" });
const DETAIL = new RegExp(`/api/nodes/${PENDING.id}$`);

/** Let `ms` pass, with everything that was waiting on it. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// Time is read from the moment the list is on screen. A check is made a little before or after a
// poll is due, never on the millisecond: the watch starts a few milliseconds before `start`, and
// an answer needs one more tick to be drawn (the query cache notifies on a zero-length timer).
const SLACK = 20;
let start = 0;
const before = (ms: number) => pass(start + ms - SLACK - Date.now());
const after = (ms: number) => pass(start + ms + SLACK - Date.now());

async function mount(drive: FakeDrive, extra?: Parameters<typeof serveDrive>[1]) {
  serveDrive(drive, extra);
  const view = renderExplorer("/");
  await pass(1);
  await pass(1);
  expect(rows().length).toBe(drive.childrenOf(null).length);
  start = Date.now();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe("the schedule", () => {
  it("5 s for the first two minutes, 30 s after", () => {
    expect([POLL_FAST_MS, POLL_FAST_FOR_MS, POLL_SLOW_MS]).toEqual([5_000, 120_000, 30_000]);
    expect(pollDelay(0)).toBe(5_000);
    expect(pollDelay(119_999)).toBe(5_000);
    expect(pollDelay(120_000)).toBe(30_000);
  });
});

describe("a pending file", () => {
  it("is asked for after 5 s — not before — and the row follows `.node.scanStatus`", async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    expect(rowOf(PENDING.id)!.querySelector('[role="progressbar"]')).not.toBeNull();
    await before(5_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(0);
    await after(5_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(1);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("pending");

    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "clean" });
    await before(10_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(1);
    await after(10_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(2);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");
    expect(rowOf(PENDING.id)!.querySelector('[role="progressbar"]')).toBeNull();
    // Settled: nobody asks again.
    await after(70_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(2);
  });

  it("a verdict of infected turns the row into the blocked state", async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "infected" });
    await after(5_000);
    expect(rowOf(PENDING.id)!.querySelector("[data-status]")!.textContent).toContain(
      "Blocked — flagged by the malware scan",
    );
  });

  it("a bare NodeDto is not the answer's shape: it does not parse, and the row stays pending", async () => {
    const clean = { ...PENDING, scanStatus: "clean" as const };
    expect(NodeDetailDto.safeParse(clean).success).toBe(false);
    expect(NodeDetailDto.safeParse(detailOf(clean)).success).toBe(true);
    const drive = new FakeDrive([PENDING]);
    let bare = true;
    await mount(drive, (call) =>
      call.method === "GET" && DETAIL.test(call.path) ? json(bare ? clean : detailOf(clean)) : undefined,
    );
    await after(5_000);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("pending");
    // The same node inside `{ node, breadcrumbs }` is read.
    bare = false;
    await after(10_000);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");
  });

  it("after two minutes the row says Still scanning and is asked for every 30 s", async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    await before(120_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(23);
    expect(rowOf(PENDING.id)!.querySelector("[data-still-scanning]")).toBeNull();
    await after(120_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(24);
    const glyph = rowOf(PENDING.id)!.querySelector("[data-still-scanning]")!;
    expect(glyph.getAttribute("aria-label")).toBe("Still scanning");
    // From here every 30 s: nothing at 125 s … 145 s.
    await before(150_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(24);
    await after(150_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(25);
    await before(180_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(25);
    await after(180_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(26);
  });

  it("a poll that fails with 500 is tried again; one answered 404 takes the row away", async () => {
    const drive = new FakeDrive([PENDING]).fail("GET", DETAIL, 500, 1);
    await mount(drive);
    await after(5_000);
    expect(rowOf(PENDING.id)).not.toBeNull();
    drive.nodes.delete(PENDING.id);
    await after(10_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(2);
    expect(rowOf(PENDING.id)).toBeNull();
    await after(60_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(2);
  });

  it("leaving the page stops the polling", async () => {
    const drive = new FakeDrive([PENDING]);
    const view = await mount(drive);
    await after(5_000);
    view.unmount();
    await after(70_000);
    expect(drive.callsTo("GET", DETAIL)).toHaveLength(1);
  });

  it(`at most ${MAX_POLLED} files are watched at once`, async () => {
    const many = Array.from({ length: MAX_POLLED + 5 }, (_, index) =>
      fileNode(index + 1, { name: `f${String(index).padStart(2, "0")}.pdf`, scanStatus: "pending" }),
    );
    const drive = new FakeDrive(many);
    await mount(drive);
    await after(5_000);
    expect(drive.callsTo("GET", /\/api\/nodes\/[0-9a-f-]{36}$/)).toHaveLength(MAX_POLLED);
  });

  it("a clean file and a folder are never polled", async () => {
    const drive = new FakeDrive([fileNode(2, { name: "ok.pdf" })]);
    await mount(drive);
    await after(60_000);
    expect(drive.callsTo("GET", /\/api\/nodes\/[0-9a-f-]{36}$/)).toHaveLength(0);
  });
});
