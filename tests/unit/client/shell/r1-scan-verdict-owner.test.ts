// lib/contracts' scan-verdict registry (R1 a11y-3): one owner, account-scoped — the purge removes it.
import { describe, expect, it, vi } from "vitest";
import {
  registerScanVerdictOwner,
  registerUploadRequester,
  requestUpload,
  runUserStatePurgers,
  scanVerdictOwned,
  scanVerdictsSeen,
} from "../../../../src/client/lib/contracts";

const node = { id: "n1", etag: "v1", kind: "file" as const, scanStatus: "infected" };

describe("the scan-verdict owner", () => {
  it("without an owner: nothing is the queue's and nothing is told", () => {
    expect(scanVerdictOwned(node)).toBe(false);
    expect(() => scanVerdictsSeen([node])).not.toThrow();
  });

  it("an owner is asked and told; the purge removes it", async () => {
    const owner = { seen: vi.fn(), owns: vi.fn(() => true) };
    registerScanVerdictOwner(owner);
    expect(scanVerdictOwned(node)).toBe(true);
    scanVerdictsSeen([node]);
    expect(owner.seen).toHaveBeenCalledWith([node]);
    await runUserStatePurgers();
    expect(scanVerdictOwned(node)).toBe(false);
    scanVerdictsSeen([node]);
    expect(owner.seen).toHaveBeenCalledTimes(1);
  });

  it("stepping down removes only yourself", () => {
    const first = { seen: vi.fn(), owns: () => true };
    const second = { seen: vi.fn(), owns: () => false };
    const stepDown = registerScanVerdictOwner(first);
    registerScanVerdictOwner(second);
    stepDown();
    expect(scanVerdictOwned(node)).toBe(false);
    scanVerdictsSeen([node]);
    expect(second.seen).toHaveBeenCalled();
  });
});

describe("the upload requester", () => {
  it("asked through the contract, answered by whoever registered; nothing without one", () => {
    expect(() => requestUpload({ parentId: "p" })).not.toThrow();
    const requester = vi.fn();
    const stop = registerUploadRequester(requester);
    requestUpload({ parentId: "p" });
    expect(requester).toHaveBeenCalledWith({ parentId: "p" });
    stop();
    requestUpload();
    expect(requester).toHaveBeenCalledTimes(1);
  });
});
