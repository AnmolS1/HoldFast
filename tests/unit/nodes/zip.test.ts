// The zip manifest: what a zip of these nodes would hold. No URLs — those are minted lazily, a
// window at a time (download-urls, tested with the mints).
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ZIP_MAX_ENTRIES } from "../../../src/shared/constants";
import { ZipManifest } from "../../../src/shared/schemas/node";
import { zipManifest } from "../../../src/worker/db/queries/nodes-api";
import * as schema from "../../../src/worker/db/schema";
import { nodes } from "../../../src/worker/db/schema";
import {
  api,
  makeFile,
  makeFolder,
  makeShare,
  manyFiles,
  person,
  setStatus,
  takeDown,
  testDb,
  uploadedBy,
  type Caller,
} from "./helpers";

const manifest = (caller: Caller, body: unknown) => api(caller, "POST", "/nodes/zip-manifest", { body });

/**
 * owner's tree:   album/                 ← shared with the viewer
 *                   a.txt                clean
 *                   sub/b.txt            clean
 *                   c-pending.bin  d-infected.bin  e-review.bin  f-skipped.bin  g-error.bin
 *                   h-locked.bin         suspected_csam
 *                   i-trashed.bin        in the trash
 *                   old/…                a trashed folder with a clean file in it
 *                   gone/…               a taken-down folder with a clean and a pending file in it
 *                 loose.txt              clean, at the top level
 */
async function album() {
  const owner = await person();
  const viewer = await person();
  const folder = await makeFolder(owner.id, null, { name: "album" });
  const file = (name: string, parentId: string | null, overrides: Parameters<typeof makeFile>[2] = {}) =>
    makeFile(owner.id, parentId, { name, scanStatus: "clean", ...overrides });
  const a = await file("a.txt", folder.id, { size: 11 });
  const sub = await makeFolder(owner.id, folder.id, { name: "sub" });
  const b = await file("b.txt", sub.id, { size: 31 });
  const pending = await file("c-pending.bin", folder.id, { scanStatus: "pending" });
  const infected = await file("d-infected.bin", folder.id, { scanStatus: "infected" });
  const review = await file("e-review.bin", folder.id, { scanStatus: "under_review" });
  const skipped = await file("f-skipped.bin", folder.id, { scanStatus: "skipped" });
  const error = await file("g-error.bin", folder.id, { scanStatus: "error" });
  const locked = await file("h-locked.bin", folder.id);
  await setStatus(locked.id, "suspected_csam");
  const trashed = await file("i-trashed.bin", folder.id, { deletedAt: new Date(), trashedRoot: true });
  const old = await makeFolder(owner.id, folder.id, {
    name: "old",
    deletedAt: new Date(),
    trashedRoot: true,
  });
  const inOld = await file("in-old.txt", old.id);
  const gone = await makeFolder(owner.id, folder.id, { name: "gone" });
  const inGone = await file("in-gone.txt", gone.id);
  const pendingInGone = await file("pending-in-gone.txt", gone.id, { scanStatus: "pending" });
  await takeDown(gone.id);
  const loose = await file("loose.txt", null, { size: 5 });
  await makeShare(folder.id, owner.id, viewer.id);
  const absent = [locked, trashed, old, inOld, gone, inGone, pendingInGone];
  return { owner, viewer, folder, sub, a, b, pending, infected, review, skipped, error, loose, absent };
}

describe("POST /nodes/zip-manifest", () => {
  it("the owner: clean files are entries (path, size, etag, modifiedAt); the rest are skipped, with why", async () => {
    const t = await album();
    const answer = await manifest(t.owner.as, { nodeIds: [t.folder.id] });
    expect(answer.status).toBe(200);
    const body = ZipManifest.parse(answer.body);
    expect(body.entries).toEqual([
      {
        nodeId: t.a.id,
        path: "album/a.txt",
        size: 11,
        etag: t.a.versionId,
        modifiedAt: t.a.updatedAt.toISOString(),
      },
      {
        nodeId: t.b.id,
        path: "album/sub/b.txt",
        size: 31,
        etag: t.b.versionId,
        modifiedAt: t.b.updatedAt.toISOString(),
      },
    ]);
    expect(body.totalBytes).toBe(42);
    expect(body.truncated).toBe(false);
    expect(body.skipped).toEqual([
      { nodeId: t.pending.id, path: "album/c-pending.bin", reason: "scan_pending" },
      { nodeId: t.infected.id, path: "album/d-infected.bin", reason: "scan_blocked" },
      { nodeId: t.review.id, path: "album/e-review.bin", reason: "scan_blocked" },
      { nodeId: t.skipped.id, path: "album/f-skipped.bin", reason: "unscanned" },
      { nodeId: t.error.id, path: "album/g-error.bin", reason: "unscanned" },
    ]);
    // No URLs, no object keys.
    const text = JSON.stringify(answer.body);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toContain(t.a.r2Key!);
  });

  it("a share partner: the same entries; files that are not clean are in neither list — except their own upload", async () => {
    const t = await album();
    const body = ZipManifest.parse((await manifest(t.viewer.as, { nodeIds: [t.folder.id] })).body);
    expect(body.entries.map((entry) => entry.path)).toEqual(["album/a.txt", "album/sub/b.txt"]);
    expect(body.skipped).toEqual([]);
    const text = JSON.stringify(body);
    for (const node of [t.pending, t.infected, t.review, t.skipped, t.error]) {
      expect(text, node.name).not.toContain(node.id);
      expect(text, node.name).not.toContain(node.name);
    }

    // What the partner uploaded themselves is listed as skipped, with why — never a file under review.
    for (const node of [t.pending, t.infected, t.review, t.error]) await uploadedBy(node.id, t.viewer.id);
    const own = ZipManifest.parse((await manifest(t.viewer.as, { nodeIds: [t.folder.id] })).body);
    expect(own.entries.map((entry) => entry.path)).toEqual(["album/a.txt", "album/sub/b.txt"]);
    expect(own.skipped.map((entry) => [entry.path, entry.reason])).toEqual([
      ["album/c-pending.bin", "scan_pending"],
      ["album/d-infected.bin", "scan_blocked"],
      ["album/g-error.bin", "scan_blocked"],
    ]);
    // The owner's manifest is what it was.
    const owners = ZipManifest.parse((await manifest(t.owner.as, { nodeIds: [t.folder.id] })).body);
    expect(owners.skipped).toHaveLength(5);
  });

  it("files a partner cannot see do not count: neither against the cap nor towards truncated", async () => {
    const owner = await person();
    const partner = await person();
    const folder = await makeFolder(owner.id, null, { name: "counted" });
    for (let i = 0; i < 5; i++)
      await makeFile(owner.id, folder.id, { name: `a-${i}.bin`, scanStatus: "pending" });
    for (let i = 0; i < 4; i++)
      await makeFile(owner.id, folder.id, { name: `b-${i}.bin`, scanStatus: "clean" });
    const partnerView = await zipManifest(testDb(), [{ id: folder.id, label: "counted", owner: false }], {
      maxFiles: 4,
      partner: { viewerId: partner.id, uploaderSees: ["pending", "infected", "skipped", "error"] },
    });
    expect([partnerView.entries.length, partnerView.skipped.length, partnerView.truncated]).toEqual([
      4,
      0,
      false,
    ]);
  });

  it("a taken-down folder and everything under it, a locked file, the trash: in neither list — also with allOwned", async () => {
    const t = await album();
    for (const body of [{ nodeIds: [t.folder.id] }, { allOwned: true }]) {
      const answer = await manifest(t.owner.as, body);
      const text = JSON.stringify(answer.body);
      for (const node of t.absent) {
        expect(text, node.name).not.toContain(node.id);
        expect(text, node.name).not.toContain(node.name);
      }
      // The control: its visible siblings are there.
      expect(text).toContain(t.a.id);
      expect(text).toContain(t.pending.id);
    }
  });

  it("allOwned is the caller's whole tree — theirs, not one that is shared with them; a hidden or trashed root is left out", async () => {
    const t = await album();
    const downRoot = await makeFolder(t.owner.id, null, { name: "down-root" });
    const inDownRoot = await makeFile(t.owner.id, downRoot.id, { scanStatus: "clean" });
    await takeDown(downRoot.id);
    const trashedRoot = await makeFile(t.owner.id, null, {
      scanStatus: "clean",
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const avatar = await makeFile(t.owner.id, null, { scanStatus: "clean", system: "avatar" });

    const mine = ZipManifest.parse((await manifest(t.owner.as, { allOwned: true })).body);
    expect(mine.entries.map((entry) => entry.path)).toEqual(["album/a.txt", "album/sub/b.txt", "loose.txt"]);
    expect(mine.skipped).toHaveLength(5);
    const text = JSON.stringify(mine);
    for (const node of [downRoot, inDownRoot, trashedRoot, avatar]) expect(text).not.toContain(node.id);

    const theirs = await manifest(t.viewer.as, { allOwned: true });
    expect(theirs.body).toEqual({ entries: [], totalBytes: 0, skipped: [], truncated: false });
  });

  it("either a list of 1–100 nodes or allOwned: true — never both, never neither", async () => {
    const t = await album();
    const ids = (count: number) => Array.from({ length: count }, () => crypto.randomUUID());
    for (const body of [
      { allOwned: true, nodeIds: [t.folder.id] },
      { allOwned: true, nodeIds: [] },
      {},
      { allOwned: false },
      { nodeIds: [] },
      { nodeIds: ids(101) },
      { nodeIds: ["album"] },
      { nodeIds: [t.folder.id], urls: true },
    ]) {
      const answer = await manifest(t.owner.as, body);
      expect([answer.status, answer.body.error], JSON.stringify(body).slice(0, 60)).toEqual([
        400,
        "validation",
      ]);
    }
    expect((await manifest(t.owner.as, { nodeIds: [t.folder.id], allOwned: false })).status).toBe(200);
  });

  it("a file without a current version is in neither list: no URL would be minted for it", async () => {
    const owner = await person();
    const folder = await makeFolder(owner.id, null, { name: "versions" });
    const whole = await makeFile(owner.id, folder.id, { name: "whole.txt", scanStatus: "clean" });
    const clean = await makeFile(owner.id, folder.id, { name: "no-version.txt", scanStatus: "clean" });
    const pending = await makeFile(owner.id, folder.id, {
      name: "no-version-yet.txt",
      scanStatus: "pending",
    });
    for (const node of [clean, pending]) {
      await testDb().update(nodes).set({ versionId: null, r2Key: null }).where(eq(nodes.id, node.id));
    }
    const body = ZipManifest.parse((await manifest(owner.as, { nodeIds: [folder.id] })).body);
    expect(body.entries.map((entry) => entry.nodeId)).toEqual([whole.id]);
    expect(body.skipped).toEqual([]);
    // What the batch answers for them, and why they must not be entries.
    const urls = await api(owner.as, "POST", "/nodes/download-urls", { body: { nodeIds: [clean.id] } });
    expect(urls.body.items).toEqual([{ nodeId: clean.id, error: "not_found" }]);
  });

  it("role ≥ viewer on EVERY root: one root the caller cannot see refuses the whole manifest", async () => {
    const t = await album();
    const answer = await manifest(t.viewer.as, { nodeIds: [t.folder.id, t.loose.id] });
    expect([answer.status, answer.body.error]).toEqual([404, "not_found"]);
    expect(JSON.stringify(answer.body)).not.toContain("a.txt");
    const unknown = await manifest(t.owner.as, { nodeIds: [t.folder.id, crypto.randomUUID()] });
    expect(unknown.status).toBe(404);
  });

  it("stops at the first root that is refused: 100 unknown ids cost what one costs", async () => {
    const t = await album();
    const ids = (count: number) => Array.from({ length: count }, () => crypto.randomUUID());
    const one = await manifest(t.viewer.as, { nodeIds: ids(1) });
    const hundred = await manifest(t.viewer.as, { nodeIds: ids(100) });
    expect([one.status, hundred.status]).toEqual([404, 404]);
    expect(one.statements).toBeGreaterThan(0);
    expect(hundred.statements).toBe(one.statements);
    // A refusal in the middle: what came before it was asked, what comes after is not.
    const middle = await manifest(t.owner.as, { nodeIds: [t.folder.id, crypto.randomUUID(), ...ids(50)] });
    const first = await manifest(t.owner.as, { nodeIds: [t.folder.id, crypto.randomUUID()] });
    expect(middle.status).toBe(404);
    expect(middle.statements).toBe(first.statements);
  });

  it("a file as a root is its own entry; two roots of one name get distinct paths; a file reached twice is listed once", async () => {
    const owner = await person();
    const one = await makeFolder(owner.id);
    const two = await makeFolder(owner.id);
    const first = await makeFile(owner.id, one.id, { name: "Report.txt", scanStatus: "clean" });
    const second = await makeFile(owner.id, two.id, { name: "report.TXT", scanStatus: "clean" });
    const flat = ZipManifest.parse(
      (await manifest(owner.as, { nodeIds: [first.id, second.id, first.id] })).body,
    );
    expect(flat.entries.map((entry) => [entry.nodeId, entry.path])).toEqual([
      [first.id, "Report.txt"],
      [second.id, "report (2).TXT"],
    ]);

    const folder = await makeFolder(owner.id, null, { name: "docs" });
    const inside = await makeFile(owner.id, folder.id, { name: "inside.txt", scanStatus: "clean" });
    const both = ZipManifest.parse((await manifest(owner.as, { nodeIds: [inside.id, folder.id] })).body);
    expect(both.entries.map((entry) => [entry.nodeId, entry.path])).toEqual([[inside.id, "docs/inside.txt"]]);
  });

  it(`at most ${ZIP_MAX_ENTRIES} entries: one more sets truncated, and is not an error`, async () => {
    const owner = await person();
    const folder = await makeFolder(owner.id, null, { name: "big" });
    await manyFiles(owner.id, folder.id, ZIP_MAX_ENTRIES);
    const full = await manifest(owner.as, { nodeIds: [folder.id] });
    expect(full.status).toBe(200);
    expect(full.body.entries).toHaveLength(ZIP_MAX_ENTRIES);
    expect(full.body.truncated).toBe(false);

    await makeFile(owner.id, folder.id, { name: "zz-one-more.bin", scanStatus: "clean" });
    const over = await manifest(owner.as, { nodeIds: [folder.id] });
    expect(over.status).toBe(200);
    const body = ZipManifest.parse(over.body);
    expect(body.entries).toHaveLength(ZIP_MAX_ENTRIES);
    expect(body.truncated).toBe(true);
    expect(body.entries.map((entry) => entry.path)).not.toContain("big/zz-one-more.bin");
    expect(body.totalBytes).toBe(body.entries.reduce((sum, entry) => sum + entry.size, 0));
  });

  it("the cap counts entries only: skipped files neither use it up nor set truncated", async () => {
    const owner = await person();
    const folder = await makeFolder(owner.id, null, { name: "mixed" });
    // Six files that are skipped sort BEFORE the eight clean ones.
    for (let i = 0; i < 6; i++)
      await makeFile(owner.id, folder.id, { name: `a-pending-${i}.bin`, scanStatus: "pending" });
    for (let i = 0; i < 8; i++)
      await makeFile(owner.id, folder.id, { name: `b-clean-${i}.bin`, scanStatus: "clean" });
    const roots = [{ id: folder.id, label: "mixed", owner: true }];

    const exact = await zipManifest(testDb(), roots, { maxFiles: 8 });
    expect([exact.entries.length, exact.skipped.length, exact.truncated]).toEqual([8, 6, false]);
    const over = await zipManifest(testDb(), roots, { maxFiles: 7 });
    expect([over.entries.length, over.skipped.length, over.truncated]).toEqual([7, 6, true]);
    expect(over.totalBytes).toBe(over.entries.reduce((sum, entry) => sum + entry.size, 0));
  });

  describe("bounded before it walks", () => {
    // A second handle on the same database that records what it sends, so the plan that is
    // checked is the plan of the statement the manifest really sent.
    const sent: { text: string; params: unknown[] }[] = [];
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
    const recording = drizzle(pool, {
      schema,
      casing: "snake_case",
      logger: { logQuery: (text, params) => void sent.push({ text, params }) },
    });
    afterAll(() => pool.end());

    type Plan = { "Node Type": string; "Actual Rows"?: number; Plans?: Plan[] };
    const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];

    it("a tree far larger than the bound is read up to the bound and no further; the answer says truncated", async () => {
      const owner = await person();
      const folder = await makeFolder(owner.id, null, { name: "huge" });
      for (let i = 0; i < 3; i++) {
        const sub = await makeFolder(owner.id, folder.id, { name: `part ${i}` });
        await manyFiles(owner.id, sub.id, 1_000);
      }
      const roots = [{ id: folder.id, label: "huge", owner: true }];
      sent.length = 0;
      const cut = await zipManifest(recording, roots, { maxFiles: 100, maxWalked: 250 });
      expect(cut.truncated).toBe(true);
      expect(cut.entries.length).toBeGreaterThan(0);
      expect(cut.entries.length).toBeLessThanOrEqual(100);

      const statement = sent[sent.length - 1]!;
      const explained = await pool.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        statement.params,
      );
      const plan = flatten((explained.rows[0] as { "QUERY PLAN": { Plan: Plan }[] })["QUERY PLAN"][0]!.Plan);
      const recursion = plan.filter((node) => node["Node Type"] === "Recursive Union");
      // Two recursions: the walk down, and the roots' walk up to their ancestors. 3,004 rows are
      // in the tree; neither produced more than the bound (+1, to see that there is more).
      expect(recursion.length).toBeGreaterThanOrEqual(1);
      const produced = recursion.map((node) => node["Actual Rows"] ?? Infinity);
      expect(Math.max(...produced)).toBeLessThanOrEqual(251);
      expect(Math.max(...produced)).toBeGreaterThan(100);

      // And the walk is lookups — a root by its id, a folder's children by their parent — not a
      // join the planner is free to run as "every row against every row".
      expect(plan.filter((node) => "Join Filter" in node)).toEqual([]);
      expect(plan.map((node) => node["Node Type"])).not.toContain("Seq Scan");

      // The control: with room for the whole tree, the same call reads all of it.
      const whole = await zipManifest(testDb(), roots, { maxFiles: 5_000, maxWalked: 5_000 });
      expect(whole.truncated).toBe(false);
      expect(whole.entries).toHaveLength(3_000);
    });

    it("the upper levels come first: files at the top are answered before files deep in the tree", async () => {
      const owner = await person();
      const folder = await makeFolder(owner.id, null, { name: "levels" });
      const top = await makeFile(owner.id, folder.id, { name: "top.txt", scanStatus: "clean" });
      const deep = await makeFolder(owner.id, folder.id, { name: "a-deep" });
      await manyFiles(owner.id, deep.id, 300);
      const answer = await zipManifest(testDb(), [{ id: folder.id, label: "levels", owner: true }], {
        maxFiles: 100,
        maxWalked: 50,
      });
      expect(answer.truncated).toBe(true);
      expect(answer.entries.map((entry) => entry.nodeId)).toContain(top.id);
    });
  });
});
