// One source of truth for a scan's verdict: what the listing learns — from its own poll or from a
// refetch — is handed to the uploader (through lib/contracts), whose ribbon rows take it (tests/unit/client/upload/
// ribbon-scan.test.tsx covers what the uploader does with it).
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitNodesChanged, scanVerdictsSeen } from "../../../../src/client/lib/contracts";
import { FakeDrive } from "./fixtures/drive";
import { fileNode } from "./fixtures/nodes";
import { renderExplorer, rows, serveDrive, setupExplorer } from "./helpers";

vi.mock("../../../../src/client/features/upload", () => ({
  requestUpload: vi.fn(),
  UploadDropOverlay: () => null,
  routes: [],
}));
// The listing reaches the uploader through lib/contracts (R1: no feature imports another).
vi.mock("../../../../src/client/lib/contracts", async (original) => {
  const real = await original<typeof import("../../../../src/client/lib/contracts")>();
  return { ...real, scanVerdictsSeen: vi.fn() };
});

setupExplorer();

const PENDING = fileNode(1, { name: "new.pdf", scanStatus: "pending" });

async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Whether the uploader has been told this node's status. */
const told = (id: string, status: string) =>
  vi
    .mocked(scanVerdictsSeen)
    .mock.calls.some(([nodes]) => nodes.some((node) => node.id === id && node.scanStatus === status));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(scanVerdictsSeen).mockClear();
});

describe("the listing tells the uploader what it learned about a scan", () => {
  it("from its poll", async () => {
    const drive = new FakeDrive([PENDING]);
    serveDrive(drive);
    renderExplorer("/");
    await pass(1);
    await pass(1);
    expect(rows().length).toBe(1);
    expect(told(PENDING.id, "pending")).toBe(true);
    expect(told(PENDING.id, "clean")).toBe(false);
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "clean" });
    await pass(5_100);
    expect(told(PENDING.id, "clean")).toBe(true);
  });

  it("from a refetch of the listing", async () => {
    const drive = new FakeDrive([PENDING]);
    serveDrive(drive);
    renderExplorer("/");
    await pass(1);
    await pass(1);
    drive.nodes.set(PENDING.id, { ...PENDING, scanStatus: "infected" });
    // Before the poll's first question (5 s): only the refetch can have told it.
    emitNodesChanged([null]);
    await pass(100);
    await pass(100);
    expect(told(PENDING.id, "infected")).toBe(true);
  });
});
