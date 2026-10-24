// Watching a pending scan: every 5 s for two minutes, then every 30 s with "Still scanning". Every
// file that is due is asked in ONE request, `GET /api/nodes/scan-status?ids=…` (R1 m16); the answer is
// `{ items }`, each the node as its GET would show it — the status is `.scanStatus`.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  penaltyAfter,
  POLL_BACKOFF_MAX_MS,
  POLL_FAST_FOR_MS,
  POLL_FAST_MS,
  POLL_MAX_MS,
  POLL_PER_TICK,
  POLL_RETRY_AFTER_MAX_MS,
  POLL_SLOW_MS,
  pollDelay,
  useScanPolling,
} from "../../../../src/client/features/explorer/scan-poll";
import { renameNode } from "../../../../src/client/features/explorer/actions";
import { ApiError } from "../../../../src/client/lib/api";
import { emitNodesChanged } from "../../../../src/client/lib/contracts";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import { ScanStatusResponse } from "../../../../src/shared/schemas/node";
import { envelope, json } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode } from "./fixtures/nodes";
import { renderExplorer, rowOf, rows, serveDrive, setupExplorer } from "./helpers";

setupExplorer();

const PENDING = fileNode(1, { name: "new.pdf", scanStatus: "pending" });
const SCAN = /\/api\/nodes\/scan-status$/;
/** The same, on a path with its query string. */
const SCAN_PATH = /\/api\/nodes\/scan-status(\?|$)/;
const idsOf = (call: { path: string }) =>
  (new URL(call.path, "http://app.invalid").searchParams.get("ids") ?? "").split(",").filter(Boolean);
/** The scan requests that asked about `id`. */
const asksAbout = (drive: FakeDrive, id: string) =>
  drive.callsTo("GET", SCAN).filter((call) => idsOf(call).includes(id));
/** The same, over every request the stand-in server saw (answered by the drive or not). */
const callsAbout = (calls: Array<{ path: string; body: unknown }>, id: string) =>
  calls.filter((call) => SCAN_PATH.test(call.path) && idsOf(call).includes(id));

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
    expect(asksAbout(drive, PENDING.id)).toHaveLength(0);
    await after(5_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("pending");

    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "clean" });
    await before(10_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
    await after(10_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(2);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");
    expect(rowOf(PENDING.id)!.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelector("[data-explorer-live]")!.textContent).toBe("new.pdf is scanned and ready");
    // Settled: nobody asks again.
    await after(70_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(2);
  });

  it("a verdict of infected turns the row into the blocked state", async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "infected" });
    await after(5_000);
    expect(rowOf(PENDING.id)!.querySelector("[data-status]")!.textContent).toContain(
      "Blocked — flagged by the malware scan",
    );
    // …and the change is said once in the live region.
    expect(document.querySelector("[data-explorer-live]")!.textContent).toBe(
      "new.pdf: Blocked — flagged by the malware scan",
    );
  });

  it("bare NodeDtos are not the answer's shape: they do not parse, and the row stays pending", async () => {
    const clean = { ...PENDING, scanStatus: "clean" as const };
    expect(ScanStatusResponse.safeParse([clean]).success).toBe(false);
    expect(ScanStatusResponse.safeParse({ items: [clean] }).success).toBe(true);
    const drive = new FakeDrive([PENDING]);
    let bare = true;
    await mount(drive, (call) =>
      call.method === "GET" && SCAN_PATH.test(call.path)
        ? json(bare ? [clean] : { items: [clean] })
        : undefined,
    );
    await after(5_000);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("pending");
    // The same node inside `{ items }` is read.
    bare = false;
    await after(10_000);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");
  });

  it("after two minutes the row says Still scanning and is asked for every 30 s", async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    await before(120_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(23);
    expect(rowOf(PENDING.id)!.querySelector("[data-still-scanning]")).toBeNull();
    await after(120_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(24);
    const glyph = rowOf(PENDING.id)!.querySelector("[data-still-scanning]")!;
    expect(glyph.getAttribute("aria-label")).toBe("Still scanning");
    // From here every 30 s: nothing at 125 s … 145 s.
    await before(150_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(24);
    await after(150_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(25);
    await before(180_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(25);
    await after(180_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(26);
  });

  it("a poll that fails with 500 is tried again; a file the answer leaves out (gone) takes the row away", async () => {
    const drive = new FakeDrive([PENDING]).fail("GET", SCAN, 500, 1);
    await mount(drive);
    await after(5_000);
    expect(rowOf(PENDING.id)).not.toBeNull();
    drive.nodes.delete(PENDING.id);
    await after(10_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(2);
    expect(rowOf(PENDING.id)).toBeNull();
    await after(60_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(2);
  });

  it("leaving the page stops the polling", async () => {
    const drive = new FakeDrive([PENDING]);
    const view = await mount(drive);
    await after(5_000);
    view.unmount();
    await after(70_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
  });

  it(`many pending files: one request a tick with all of them (up to ${POLL_PER_TICK}) — never one loop per file`, async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      fileNode(index + 1, { name: `f${String(index).padStart(2, "0")}.pdf`, scanStatus: "pending" }),
    );
    const drive = new FakeDrive(many);
    await mount(drive);
    const requests = () => drive.callsTo("GET", SCAN);
    await after(5_000);
    expect(requests()).toHaveLength(1);
    expect(new Set(idsOf(requests()[0]!))).toEqual(new Set(many.map((node) => node.id)));
    await after(10_000);
    expect(requests()).toHaveLength(2);
    // A whole minute: 12 requests for 30 pending files (48 before, 360 one loop per file).
    await after(60_000);
    expect(requests()).toHaveLength(12);
    expect(requests().every((call) => idsOf(call).length === 30)).toBe(true);
  });

  it("a 100-file folder: at most one request per poll tick, every file in it", async () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      fileNode(index + 1, { name: `g${String(index).padStart(3, "0")}.pdf`, scanStatus: "pending" }),
    );
    const drive = new FakeDrive(many);
    await mount(drive);
    for (let tick = 1; tick <= 6; tick += 1) {
      await after(tick * POLL_FAST_MS);
      expect(drive.callsTo("GET", SCAN)).toHaveLength(tick);
    }
    expect(drive.callsTo("GET", SCAN).every((call) => idsOf(call).length === 100)).toBe(true);
  });

  it("a clean file and a folder are never polled", async () => {
    const drive = new FakeDrive([fileNode(2, { name: "ok.pdf" })]);
    await mount(drive);
    await after(60_000);
    expect(drive.callsTo("GET", SCAN)).toHaveLength(0);
  });

  it("a 403 for the whole request says nothing about any one file: the loop backs off and asks again", async () => {
    const drive = new FakeDrive([PENDING]).fail("GET", SCAN, 403, 1);
    await mount(drive);
    await after(5_000);
    // The refused request reached the drive (and was answered 403 there).
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("pending");
    // Backed off 5 s, then asked again.
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "clean" });
    await after(15_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(2);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");
  });

  it("429 makes the whole loop wait Retry-After — for every file, not only the one refused", async () => {
    const other = fileNode(2, { name: "other.pdf", scanStatus: "pending" });
    const drive = new FakeDrive([PENDING, other]);
    let refuse = true;
    await mount(drive, (call) =>
      refuse && call.method === "GET" && SCAN_PATH.test(call.path)
        ? envelope("rate_limited", 429, undefined, { "retry-after": "40" })
        : undefined,
    );
    await after(5_000);
    // The one request was refused (the drive answered nothing).
    const asked = () => drive.callsTo("GET", SCAN).length;
    expect(asked()).toBe(0);
    refuse = false;
    await before(45_000);
    expect(asked()).toBe(0);
    await after(45_000);
    expect(asked()).toBe(1);
    expect(new Set(idsOf(drive.callsTo("GET", SCAN)[0]!))).toEqual(new Set([PENDING.id, other.id]));
  });

  it("Retry-After is honoured up to a bound, and a 429 without one waits half a minute", () => {
    const refused = (retryAfter?: number) =>
      new ApiError({ status: 429, code: "rate_limited", message: "x", retryAfter });
    expect(penaltyAfter(refused(40), 1)).toBe(40_000);
    expect(penaltyAfter(refused(86_400), 1)).toBe(POLL_RETRY_AFTER_MAX_MS);
    expect(penaltyAfter(refused(), 1)).toBe(30_000);
    expect(penaltyAfter(refused(0), 1)).toBe(POLL_FAST_MS);
  });

  it("a failing server is asked less and less: 5, 10, 20, 40, then every 60 s — and at full rate again once it answers", async () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => penaltyAfter(new Error("down"), n))).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      POLL_BACKOFF_MAX_MS,
      POLL_BACKOFF_MAX_MS,
    ]);
    const drive = new FakeDrive([PENDING]).fail("GET", SCAN, 500);
    await mount(drive);
    const count = () => asksAbout(drive, PENDING.id).length;
    // Questions at 5, 10, 20, 40, 80 s: five in the first 100 s where a fixed rate would send 20.
    for (const [at, expected] of [
      [5_000, 1],
      [10_000, 2],
      [20_000, 3],
      [40_000, 4],
      [80_000, 5],
    ] as const) {
      await before(at);
      expect(count()).toBe(expected - 1);
      await after(at);
      expect(count()).toBe(expected);
    }
    await after(100_000);
    expect(count()).toBe(5);
  });

  it("nothing is asked while the tab is hidden; the watch goes on when it is shown again", async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    await after(5_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await after(60_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
    hidden.mockReturnValue(false);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await pass(50);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(2);
  });

  it(`a file is watched for ${POLL_MAX_MS / 60_000} minutes from the moment it became pending, then no longer asked for`, async () => {
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    await after(POLL_MAX_MS);
    const total = asksAbout(drive, PENDING.id).length;
    // 24 in the first two minutes, then one every 30 s.
    expect(total).toBeLessThanOrEqual(24 + (POLL_MAX_MS - POLL_FAST_FOR_MS) / POLL_SLOW_MS + 1);
    await after(POLL_MAX_MS + 10 * 60_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(total);
    expect(rowOf(PENDING.id)!.querySelector("[data-still-scanning]")).not.toBeNull();
  });

  it("a file that becomes pending 25 minutes into the visit is watched for its own span: it settles at minute 32 and its row follows", async () => {
    // The first file of the visit settles at once; the watch must not end with the visit's clock.
    const LATE = fileNode(2, { name: "later.pdf", scanStatus: "pending" });
    const drive = new FakeDrive([PENDING]);
    await mount(drive);
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "clean" });
    await after(5_000);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");

    await after(25 * 60_000);
    drive.add(LATE);
    act(() => emitNodesChanged([null]));
    await pass(1);
    await pass(1);
    expect(rowOf(LATE.id)!.getAttribute("data-scan")).toBe("pending");
    const asked = asksAbout(drive, LATE.id).length;
    // Past the visit's 30 minutes it is still asked for, at its own pace (30 s after two minutes).
    await after(32 * 60_000);
    expect(asksAbout(drive, LATE.id).length).toBeGreaterThan(asked + 20);
    drive.nodes.set(LATE.id, { ...LATE, scanStatus: "clean" });
    await pass(POLL_SLOW_MS + 100);
    expect(rowOf(LATE.id)!.getAttribute("data-scan")).toBe("clean");
  });

  it("an answer that arrives after the account changed is dropped: no cache write, nothing said", async () => {
    const drive = new FakeDrive([PENDING]);
    let release: (response: Response) => void = () => {};
    await mount(drive, (call) =>
      call.method === "GET" && SCAN_PATH.test(call.path)
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : undefined,
    );
    await after(5_000);
    await act(async () => {
      await purgeUserState();
    });
    await act(async () => release(json({ items: [{ ...PENDING, scanStatus: "clean" }] })));
    await pass(50);
    // (The page is still mounted in this test and has read its listing again — from the drive,
    // where the file is pending. The late answer said "clean": had it been applied, a row would be.)
    const cached = JSON.stringify(queryClient.getQueriesData({ queryKey: ["explorer"] }));
    expect(cached).not.toContain('"scanStatus":"clean"');
    expect(rowOf(PENDING.id)?.getAttribute("data-scan") ?? "pending").toBe("pending");
    expect(document.querySelector("[data-explorer-live]")?.textContent ?? "").toBe("");
  });

  it("the watch itself checks the account: a hook still mounted with the same ids drops a late answer", async () => {
    // The page above stops its watch when its list empties; this is the hook alone, whose ids do
    // not change across the purge — only the account check can stop the answer.
    let release: (response: Response) => void = () => {};
    const calls = serveDrive(new FakeDrive([PENDING]), (call) =>
      SCAN_PATH.test(call.path)
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : undefined,
    );
    const onSettled = vi.fn();
    const onGone = vi.fn();
    renderHook(() => useScanPolling([PENDING.id], { onSettled, onGone }));
    await pass(POLL_FAST_MS + 10);
    await act(async () => {
      await purgeUserState();
    });
    await act(async () => release(json({ items: [{ ...PENDING, scanStatus: "clean" }] })));
    await pass(50);
    expect(onSettled).not.toHaveBeenCalled();
    // …and it asks nothing more for the account that is gone.
    expect(calls).toHaveLength(1);
    await pass(60_000);
    expect(calls).toHaveLength(1);
  });
});

// Review round 3 (M8): a file's 30 minutes count only time the loop could ask — not a hidden tab,
// not a page covered by a preview. When they do run out, the row says "Still scanning".
describe("M8 — the watch counts only time the loop could ask", () => {
  function watch(initial: { active: boolean }) {
    const calls = serveDrive(new FakeDrive([PENDING]));
    const handlers = { onSettled: vi.fn(), onGone: vi.fn() };
    const view = renderHook(({ active }) => useScanPolling([PENDING.id], handlers, active), {
      initialProps: initial,
    });
    const asked = () => callsAbout(calls, PENDING.id).length;
    return { view, asked };
  }

  it("pending while the page is covered for longer than the watch, then in front: asked within 5 s", async () => {
    const { view, asked } = watch({ active: false });
    await pass(POLL_MAX_MS + 60_000);
    expect(asked()).toBe(0);
    view.rerender({ active: true });
    await pass(POLL_FAST_MS + 50);
    expect(asked()).toBe(1);
    // The fast pace, as for a file just seen: twelve a minute.
    await pass(60_000);
    expect(asked()).toBe(13);
  });

  it("pending while the tab is hidden for 31 minutes, then shown: asked, not dropped", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { asked } = watch({ active: true });
    await pass(31 * 60_000);
    expect(asked()).toBe(0);
    hidden.mockReturnValue(false);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await pass(POLL_FAST_MS + 50);
    expect(asked()).toBeGreaterThanOrEqual(1);
  });

  it("20 active minutes, an hour covered, then more: asked until 30 ACTIVE minutes, then no more — and marked Still scanning", async () => {
    const { view, asked } = watch({ active: true });
    await pass(20 * 60_000);
    const before = asked();
    view.rerender({ active: false });
    await pass(60 * 60_000);
    expect(asked()).toBe(before);
    view.rerender({ active: true });
    // Ten more active minutes are left: one question every 30 s.
    await pass(9 * 60_000);
    expect(asked()).toBeGreaterThanOrEqual(before + 17);
    await pass(2 * 60_000);
    const total = asked();
    await pass(30 * 60_000);
    expect(asked()).toBe(total);
    expect(view.result.current.has(PENDING.id)).toBe(true);
  });
});

// Review round 4.
describe("m28 — a file first listed during a pause starts its watch when the pause ends", () => {
  it("A pending and covered; B listed 10 minutes into the pause; back in front 30 minutes later: B asked within 5 s", async () => {
    const LATE = fileNode(2, { name: "later.pdf", scanStatus: "pending" });
    const calls = serveDrive(new FakeDrive([PENDING, LATE]));
    const handlers = { onSettled: vi.fn(), onGone: vi.fn() };
    const view = renderHook(({ ids, active }) => useScanPolling(ids, handlers, active), {
      initialProps: { ids: [PENDING.id], active: false },
    });
    await pass(10 * 60_000);
    view.rerender({ ids: [PENDING.id, LATE.id], active: false });
    await pass(30 * 60_000);
    expect(callsAbout(calls, LATE.id)).toHaveLength(0);
    view.rerender({ ids: [PENDING.id, LATE.id], active: true });
    await pass(POLL_FAST_MS + 50);
    expect(callsAbout(calls, LATE.id).length).toBeGreaterThanOrEqual(1);
  });
});

describe("m29 — a scan's answer never draws back a rename in flight", () => {
  it("a pending file renamed (PATCH held), its scan ends: the row says clean under the NEW name; the announcement names it so", async () => {
    const drive = new FakeDrive([PENDING]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount(drive, async (call) => {
      if (call.method === "PATCH" && call.path.endsWith(PENDING.id)) await held;
      return undefined;
    });
    let renaming: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      renaming = renameNode(PENDING, "renamed.pdf");
      await Promise.resolve();
    });
    await pass(1);
    expect(rowOf(PENDING.id)!.textContent).toContain("renamed.pdf");
    // The server has finished the scan (it still has the old name: the rename has not landed).
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "clean" });
    await after(5_000);
    expect(asksAbout(drive, PENDING.id)).toHaveLength(1);
    expect(rowOf(PENDING.id)!.getAttribute("data-scan")).toBe("clean");
    expect(rowOf(PENDING.id)!.textContent).toContain("renamed.pdf");
    expect(document.querySelector("[data-explorer-live]")!.textContent).toContain("renamed.pdf");
    release();
    await act(async () => {
      await renaming;
    });
    expect(rowOf(PENDING.id)!.textContent).toContain("renamed.pdf");
  });
});
