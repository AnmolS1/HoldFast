// "Confirm delete" (T25 section 4, PLAN §6 rule 17): a purge now through T14's `purgeRoot`,
// refused for every hold cause — on the node, on its owner, and on a folder two levels above —
// and refused while the database reads as rolled back or the pause switch is on. Nothing is
// deleted by a refusal; the control purges, and the hash stays blocklisted.
//
// The rollback detector is put in step for this file's own bucket (isolated per test file); the
// pause switch is put there and taken away again. No setting is written.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hashBlocklist, nodes } from "../../../src/worker/db/schema";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { generationInStep, objectExists, openNoticeOn } from "../trash/helpers";
import {
  admin,
  adminCall,
  auditOf,
  blocklistRow,
  lockedFile,
  madeUpSha,
  makeFile,
  makeFolder,
  member,
  nodeRowOf,
  testDb,
} from "./helpers";

const DELETE = { action: "delete", note: "Confirmed malware; delete now." } as const;

beforeAll(async () => {
  await generationInStep();
});
afterEach(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});

/** A file with its object stored at its key. */
async function storedFile(
  ownerId: string,
  parentId: string | null = null,
  overrides: Parameters<typeof makeFile>[2] = {},
) {
  const file = await makeFile(ownerId, parentId, {
    scanStatus: "infected",
    sha256: madeUpSha(),
    ...overrides,
  });
  await env.FILES.put(file.r2Key!, "the stored bytes");
  return file;
}

async function stillThere(file: { id: string; r2Key: string | null }) {
  return { row: (await nodeRowOf(file.id)) !== null, object: await objectExists(file.r2Key!) };
}

describe("refused for each hold cause: 409 held, the cause named, nothing deleted", () => {
  const cases: [string, () => Promise<{ file: { id: string; r2Key: string | null }; cause: string }>][] = [
    [
      "a legal hold on the node",
      async () => {
        const owner = await member();
        return { file: await storedFile(owner.id, null, { legalHold: true }), cause: "node_legal_hold" };
      },
    ],
    [
      "a legal hold on the owner",
      async () => {
        const owner = await member({ legalHold: true });
        return { file: await storedFile(owner.id), cause: "owner_legal_hold" };
      },
    ],
    [
      "under_review",
      async () => {
        const owner = await member();
        return {
          file: await storedFile(owner.id, null, { scanStatus: "under_review", scanStatusPrev: "infected" }),
          cause: "under_review",
        };
      },
    ],
    [
      "suspected_csam",
      async () => {
        const t = await lockedFile();
        await env.FILES.put(t.file.r2Key!, "the stored bytes");
        return { file: t.file, cause: "suspected_csam" };
      },
    ],
    [
      "an open DMCA notice naming it",
      async () => {
        const owner = await member();
        const file = await storedFile(owner.id);
        await openNoticeOn(file.id);
        return { file, cause: "open_notice" };
      },
    ],
    [
      "a held folder two levels above",
      async () => {
        const owner = await member();
        const top = await makeFolder(owner.id, null, { legalHold: true });
        const middle = await makeFolder(owner.id, top.id);
        return { file: await storedFile(owner.id, middle.id), cause: "inherited_legal_hold" };
      },
    ],
    [
      "a folder two levels above named by an open notice",
      async () => {
        const owner = await member();
        const top = await makeFolder(owner.id);
        const middle = await makeFolder(owner.id, top.id);
        await openNoticeOn(top.id);
        return { file: await storedFile(owner.id, middle.id), cause: "inherited_open_notice" };
      },
    ],
  ];

  it.each(cases)("%s", async (_name, make) => {
    const who = await admin();
    const { file, cause } = await make();
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: DELETE });
    expect(answer.status).toBe(409);
    expect(answer.body.details.reason).toBe("held");
    expect(answer.body.details.holds).toContain(cause);
    expect(await stillThere(file)).toEqual({ row: true, object: true });
    expect(await auditOf("admin.node_purged", file.id)).toHaveLength(0);
    expect(await auditOf("system.purge", file.id)).toHaveLength(0);
  });
});

describe("only a member of the quarantine (safety-7)", () => {
  it("a clean file, and a folder that is not taken down → 409 not_quarantined, nothing deleted; control: the same folder taken down → purged", async () => {
    const who = await admin();
    const owner = await member();
    const clean = await storedFile(owner.id, null, { scanStatus: "clean", scannedAt: new Date() });
    const folder = await makeFolder(owner.id);
    const inside = await storedFile(owner.id, folder.id, { scanStatus: "clean", scannedAt: new Date() });
    for (const target of [clean, folder]) {
      const answer = await adminCall(who.as, "POST", `/quarantine/${target.id}`, { body: DELETE });
      expect([answer.status, answer.body.error]).toEqual([409, "not_quarantined"]);
      expect(await auditOf("admin.node_purged", target.id)).toHaveLength(0);
    }
    expect(await stillThere(clean)).toEqual({ row: true, object: true });
    expect(await stillThere(inside)).toEqual({ row: true, object: true });

    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "admin" })
      .where(eq(nodes.id, folder.id));
    const purged = await adminCall(who.as, "POST", `/quarantine/${folder.id}`, { body: DELETE });
    expect(purged.status).toBe(200);
    expect(await stillThere(inside)).toEqual({ row: false, object: false });
  });
});

describe("rule 17: asked of the rollback detector and the pause switch first", () => {
  it("the pause switch on → 409 destroy_paused, nothing deleted; control: off → purged", async () => {
    const who = await admin();
    const owner = await member();
    const paused = await storedFile(owner.id);
    await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");
    const answer = await adminCall(who.as, "POST", `/quarantine/${paused.id}`, { body: DELETE });
    expect(answer.status).toBe(409);
    expect(answer.body.details.reason).toBe("destroy_paused");
    expect(await stillThere(paused)).toEqual({ row: true, object: true });
    expect(await auditOf("admin.node_purged", paused.id)).toHaveLength(0);

    await env.FILES.delete(DESTROY_PAUSED_KEY);
    const again = await adminCall(who.as, "POST", `/quarantine/${paused.id}`, { body: DELETE });
    expect(again.status).toBe(200);
    expect(await stillThere(paused)).toEqual({ row: false, object: false });
  });

  it("the database reading as rolled back (the generation object two ahead) → 409 destroy_paused, nothing deleted", async () => {
    const who = await admin();
    const owner = await member();
    const file = await storedFile(owner.id);
    const database = await generationInStep();
    await env.FILES.put("sys/reconcile-generation", String(database + 2));
    try {
      const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: DELETE });
      expect(answer.status).toBe(409);
      expect(answer.body.details.reason).toBe("destroy_paused");
      expect(await stillThere(file)).toEqual({ row: true, object: true });
    } finally {
      await generationInStep();
    }
  });
});

describe("control: in step, unpaused, unheld", () => {
  it("purged — row and object gone, `system.purge` with the admin as actor, `admin.node_purged`, the hash still listed", async () => {
    const who = await admin();
    const owner = await member();
    const file = await storedFile(owner.id);
    await testDb()
      .insert(hashBlocklist)
      .values({ sha256: file.sha256!, reason: "malware", sourceNodeId: file.id });
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: DELETE });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ node: null, purged: true });
    expect(await stillThere(file)).toEqual({ row: false, object: false });
    const purge = await auditOf("system.purge", file.id);
    expect(purge).toHaveLength(1);
    expect(purge[0]).toMatchObject({ actorUserId: who.id, actorType: "admin" });
    const own = await auditOf("admin.node_purged", file.id);
    expect(own).toHaveLength(1);
    expect(own[0]!.meta).toMatchObject({ reason: DELETE.note });
    expect(await blocklistRow(file.sha256!)).toMatchObject({ reason: "malware" });
  });

  it("a reason is required (400, nothing deleted)", async () => {
    const who = await admin();
    const owner = await member();
    const file = await storedFile(owner.id);
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: { action: "delete" } });
    expect(answer.status).toBe(400);
    expect(await stillThere(file)).toEqual({ row: true, object: true });
  });
});
