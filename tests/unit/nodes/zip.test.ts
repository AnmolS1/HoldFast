// The zip manifest: what a zip of these nodes would hold. No URLs — those are minted lazily, a
// window at a time (download-urls, tested with the mints).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ZIP_MAX_ENTRIES } from "../../../src/shared/constants";
import { ZipManifest } from "../../../src/shared/schemas/node";
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

  it("a share partner: the same entries; what they could not download is blocked, not 'unscanned'", async () => {
    const t = await album();
    const body = ZipManifest.parse((await manifest(t.viewer.as, { nodeIds: [t.folder.id] })).body);
    expect(body.entries.map((entry) => entry.path)).toEqual(["album/a.txt", "album/sub/b.txt"]);
    expect(body.skipped.map((entry) => [entry.path, entry.reason])).toEqual([
      ["album/c-pending.bin", "scan_pending"],
      ["album/d-infected.bin", "scan_blocked"],
      ["album/e-review.bin", "scan_blocked"],
      ["album/f-skipped.bin", "scan_blocked"],
      ["album/g-error.bin", "scan_blocked"],
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
});
