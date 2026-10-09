import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { QueryError } from "../../../src/worker/db/errors";
import {
  commit,
  computeUsedBytes,
  reconcileUsedBytes,
  release,
  reserve,
  usageBreakdown,
} from "../../../src/worker/db/queries/quota";
import { nodeVersions, user } from "../../../src/worker/db/schema";
import { baId, makeFile, makeFolder, makeUpload, makeUser, openDb, rand, rejection } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

async function used(userId: string): Promise<{ usedBytes: number; quotaBytes: number }> {
  const [row] = await db
    .select({ usedBytes: user.usedBytes, quotaBytes: user.quotaBytes })
    .from(user)
    .where(eq(user.id, userId));
  return row!;
}

describe("reserve", () => {
  it("20 concurrent reservations never take used_bytes past quota_bytes", async () => {
    // Room for exactly 7 of the 20.
    const owner = await makeUser(db, { quotaBytes: 750, usedBytes: 0 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => db.transaction((tx) => reserve(tx, owner, 100))),
    );
    expect(results.filter(Boolean)).toHaveLength(7);
    const after = await used(owner);
    expect(after.usedBytes).toBe(700);
    expect(after.usedBytes).toBeLessThanOrEqual(after.quotaBytes);
    expect(typeof after.usedBytes).toBe("number");
  });

  it("holds under mixed sizes and concurrent releases", async () => {
    const owner = await makeUser(db, { quotaBytes: 1000, usedBytes: 400 });
    const sizes = [300, 250, 200, 150, 120, 90, 60, 30, 500, 700, 5, 5, 5, 5, 5, 400, 350, 80, 70, 10];
    const outcomes = await Promise.all(sizes.map((size) => reserve(db, owner, size)));
    const granted = sizes.filter((_, i) => outcomes[i]).reduce((a, b) => a + b, 0);
    const after = await used(owner);
    expect(after.usedBytes).toBe(400 + granted);
    expect(after.usedBytes).toBeLessThanOrEqual(1000);
    // Whatever was refused really did not fit at the time it was tried.
    expect(outcomes.some((ok) => !ok)).toBe(true);
  });

  it("fits exactly to the last byte and refuses one more", async () => {
    const owner = await makeUser(db, { quotaBytes: 1000, usedBytes: 900 });
    expect(await reserve(db, owner, 100)).toBe(true);
    expect(await reserve(db, owner, 1)).toBe(false);
    expect(await reserve(db, owner, 0)).toBe(true);
    expect((await used(owner)).usedBytes).toBe(1000);
    expect(await reserve(db, baId(), 1)).toBe(false);
  });

  it("works above 2^32 and rejects a negative or fractional amount", async () => {
    const owner = await makeUser(db);
    expect((await used(owner)).quotaBytes).toBe(5_368_709_120);
    expect(await reserve(db, owner, 5_000_000_000)).toBe(true);
    expect(await reserve(db, owner, 400_000_000)).toBe(false);
    expect((await used(owner)).usedBytes).toBe(5_000_000_000);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const error = await rejection(reserve(db, owner, bad));
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).code).toBe("validation");
    }
    expect((await used(owner)).usedBytes).toBe(5_000_000_000);
  });

  it("a rolled-back transaction gives the reservation back", async () => {
    const owner = await makeUser(db, { quotaBytes: 1000 });
    await expect(
      db.transaction(async (tx) => {
        expect(await reserve(tx, owner, 600)).toBe(true);
        throw new Error("upload init failed");
      }),
    ).rejects.toThrow("upload init failed");
    expect((await used(owner)).usedBytes).toBe(0);
  });
});

describe("release and commit", () => {
  it("release subtracts and never goes below zero; commit does no arithmetic", async () => {
    const owner = await makeUser(db, { quotaBytes: 1000, usedBytes: 300 });
    await release(db, owner, 100);
    expect((await used(owner)).usedBytes).toBe(200);
    await commit(db, owner, 200);
    expect((await used(owner)).usedBytes).toBe(200);
    await release(db, owner, 5000);
    expect((await used(owner)).usedBytes).toBe(0);
    await release(db, owner, 0);
    expect((await used(owner)).usedBytes).toBe(0);
  });
});

/** Files 100 + 40, trashed 30 (+ 20 under a trashed folder), hidden 7 + 5, versions 11, reservations 1000 + 500. */
async function populated() {
  const owner = await makeUser(db, { quotaBytes: 10_000 });
  const other = await makeUser(db);
  const folder = await makeFolder(db, owner, null, `docs-${rand()}`);
  const live = await makeFile(db, owner, folder.id, "live.txt", { size: 100 });
  await makeFile(db, owner, null, "root.txt", { size: 40 });
  await makeFile(db, owner, null, "trashed.txt", { size: 30, deletedAt: new Date(), trashedRoot: true });
  const bin = await makeFolder(db, owner, null, "bin", { deletedAt: new Date(), trashedRoot: true });
  await makeFile(db, owner, bin.id, "inside-bin.txt", { size: 20 });
  await makeFile(db, owner, null, "down.txt", { size: 7, takedownAt: new Date(), takedownReason: "dmca" });
  await makeFile(db, owner, null, "quarantined.bin", { size: 5, scanStatus: "suspected_csam" });
  await makeFile(db, owner, null, "avatar", { size: 3000, system: "avatar" });
  await db.insert(nodeVersions).values({
    nodeId: live.id,
    versionId: "old",
    r2Key: `u/${owner}/${live.id}/old`,
    size: 11,
    purgeAfter: new Date(),
  });
  await makeUpload(db, owner, owner, { size: 1000, status: "open" });
  await makeUpload(db, owner, other, { size: 500, status: "completing" });
  await makeUpload(db, owner, owner, { size: 9000, status: "done" });
  await makeUpload(db, owner, owner, { size: 9000, status: "aborted" });
  await makeUpload(db, owner, owner, { size: 4000, status: "open", purpose: "avatar" });
  // Someone else's rows must not count.
  await makeFile(db, other, null, "theirs.txt", { size: 77_777 });
  await makeUpload(db, other, owner, { size: 66_666, status: "open" });
  return { owner, other };
}

const EXPECTED_TOTAL = 100 + 40 + 30 + 20 + 7 + 5 + 11 + 1000 + 500;

describe("computeUsedBytes and reconcile", () => {
  it("sums files (trashed and hidden included), old versions and open reservations — never avatars", async () => {
    const { owner } = await populated();
    const total = await computeUsedBytes(db, owner);
    expect(total).toBe(EXPECTED_TOTAL);
    expect(typeof total).toBe("number");
    expect(await computeUsedBytes(db, baId())).toBe(0);
  });

  it("reconcileUsedBytes writes the computed value and reports the delta", async () => {
    const { owner } = await populated();
    await db.update(user).set({ usedBytes: 5 }).where(eq(user.id, owner));
    expect(await reconcileUsedBytes(db, owner)).toEqual({
      before: 5,
      after: EXPECTED_TOTAL,
      delta: EXPECTED_TOTAL - 5,
    });
    expect((await used(owner)).usedBytes).toBe(EXPECTED_TOTAL);
    expect(await reconcileUsedBytes(db, owner)).toEqual({
      before: EXPECTED_TOTAL,
      after: EXPECTED_TOTAL,
      delta: 0,
    });
    expect(await reconcileUsedBytes(db, baId())).toBeNull();
    // Inside a caller's transaction too.
    await db.update(user).set({ usedBytes: 9999 }).where(eq(user.id, owner));
    await db.transaction(async (tx) => {
      expect((await reconcileUsedBytes(tx, owner))!.delta).toBe(EXPECTED_TOTAL - 9999);
    });
    expect((await used(owner)).usedBytes).toBe(EXPECTED_TOTAL);
  });
});

describe("usageBreakdown", () => {
  it("splits the same bytes into files, trash, versions and reservations; hidden bytes stay in files", async () => {
    const { owner } = await populated();
    await reconcileUsedBytes(db, owner);
    const usage = await usageBreakdown(db, owner);
    expect(usage).toEqual({
      usedBytes: EXPECTED_TOTAL,
      quotaBytes: 10_000,
      filesBytes: 100 + 40 + 7 + 5,
      trashBytes: 30 + 20,
      versionsBytes: 11,
      reservedBytes: 1500,
    });
    const u = usage!;
    expect(u.filesBytes + u.trashBytes + u.versionsBytes + u.reservedBytes).toBe(u.usedBytes);
    for (const value of Object.values(u)) expect(typeof value).toBe("number");
    expect(await usageBreakdown(db, baId())).toBeNull();
  });
});
