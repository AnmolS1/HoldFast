// `enqueueRescan` keeps H2's per-state table (T21 step 5) now that the real pipeline is behind it.
import { describe, expect, it } from "vitest";
import { claim } from "../../../src/worker/db/queries/scan-jobs";
import { AppError } from "../../../src/worker/services/errors";
import { enqueueRescan } from "../../../src/worker/services/scanning";
import { cleanBytes, makeFolder, makeUser, nodeById, serviceDeps, testDb, uploadedFile } from "./helpers";

function recording() {
  const sent: unknown[] = [];
  const service = serviceDeps();
  service.deps.env = {
    ...service.deps.env,
    SCAN_QUEUE: { send: async (message: unknown) => void sent.push(message) },
  } as unknown as Env;
  return { deps: service.deps, sent, settle: service.settle };
}

describe("enqueueRescan keeps H2's per-state table", () => {
  it("under_review kept and sent; suspected_csam, taken down, inside a taken-down folder left and not sent; pending with no live job sent again; clean reset", async () => {
    const owner = await makeUser();
    const down = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
    const mk = (overrides: Record<string, unknown>) => uploadedFile(cleanBytes(), { owner, ...overrides });
    const review = await mk({ scanStatus: "under_review" });
    const locked = await mk({ scanStatus: "suspected_csam", legalHold: true });
    const takenDown = await mk({ scanStatus: "clean", takedownAt: new Date(), takedownReason: "dmca" });
    const inside = await mk({ scanStatus: "clean", parentId: down.id });
    const pending = await mk({ scanStatus: "pending" });
    const live = await mk({ scanStatus: "pending" });
    await claim(testDb(), { nodeId: live.file.id, r2Key: live.file.r2Key! });
    const clean = await mk({ scanStatus: "clean", scannedAt: new Date(0) });

    const run = recording();
    expect(await enqueueRescan(run.deps, review.file.id, { by: "owner" })).toEqual({ queued: true });
    expect((await nodeById(review.file.id))!.scanStatus).toBe("under_review");
    expect(await enqueueRescan(run.deps, locked.file.id, { by: "admin" })).toEqual({
      queued: false,
      reason: "locked",
    });
    expect(await enqueueRescan(run.deps, takenDown.file.id, { by: "admin" })).toEqual({
      queued: false,
      reason: "taken_down",
    });
    expect(await enqueueRescan(run.deps, inside.file.id, { by: "admin" })).toEqual({
      queued: false,
      reason: "taken_down",
    });
    await expect(enqueueRescan(run.deps, locked.file.id, { by: "owner" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await enqueueRescan(run.deps, pending.file.id, { by: "owner" })).toEqual({ queued: true });
    await expect(enqueueRescan(run.deps, live.file.id, { by: "owner" })).rejects.toBeInstanceOf(AppError);
    expect(await enqueueRescan(run.deps, clean.file.id, { by: "owner" })).toEqual({ queued: true });
    expect(await nodeById(clean.file.id)).toMatchObject({ scanStatus: "pending", scannedAt: null });
    await run.settle();
    expect(run.sent).toEqual(
      [review, pending, clean].map(({ file }) => ({ v: 1, nodeId: file.id, key: file.r2Key, force: true })),
    );
    for (const left of [locked, takenDown, inside]) {
      expect((await nodeById(left.file.id))!.scanStatus).toBe(left.file.scanStatus);
    }
  });
});
