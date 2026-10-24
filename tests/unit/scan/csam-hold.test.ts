// R1 func-n6(c) (Addendum 9e): a scan whose server hash is listed csam commits the verdict, and the
// CSAM lock runs after the commit — and may fail and be retried for up to ≈ 32 min. In that window
// the node was neither locked nor held: a "delete forever", a trash purge or an account purge
// passed the purge gate. The verdict's own transaction now puts the node on legal hold.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegalHoldError } from "../../../src/worker/db/errors";
import { assertPurgeable } from "../../../src/worker/db/queries/trash";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { cleanBytes, deliver, explicit, listAs, nodeById, sha256Of, testDb, uploadedFile } from "./helpers";

vi.mock("../../../src/worker/services/scanning", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/scanning")>();
  return { ...real, lockSuspectedCsam: vi.fn(real.lockSuspectedCsam) };
});
afterEach(() => {
  vi.mocked(lockSuspectedCsam).mockReset();
});

const purgeable = (id: string) =>
  assertPurgeable(testDb(), [id]).then(
    () => true,
    (error: unknown) => {
      if (error instanceof LegalHoldError) return false;
      throw error;
    },
  );

describe("func-n6(c): a csam-listed verdict holds the node before its lock", () => {
  it("the lock fails after the verdict committed: the node is on legal hold — no purge passes the gate", async () => {
    const bytes = cleanBytes("listed");
    await listAs(await sha256Of(bytes), "csam");
    const { file } = await uploadedFile(bytes);
    vi.mocked(lockSuspectedCsam).mockRejectedValueOnce(new Error("test: the lock's database went away"));
    const [result] = await deliver([{ body: explicit(file) }]);
    expect(result!.outcome).toBe("retry");
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "pending", legalHold: true });
    expect(await purgeable(file.id)).toBe(false);
  });

  it("CONTROL: a clean verdict holds nothing", async () => {
    const { file } = await uploadedFile(cleanBytes());
    await deliver([{ body: explicit(file) }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "clean", legalHold: false });
    expect(await purgeable(file.id)).toBe(true);
  });
});
