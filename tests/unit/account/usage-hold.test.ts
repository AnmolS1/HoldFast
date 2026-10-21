// GET /api/account/usage — what the account holder is shown (the sidebar's bar, the Storage page,
// the uploader's free-space hint) — must not reveal a legal hold (T23 brief Addendum 2, Q3): after
// a "delete forever" a held account's usage drops like anyone's. The operator's true figure
// (`quota.usageBreakdown`, the stored counter quota enforcement reads) keeps the held bytes.
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { usageBreakdown } from "../../../src/worker/db/queries/quota";
import { nodeVersions, user } from "../../../src/worker/db/schema";
import { generationInStep } from "../trash/helpers";
import { api, makeFile, makeFolder, person, testDb } from "../nodes/helpers";

// "Delete forever" asks the rollback detector first: this file's bucket gets the database's number.
beforeAll(generationInStep);

/** Files of 100 bytes: one kept, one deleted for good with an old version of 40, and a folder deleted for good. */
async function deletedForGood(legalHold: boolean) {
  const who = await person({ legalHold });
  await makeFile(who.id, null, { name: "kept.txt", scanStatus: "clean", size: 100 });
  const doomed = await makeFile(who.id, null, { name: "doomed.txt", scanStatus: "clean", size: 100 });
  await testDb()
    .insert(nodeVersions)
    .values({
      nodeId: doomed.id,
      versionId: `old-${doomed.id}`,
      r2Key: `u/${who.id}/${doomed.id}/old`,
      size: 40,
      purgeAfter: new Date(Date.now() + 30 * 86_400_000),
    });
  const folder = await makeFolder(who.id, null, { name: "folder" });
  await makeFile(who.id, folder.id, { name: "inside.txt", scanStatus: "clean", size: 100 });
  // The counter as the uploads left it: three files and the old version.
  await testDb().update(user).set({ usedBytes: 340 }).where(eq(user.id, who.id));
  for (const id of [doomed.id, folder.id]) {
    expect((await api(who.as, "POST", `/nodes/${id}/trash`)).status).toBe(200);
    expect((await api(who.as, "DELETE", `/nodes/${id}`)).status).toBe(204);
  }
  return who;
}

describe("usage as the account holder sees it", () => {
  it("after a delete forever, a held account's usage drops like an unheld one's — the whole answer is the same", async () => {
    const held = await deletedForGood(true);
    const free = await deletedForGood(false);
    const a = await api(held.as, "GET", "/account/usage");
    const b = await api(free.as, "GET", "/account/usage");
    expect(a.status).toBe(200);
    expect(b.body).toMatchObject({ usedBytes: 100, filesBytes: 100, trashBytes: 0, versionsBytes: 0 });
    expect(a.body).toEqual(b.body);
  });

  it("the true figure stays for the operator and for quota enforcement: the held bytes are still counted", async () => {
    const held = await deletedForGood(true);
    expect(await usageBreakdown(testDb(), held.id)).toMatchObject({
      usedBytes: 340,
      trashBytes: 200,
      versionsBytes: 40,
    });
    const [row] = await testDb().select({ usedBytes: user.usedBytes }).from(user).where(eq(user.id, held.id));
    expect(row!.usedBytes).toBe(340);
  });
});
