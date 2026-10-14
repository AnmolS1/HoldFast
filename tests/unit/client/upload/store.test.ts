// The queue's store tells its listeners from a microtask: a listener that throws has no caller to
// land in. It is reported, and the listeners after it are still told.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addItems,
  resetStore,
  subscribeUploads,
  type UploadItem,
} from "../../../../src/client/features/upload/store";
import { reportError } from "../../../../src/client/lib/sentry";

vi.mock("../../../../src/client/lib/sentry", () => ({ reportError: vi.fn() }));

afterEach(() => {
  resetStore();
  vi.mocked(reportError).mockClear();
});

describe("the upload store's listeners", () => {
  it("a listener that throws is reported, and the next listener is still told", async () => {
    const failure = new Error("a listener's own bug");
    const stopFirst = subscribeUploads(() => {
      throw failure;
    });
    let told = 0;
    const stopSecond = subscribeUploads(() => (told += 1));
    addItems([{ id: "u1", kind: "file", state: "queued" } as UploadItem]);
    await Promise.resolve();
    expect(told).toBe(1);
    expect(reportError).toHaveBeenCalledWith(failure, { where: "upload store listener" });
    stopFirst();
    stopSecond();
  });
});
