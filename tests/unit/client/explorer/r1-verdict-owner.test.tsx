// R1 a11y-3: the explorer's own scan poll leaves the verdict of a file the upload queue follows to
// the queue (said once, in the upload log) — asked through lib/contracts, never by importing the
// uploader; every other file's verdict it says itself.
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanVerdictOwned } from "../../../../src/client/lib/contracts";
import { FakeDrive } from "./fixtures/drive";
import { fileNode } from "./fixtures/nodes";
import { renderExplorer, rowOf, rows, serveDrive, setupExplorer } from "./helpers";

vi.mock("../../../../src/client/lib/contracts", async (original) => {
  const real = await original<typeof import("../../../../src/client/lib/contracts")>();
  return { ...real, scanVerdictOwned: vi.fn(() => false) };
});

setupExplorer();

const PENDING = fileNode(1, { name: "new.pdf", scanStatus: "pending" });
const live = () => document.querySelector("[data-explorer-live]")?.textContent ?? "";

async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function blockedAfterPoll(owned: boolean) {
  vi.mocked(scanVerdictOwned).mockReturnValue(owned);
  const drive = new FakeDrive([PENDING]);
  serveDrive(drive);
  renderExplorer("/");
  await pass(1);
  await pass(1);
  expect(rows().length).toBe(1);
  drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "infected" });
  await pass(5_100);
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe("one owner per verdict", () => {
  it("a file the upload queue follows: the row shows the verdict, the explorer's region says nothing", async () => {
    await blockedAfterPoll(true);
    expect(rowOf(PENDING.id)!.querySelector("[data-status]")!.textContent).toContain("Blocked");
    expect(vi.mocked(scanVerdictOwned)).toHaveBeenCalledWith(expect.objectContaining({ id: PENDING.id }));
    expect(live()).toBe("");
  });

  it("CONTROL: any other file's verdict is said by the explorer", async () => {
    await blockedAfterPoll(false);
    expect(live()).toBe("new.pdf: Blocked — flagged by the malware scan");
  });
});
