// T23 review M1 and M2 (brief Addendum 3): nothing a held account is answered — its session, its
// usage, the room it is given to upload — differs from an unheld account's after a "delete forever".
// The bytes a hold keeps are the operator's: `quota.usageBreakdown` and the stored counter keep them.
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { usageBreakdown } from "../../../src/worker/db/queries/quota";
import { nodeVersions, uploads, user } from "../../../src/worker/db/schema";
import { getSession, send, testDb, verifiedUser } from "../auth/helpers";
import { generationInStep } from "../trash/helpers";
import { api, makeFile, makeFolder, person } from "../nodes/helpers";

beforeAll(generationInStep);

/**
 * 500 bytes of quota; files of 100 kept, 100 (+ an old version of 40) and a folder of 100 deleted
 * for good — the counter at 340 as the uploads left it. Unheld: the purge gives 240 back.
 */
async function nearQuota(owner: { id: string; as: Parameters<typeof api>[0] }, legalHold: boolean) {
  await testDb().update(user).set({ legalHold, quotaBytes: 500 }).where(eq(user.id, owner.id));
  await makeFile(owner.id, null, { name: "kept.txt", scanStatus: "clean", size: 100 });
  const doomed = await makeFile(owner.id, null, { name: "doomed.txt", scanStatus: "clean", size: 100 });
  await testDb()
    .insert(nodeVersions)
    .values({
      nodeId: doomed.id,
      versionId: `old-${doomed.id}`,
      r2Key: `u/${owner.id}/${doomed.id}/old`,
      size: 40,
      purgeAfter: new Date(Date.now() + 30 * 86_400_000),
    });
  const folder = await makeFolder(owner.id, null, { name: "folder" });
  await makeFile(owner.id, folder.id, { name: "inside.txt", scanStatus: "clean", size: 100 });
  await testDb().update(user).set({ usedBytes: 340 }).where(eq(user.id, owner.id));
  for (const id of [doomed.id, folder.id]) {
    expect((await api(owner.as, "POST", `/nodes/${id}/trash`)).status).toBe(200);
    expect((await api(owner.as, "DELETE", `/nodes/${id}`)).status).toBe(204);
  }
}

const init = (owner: { as: Parameters<typeof api>[0] }, size: number) =>
  api(owner.as, "POST", "/uploads", {
    body: {
      parentId: null,
      name: `new-${size}-${crypto.randomUUID()}.bin`,
      size,
      mimeDeclared: "application/octet-stream",
      fileLastModified: new Date().toISOString(),
      onConflict: "fail",
      purpose: "file",
    },
  });

describe("M2: quota is enforced against the figure the account holder sees", () => {
  it("after a delete forever, a held account near its quota may upload exactly what an unheld one may", async () => {
    const held = await person();
    const free = await person();
    await nearQuota(held, true);
    await nearQuota(free, false);
    // 100 used of 500 for both, as both are shown: 400 fits, 401 does not.
    const fits = [await init(held, 400), await init(free, 400)];
    expect(fits.map((answer) => answer.status)).toEqual([201, 201]);
    const held2 = await person();
    const free2 = await person();
    await nearQuota(held2, true);
    await nearQuota(free2, false);
    const over = [await init(held2, 401), await init(free2, 401)];
    expect(over.map((answer) => answer.status)).toEqual([over[1]!.status, over[1]!.status]);
    expect(over[1]!.status).toBe(413);
    expect(over[0]!.body.error).toBe(over[1]!.body.error);
  });

  it("the operator's breakdown and the stored counter keep the bytes the hold keeps", async () => {
    const held = await person();
    await nearQuota(held, true);
    expect(await usageBreakdown(testDb(), held.id)).toMatchObject({
      usedBytes: 340,
      trashBytes: 200,
      versionsBytes: 40,
    });
    expect((await api(held.as, "GET", "/account/usage")).body).toMatchObject({ usedBytes: 100 });
  });
});

describe("Addendum 4: only a LEGAL hold is left out, and only up to a backstop", () => {
  it("bytes kept for another reason (a file under review) still count, held account or not", async () => {
    const owner = await person();
    await testDb().update(user).set({ quotaBytes: 500, usedBytes: 340 }).where(eq(user.id, owner.id));
    await makeFile(owner.id, null, { name: "kept.txt", scanStatus: "clean", size: 100 });
    const reviewed = await makeFile(owner.id, null, {
      name: "reviewed.txt",
      scanStatus: "under_review",
      size: 240,
    });
    expect((await api(owner.as, "POST", `/nodes/${reviewed.id}/trash`)).status).toBe(200);
    expect((await api(owner.as, "DELETE", `/nodes/${reviewed.id}`)).status).toBe(204);
    // Kept by the review, not by a legal hold: still the account's bytes.
    expect((await api(owner.as, "GET", "/account/usage")).body).toMatchObject({ usedBytes: 340 });
    expect((await init(owner, 400)).status).toBe(413);
    expect((await init(owner, 160)).status).toBe(201);
  });

  /** A held account whose deleted-for-good, hold-kept bytes are `kept`, nothing else stored. */
  async function retaining(kept: number) {
    const owner = await person({ legalHold: true });
    await testDb().update(user).set({ quotaBytes: 500, usedBytes: kept }).where(eq(user.id, owner.id));
    await makeFile(owner.id, null, {
      name: "kept.bin",
      scanStatus: "clean",
      size: kept,
      deletedAt: new Date(),
      trashedRoot: true,
      purgeRequestedAt: new Date(),
    });
    return owner;
  }

  it("past 2 × quota of hold-kept bytes, uploads are refused with the ORDINARY full-account answer; at it, they are not", async () => {
    const atLimit = await retaining(1000);
    expect((await init(atLimit, 400)).status).toBe(201);
    const past = await retaining(1001);
    const refused = await init(past, 1);
    // The same answer as an ordinary full account's.
    const full = await person();
    await testDb().update(user).set({ quotaBytes: 500, usedBytes: 500 }).where(eq(user.id, full.id));
    const ordinary = await init(full, 1);
    expect(refused.status).toBe(413);
    expect({ ...refused.body, requestId: null }).toEqual({ ...ordinary.body, requestId: null });
    // And it is shown as what it is answered as: full.
    const shown = (await api(past.as, "GET", "/account/usage")).body;
    const fullShown = (await api(full.as, "GET", "/account/usage")).body;
    expect([shown.usedBytes, shown.quotaBytes]).toEqual([fullShown.usedBytes, fullShown.quotaBytes]);
  });

  it("the loop is bounded: upload, delete forever, repeat — a held account stops at quota + 2 × quota retained", async () => {
    const owner = await person({ legalHold: true });
    await testDb().update(user).set({ quotaBytes: 500, usedBytes: 0 }).where(eq(user.id, owner.id));
    let rounds = 0;
    for (; rounds < 10; rounds += 1) {
      const started = await init(owner, 500);
      if (started.status !== 201) {
        expect(started.status).toBe(413);
        break;
      }
      // The upload as it would complete: the reservation becomes a 500-byte file …
      const file = await makeFile(owner.id, null, {
        name: `round-${rounds}.bin`,
        scanStatus: "clean",
        size: 500,
      });
      await testDb().delete(uploads).where(eq(uploads.id, started.body.uploadId));
      // … which is then deleted for good (and kept by the hold).
      expect((await api(owner.as, "POST", `/nodes/${file.id}/trash`)).status).toBe(200);
      expect((await api(owner.as, "DELETE", `/nodes/${file.id}`)).status).toBe(204);
    }
    expect(rounds).toBe(3);
    const [row] = await testDb()
      .select({ usedBytes: user.usedBytes })
      .from(user)
      .where(eq(user.id, owner.id));
    expect(row!.usedBytes).toBeLessThanOrEqual(500 + 2 * 500);
  });
});

describe("M1: the session answer carries no usage figure", () => {
  it("get-session has no usedBytes, and a held account's answer has the shape of an unheld one's", async () => {
    const held = await verifiedUser({ name: "Same Name" });
    const free = await verifiedUser({ name: "Same Name" });
    for (const [who, hold] of [
      [held, true],
      [free, false],
    ] as const) {
      await testDb()
        .update(user)
        .set({ legalHold: hold, usedBytes: hold ? 340 : 100 })
        .where(eq(user.id, who.user.id));
    }
    const a = await getSession(held.client);
    const b = await getSession(free.client);
    expect(a!.user).not.toHaveProperty("usedBytes");
    expect(a!.user).not.toHaveProperty("legalHold");
    expect(Object.keys(a!.user).sort()).toEqual(Object.keys(b!.user).sort());
    // The sign-in answer carries the same user object.
    const signedIn = await send(held.client, "/api/auth/sign-in/email", {
      json: { email: held.email, password: held.password },
      headers: { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
    });
    expect(JSON.stringify(signedIn.body)).not.toMatch(/usedBytes|legalHold/);
  });
});
