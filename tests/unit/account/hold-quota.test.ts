// T23 review M1 and M2 (brief Addendum 3): nothing a held account is answered — its session, its
// usage, the room it is given to upload — differs from an unheld account's after a "delete forever".
// The bytes a hold keeps are the operator's: `quota.usageBreakdown` and the stored counter keep them.
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { setNodeLegalHold, setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import { deletedKeptBytes, usageBreakdown } from "../../../src/worker/db/queries/quota";
import { purgeRoot } from "../../../src/worker/jobs/purge";
import { runBackground } from "../../../src/worker/services/request-context";
import { nodeVersions, uploads, user } from "../../../src/worker/db/schema";
import { getSession, realCore, send, testDb, verifiedUser } from "../auth/helpers";
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

describe("Addendum 5: every still-present deletion is left out — a hold placed or lifted moves nothing", () => {
  type Owner = Awaited<ReturnType<typeof person>>;
  const shown = async (owner: Owner) => (await api(owner.as, "GET", "/account/usage")).body;
  /** What the holder sees and may do: the usage answer, and whether 401 bytes (one over the room) are refused. */
  const view = async (owner: Owner) => ({ usage: await shown(owner), over: (await init(owner, 401)).status });
  const deleteForGood = async (owner: Owner, id: string) => {
    expect((await api(owner.as, "POST", `/nodes/${id}/trash`)).status).toBe(200);
    expect((await api(owner.as, "DELETE", `/nodes/${id}`)).status).toBe(204);
  };
  /** 500 of quota; a kept file of 100; 240 bytes deleted for good and KEPT by `keep`, `toggle` then flips what keeps them. */
  async function scenario(
    keep: (owner: Owner) => Promise<{ root: string; toggle: () => Promise<void> }>,
  ): Promise<{ owner: Owner; root: string; toggle: () => Promise<void> }> {
    const owner = await person();
    await testDb().update(user).set({ quotaBytes: 500 }).where(eq(user.id, owner.id));
    await makeFile(owner.id, null, { name: "kept.txt", scanStatus: "clean", size: 100 });
    const made = await keep(owner);
    await testDb().update(user).set({ usedBytes: 340 }).where(eq(user.id, owner.id));
    await deleteForGood(owner, made.root);
    return { owner, ...made };
  }

  const KINDS: Array<[string, (owner: Owner) => Promise<{ root: string; toggle: () => Promise<void> }>]> = [
    [
      "the owner's legal hold, lifted",
      async (owner) => {
        await setUserLegalHold(testDb(), owner.id, true);
        const file = await makeFile(owner.id, null, { name: "gone.bin", scanStatus: "clean", size: 240 });
        return {
          root: file.id,
          toggle: async () => void (await setUserLegalHold(testDb(), owner.id, false)),
        };
      },
    ],
    [
      "a node hold on the root, lifted",
      async (owner) => {
        const file = await makeFile(owner.id, null, { name: "gone.bin", scanStatus: "clean", size: 240 });
        await setNodeLegalHold(testDb(), file.id, true);
        return { root: file.id, toggle: async () => void (await setNodeLegalHold(testDb(), file.id, false)) };
      },
    ],
    [
      "a node hold on a folder above the root, lifted",
      async (owner) => {
        const folder = await makeFolder(owner.id, null, { name: "held-above" });
        const file = await makeFile(owner.id, folder.id, {
          name: "gone.bin",
          scanStatus: "clean",
          size: 240,
        });
        await setNodeLegalHold(testDb(), folder.id, true);
        return {
          root: file.id,
          toggle: async () => void (await setNodeLegalHold(testDb(), folder.id, false)),
        };
      },
    ],
    [
      "a node hold on a file under the root, lifted",
      async (owner) => {
        const folder = await makeFolder(owner.id, null, { name: "gone" });
        const file = await makeFile(owner.id, folder.id, {
          name: "held.bin",
          scanStatus: "clean",
          size: 240,
        });
        await setNodeLegalHold(testDb(), file.id, true);
        return {
          root: folder.id,
          toggle: async () => void (await setNodeLegalHold(testDb(), file.id, false)),
        };
      },
    ],
    [
      "a file under review — then the owner's legal hold PLACED",
      async (owner) => {
        const file = await makeFile(owner.id, null, {
          name: "reviewed.bin",
          scanStatus: "under_review",
          size: 240,
        });
        return { root: file.id, toggle: async () => void (await setUserLegalHold(testDb(), owner.id, true)) };
      },
    ],
  ];

  it.each(KINDS)(
    "%s: shown usage and the room to upload are the same before and after",
    async (_name, keep) => {
      const { owner, toggle } = await scenario(keep);
      const before = await view(owner);
      expect(before.usage).toMatchObject({ usedBytes: 100, trashBytes: 0 });
      expect(before.over).toBe(413);
      await toggle();
      expect(await view(owner)).toEqual(before);
      expect((await init(owner, 400)).status).toBe(201);
    },
  );

  it("once the purge runs (the hold lifted), the counter drops by exactly what was left out: released once, nothing shown moves", async () => {
    const { owner, root, toggle } = await scenario(KINDS[0]![1]);
    await toggle();
    const before = await shown(owner);
    const purged = await runBackground(
      env,
      { waitUntil: () => {} },
      (bg) => purgeRoot(bg, root, "cron"),
      realCore,
    );
    expect(purged.outcome).toBe("purged");
    const [row] = await testDb()
      .select({ usedBytes: user.usedBytes })
      .from(user)
      .where(eq(user.id, owner.id));
    expect(row!.usedBytes).toBe(100);
    expect(await shown(owner)).toEqual(before);
    expect(await deletedKeptBytes(testDb(), owner.id)).toEqual({ files: 0, versions: 0 });
  });

  it("the kept set, branch by branch: the requested root, everything under it, the old versions, a requested root nested inside counted once", async () => {
    const owner = await person();
    const at = { deletedAt: new Date() };
    const requested = { ...at, trashedRoot: true, purgeRequestedAt: new Date() };
    const root = await makeFolder(owner.id, null, { name: "root", ...requested });
    const a = await makeFile(owner.id, root.id, { name: "a.bin", scanStatus: "clean", size: 100, ...at });
    await testDb()
      .insert(nodeVersions)
      .values({
        nodeId: a.id,
        versionId: `old-${a.id}`,
        r2Key: `u/${owner.id}/${a.id}/old`,
        size: 40,
        purgeAfter: new Date(Date.now() + 86_400_000),
      });
    const sub = await makeFolder(owner.id, root.id, { name: "sub", ...at });
    await makeFile(owner.id, sub.id, { name: "b.bin", scanStatus: "clean", size: 50, ...requested });
    // Not deleted for good: neither counted.
    await makeFile(owner.id, null, { name: "live.bin", scanStatus: "clean", size: 7 });
    await makeFile(owner.id, null, {
      name: "trashed.bin",
      scanStatus: "clean",
      size: 9,
      deletedAt: new Date(),
      trashedRoot: true,
    });
    expect(await deletedKeptBytes(testDb(), owner.id)).toEqual({ files: 150, versions: 40 });
  });

  /** An account whose kept deleted-for-good bytes are `kept` — no hold at all (a purge not yet run). */
  async function retaining(kept: number) {
    const owner = await person();
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

  it("the backstop counts every kept root: past 2 × quota, the ORDINARY full-account answer, and shown full with parts that add up", async () => {
    const atLimit = await retaining(1000);
    expect((await init(atLimit, 400)).status).toBe(201);
    const past = await retaining(1001);
    const refused = await init(past, 1);
    const full = await person();
    await testDb().update(user).set({ quotaBytes: 500, usedBytes: 500 }).where(eq(user.id, full.id));
    await makeFile(full.id, null, { name: "full.bin", scanStatus: "clean", size: 500 });
    const ordinary = await init(full, 1);
    expect(refused.status).toBe(413);
    expect({ ...refused.body, requestId: null }).toEqual({ ...ordinary.body, requestId: null });
    const pastShown = await shown(past);
    expect(pastShown).toEqual(await shown(full));
    const parts =
      pastShown.filesBytes + pastShown.trashBytes + pastShown.versionsBytes + pastShown.reservedBytes;
    expect(parts).toBe(pastShown.usedBytes);
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
      await deleteForGood(owner, file.id);
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
