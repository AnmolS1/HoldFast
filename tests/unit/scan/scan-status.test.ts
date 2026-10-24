// POST /api/nodes/scan-status (R1 m16): the scan state of many files in one request, answered as
// `GET /api/nodes/:id` answers each — and every id that route would not answer with a file is left
// out the same way, for the same work (no existence oracle).
import { describe, expect, it } from "vitest";
import { HEADER_USER } from "../../../src/shared/constants";
import { NodeDto, SCAN_STATUS_MAX_IDS, type ScanStatusResponse } from "../../../src/shared/schemas/node";
import { SCAN_BATCH_MAX } from "../../../src/client/features/upload/plan";
import { makeFile, makeFolder, makeShare, testDb } from "../services-core/helpers";
import { call, uploader } from "../uploads/helpers";
import { uuidv7 } from "../../../src/worker/db/ids";
import { nodes } from "../../../src/worker/db/schema";
import { eq } from "drizzle-orm";

type Caller = Awaited<ReturnType<typeof uploader>>;

async function ask(caller: Caller, ids: string[], options: Parameters<typeof call>[3] = {}) {
  const statements = { n: 0 };
  const answer = await call<ScanStatusResponse>(caller, "POST", "/nodes/scan-status", {
    json: { ids },
    statements,
    ...options,
  });
  return { ...answer, statements: statements.n };
}
const idsOf = (answer: { body: ScanStatusResponse }) => answer.body.items.map((item) => item.id).sort();

/**
 * me:     mine-pending.bin, mine-clean.txt, a folder, an avatar, a file taken down, a file in a
 *         taken-down folder, a locked file, a trashed file, a file in a trashed folder
 * owner:  shared/ (shared with me as editor) holding a clean file, a pending file the owner
 *         uploaded, a pending file I uploaded; and a file of theirs that is not shared
 */
async function world() {
  const me = await uploader();
  const owner = await uploader();
  const mine = await makeFile(me.id, null, { scanStatus: "pending" });
  const mineClean = await makeFile(me.id, null, { scanStatus: "clean" });
  const folder = await makeFolder(me.id);
  const avatar = await makeFile(me.id, null, { scanStatus: "clean", system: "avatar" });
  const takenDown = await makeFile(me.id, null, {
    scanStatus: "clean",
    takedownAt: new Date(),
    takedownReason: "abuse",
  });
  const downFolder = await makeFolder(me.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
  const underDown = await makeFile(me.id, downFolder.id, { scanStatus: "clean" });
  const locked = await makeFile(me.id, null, { scanStatus: "suspected_csam", legalHold: true });
  const trashed = await makeFile(me.id, null, {
    scanStatus: "clean",
    deletedAt: new Date(),
    trashedRoot: true,
  });
  const binned = await makeFolder(me.id, null, { deletedAt: new Date(), trashedRoot: true });
  const inBinned = await makeFile(me.id, binned.id, { scanStatus: "clean", deletedAt: new Date() });

  const shared = await makeFolder(owner.id);
  await makeShare(shared.id, owner.id, me.id, { role: "editor" });
  const sharedClean = await makeFile(owner.id, shared.id, { scanStatus: "clean" });
  const ownersPending = await makeFile(owner.id, shared.id, { scanStatus: "pending" });
  const myUploadThere = await makeFile(owner.id, shared.id, { scanStatus: "pending", createdBy: me.id });
  const foreign = await makeFile(owner.id, null, { scanStatus: "clean" });
  return {
    me,
    owner,
    visible: { mine, mineClean, sharedClean, myUploadThere },
    absent: {
      unknown: { id: uuidv7() },
      foreign,
      folder,
      avatar,
      takenDown,
      underDown,
      locked,
      trashed,
      inBinned,
      ownersPending,
    },
  };
}

describe("what it answers", () => {
  it("my files and the shared files I may see, each as GET /api/nodes/:id sends it", async () => {
    const w = await world();
    const ids = Object.values(w.visible).map((node) => node.id);
    const answer = await ask(w.me, ids);
    expect(answer.status).toBe(200);
    expect(idsOf(answer)).toEqual([...ids].sort());
    for (const item of answer.body.items) {
      expect(NodeDto.safeParse(item).success).toBe(true);
      const detail = await call<{ node: NodeDto }>(w.me, "GET", `/nodes/${item.id}`);
      expect(item).toEqual(detail.body.node);
    }
  });

  it("a repeated id is answered once", async () => {
    const w = await world();
    const answer = await ask(w.me, [w.visible.mine.id, w.visible.mine.id]);
    expect(idsOf(answer)).toEqual([w.visible.mine.id]);
  });
});

describe("no existence oracle: every id GET /api/nodes/:id would not answer is left out alike", () => {
  it("unknown, someone else's, a folder, an avatar, taken down (itself / a folder above), locked, trashed (itself / a folder above), a partner's pending file: the same bytes and the same statements", async () => {
    const w = await world();
    const baseline = await ask(w.me, [w.absent.unknown.id]);
    expect(baseline.status).toBe(200);
    expect(baseline.body).toEqual({ items: [] });
    for (const [label, node] of Object.entries(w.absent)) {
      const alone = await ask(w.me, [node.id]);
      expect(alone.bytes, label).toBe(baseline.bytes);
      expect(alone.statements, label).toBe(baseline.statements);
      // Next to a visible file: the same answer as next to an id that was never issued.
      const mixed = await ask(w.me, [w.visible.mine.id, node.id]);
      const control = await ask(w.me, [w.visible.mine.id, uuidv7()]);
      expect(mixed.bytes, label).toBe(control.bytes);
      expect(mixed.statements, label).toBe(control.statements);
    }
  });

  it("CONTROL: the same ids, made visible, are answered (the test can tell)", async () => {
    const w = await world();
    await testDb()
      .update(nodes)
      .set({ takedownAt: null, takedownReason: null })
      .where(eq(nodes.id, w.absent.takenDown.id));
    expect(idsOf(await ask(w.me, [w.absent.takenDown.id]))).toEqual([w.absent.takenDown.id]);
    expect(idsOf(await ask(w.owner, [w.absent.foreign.id]))).toEqual([w.absent.foreign.id]);
  });
});

describe("bounds and the request's guards", () => {
  it("the upload ribbon's batch is the server's limit", () => {
    expect(SCAN_BATCH_MAX).toBe(SCAN_STATUS_MAX_IDS);
  });

  it(`1 … ${SCAN_STATUS_MAX_IDS} well-formed ids; anything else is 400 validation`, async () => {
    const me = await uploader();
    const many = Array.from({ length: SCAN_STATUS_MAX_IDS }, () => uuidv7());
    expect((await ask(me, many)).status).toBe(200);
    for (const ids of [[], [...many, uuidv7()], ["not-an-id"]]) {
      const answer = await ask(me, ids);
      expect(answer.status, JSON.stringify(ids).slice(0, 40)).toBe(400);
      expect(answer.body).toMatchObject({ error: "validation" });
    }
  });

  it("a hundred of my own files cost a handful of statements, not one round of the access check each", async () => {
    const me = await uploader();
    const one = await makeFile(me.id, null, { scanStatus: "pending" });
    const few = await ask(me, [one.id]);
    const files = [one];
    for (let n = 1; n < 30; n++) files.push(await makeFile(me.id, null, { scanStatus: "pending" }));
    const all = await ask(
      me,
      files.map((file) => file.id),
    );
    expect(all.body.items).toHaveLength(30);
    expect(all.statements).toBe(few.statements);
  });

  it("signed out: 401; the identity pin: another account's header is refused", async () => {
    const me = await uploader();
    const other = await uploader();
    expect((await call(null, "POST", "/nodes/scan-status", { json: { ids: [uuidv7()] } })).status).toBe(401);
    const pinned = await ask(me, [uuidv7()], { headers: { [HEADER_USER]: other.id } });
    expect(pinned.status).toBe(403);
    expect(pinned.body).toMatchObject({ details: { reason: "identity_mismatch" } });
    expect((await ask(me, [uuidv7()], { headers: { [HEADER_USER]: me.id } })).status).toBe(200);
  });

  it("behind RL_API: a refused limit is 429", async () => {
    const me = await uploader();
    const refuse = { limit: async () => ({ success: false }) };
    expect((await ask(me, [uuidv7()], { env: { RL_API: refuse } })).status).toBe(429);
  });
});
