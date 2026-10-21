// `ownersPastKeptBackstop` (db/queries/quota.ts, T27 R-8): the accounts whose kept deleted-for-good
// bytes are ABOVE `KEPT_MAX_QUOTAS` × their quota — the same expression `keptBackstopReached` and
// `reserve` use. The database is shared: the listing is read with a large limit and only this
// file's own accounts are looked at.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  KEPT_MAX_QUOTAS,
  keptBackstopReached,
  ownersPastKeptBackstop,
} from "../../../src/worker/db/queries/quota";
import { nodes, nodeVersions } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeUser, testDb } from "../services-core/helpers";

const QUOTA = 1_000;

/** An account with a deleted-for-good folder holding `fileBytes`, plus a kept old version. */
async function accountKeeping(fileBytes: number, versionBytes: number, requested = true) {
  const owner = await makeUser({ quotaBytes: QUOTA });
  const folder = await makeFolder(owner.id);
  const file = await makeFile(owner.id, folder.id, { size: fileBytes });
  const versionId = uuidv7();
  await testDb()
    .insert(nodeVersions)
    .values({
      nodeId: file.id,
      versionId,
      r2Key: `u/${owner.id}/${file.id}/${versionId}`,
      size: versionBytes,
      createdBy: owner.id,
      purgeAfter: new Date(Date.now() + 30 * 86_400_000),
    });
  if (requested) {
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), purgeRequestedAt: new Date() })
      .where(eq(nodes.id, folder.id));
  }
  return owner.id;
}

describe("ownersPastKeptBackstop", () => {
  it("lists the account past the backstop, not the one exactly at it, nor one that deleted nothing", async () => {
    const line = KEPT_MAX_QUOTAS * QUOTA;
    const past = await accountKeeping(line - 100, 101); // line + 1
    const at = await accountKeeping(line - 100, 100); // exactly the line
    const notRequested = await accountKeeping(line * 3, 0, false); // big, but nothing deleted for good
    const listed = new Set(await ownersPastKeptBackstop(testDb(), { limit: 1000 }));
    expect(listed.has(past)).toBe(true);
    expect(listed.has(at)).toBe(false);
    expect(listed.has(notRequested)).toBe(false);
    // The same answer as the per-account predicate the upload path uses.
    expect(await keptBackstopReached(testDb(), past)).toBe(true);
    expect(await keptBackstopReached(testDb(), at)).toBe(false);
  });

  it("answers at most the limit", async () => {
    await accountKeeping(KEPT_MAX_QUOTAS * QUOTA + 1, 0);
    await accountKeeping(KEPT_MAX_QUOTAS * QUOTA + 1, 0);
    const two = await ownersPastKeptBackstop(testDb(), { limit: 2 });
    expect(two).toHaveLength(2);
  });
});
