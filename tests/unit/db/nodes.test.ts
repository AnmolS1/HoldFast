import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { QueryError } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  createFolder,
  findByR2Key,
  getNode,
  keyReference,
  listChildren,
  listRecent,
  listStarred,
  move,
  type NodeSort,
  OWNER_VISIBLE_STATUSES,
  rename,
  replaceVersion,
  requestRescan,
  resetToPending,
  setScanResult,
  setStar,
  sharingSummary,
  type SortDir,
  touchAccessed,
} from "../../../src/worker/db/queries/nodes";
import { type Node, nodes, nodeVersions, type ScanStatus, user } from "../../../src/worker/db/schema";
import {
  makeFile,
  makeFolder,
  makeLink,
  makeShare,
  makeUpload,
  makeUser,
  openDb,
  rand,
  rejection,
} from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const OWNER = OWNER_VISIBLE_STATUSES;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(QueryError);
  expect((error as QueryError).code).toBe(code);
}

async function allPages(
  args: Omit<Parameters<typeof listChildren>[1], "cursor" | "limit">,
  pageSize: number,
  between?: (page: number) => Promise<void>,
): Promise<Node[]> {
  const out: Node[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await listChildren(db, { ...args, cursor, limit: pageSize });
    expect(result.items.length).toBeLessThanOrEqual(pageSize);
    out.push(...result.items);
    if (!result.nextCursor) return out;
    cursor = result.nextCursor;
    if (between) await between(page);
  }
  throw new Error("listing did not end");
}

describe("listChildren: visibility", () => {
  it("hides avatars, taken-down and trashed rows, and whatever visibleStatuses leaves out", async () => {
    const owner = await makeUser(db);
    const parent = await makeFolder(db, owner, null, `p-${rand()}`);
    const statuses: ScanStatus[] = [
      "pending",
      "clean",
      "infected",
      "suspected_csam",
      "under_review",
      "skipped",
      "error",
    ];
    const byStatus = new Map<ScanStatus, Node>();
    for (const status of statuses)
      byStatus.set(status, await makeFile(db, owner, parent.id, `${status}.bin`, { scanStatus: status }));
    const sub = await makeFolder(db, owner, parent.id, "sub");
    await makeFile(db, owner, parent.id, "avatar", { system: "avatar" });
    await makeFile(db, owner, parent.id, "taken-down.bin", {
      takedownAt: new Date(),
      takedownReason: "dmca",
    });
    await makeFile(db, owner, parent.id, "trashed.bin", { deletedAt: new Date(), trashedRoot: true });

    const base = {
      scope: { ownerId: owner },
      parentId: parent.id,
      sort: "name",
      dir: "asc",
      limit: 100,
    } as const;

    const ownerView = await listChildren(db, { ...base, visibleStatuses: OWNER });
    expect(ownerView.items.map((n) => n.name)).toEqual([
      "sub",
      "clean.bin",
      "error.bin",
      "infected.bin",
      "pending.bin",
      "skipped.bin",
      "under_review.bin",
    ]);
    expect(ownerView.items.map((n) => n.id)).not.toContain(byStatus.get("suspected_csam")!.id);
    expect(ownerView.nextCursor).toBeNull();

    const linkView = await listChildren(db, { ...base, visibleStatuses: ["clean"] });
    expect(linkView.items.map((n) => n.id)).toEqual([sub.id, byStatus.get("clean")!.id]);

    expect((await listChildren(db, { ...base, visibleStatuses: [] })).items).toEqual([]);
    // Only an admin-style list that names it shows the quarantined row.
    const admin = await listChildren(db, { ...base, visibleStatuses: ["suspected_csam"] });
    expect(admin.items.map((n) => n.id)).toEqual([byStatus.get("suspected_csam")!.id]);
  });

  it("filters by kind, and lists the owner's top level with parentId null", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const folder = await makeFolder(db, owner, null, "Folder");
    const file = await makeFile(db, owner, null, "file.txt");
    await makeFile(db, owner, folder.id, "inner.txt");
    await makeFolder(db, other, null, "Foreign");

    const base = {
      scope: { ownerId: owner },
      parentId: null,
      sort: "name",
      dir: "asc",
      limit: 50,
      visibleStatuses: OWNER,
    } as const;
    expect((await listChildren(db, base)).items.map((n) => n.id)).toEqual([folder.id, file.id]);
    expect((await listChildren(db, { ...base, kind: "file" })).items.map((n) => n.id)).toEqual([file.id]);
    expect((await listChildren(db, { ...base, kind: "folder" })).items.map((n) => n.id)).toEqual([folder.id]);
    // Another owner's id as scope shows nothing of this folder.
    expect(
      (await listChildren(db, { ...base, scope: { ownerId: other }, parentId: folder.id })).items,
    ).toEqual([]);
    expect((await listChildren(db, { ...base, parentId: "not-a-uuid" })).items).toEqual([]);
  });
});

describe("listChildren: the four keysets", () => {
  async function seeded() {
    const owner = await makeUser(db);
    const parent = await makeFolder(db, owner, null, `k-${rand()}`);
    const base = Date.UTC(2026, 0, 1);
    const names = [
      "delta.txt",
      "alpha.png",
      "charlie",
      "bravo.txt",
      "echo.png",
      "foxtrot.md",
      "golf.txt",
      "hotel",
    ];
    for (let i = 0; i < names.length; i++) {
      const file = await makeFile(db, owner, parent.id, names[i]!, {
        size: [500, 100, 300, 100, 400, 100, 200, 300][i],
      });
      // Ties on purpose, and sub-millisecond differences that a JS Date would lose.
      const stamp = new Date(base + Math.floor(i / 3) * 1000).toISOString();
      await db
        .update(nodes)
        .set({ updatedAt: sql`${stamp}::timestamptz + make_interval(secs => ${(i % 3) / 1_000_000})` })
        .where(eq(nodes.id, file.id));
    }
    for (const name of ["zulu", "yankee", "xray"]) await makeFolder(db, owner, parent.id, name);
    return { owner, parent };
  }

  const sorts: NodeSort[] = ["name", "size", "updated", "kind"];
  const dirs: SortDir[] = ["asc", "desc"];

  for (const sort of sorts) {
    for (const dir of dirs) {
      it(`${sort} ${dir}: pages add up to the one-page listing, folders first, no row twice`, async () => {
        const { owner, parent } = await seeded();
        const args = {
          scope: { ownerId: owner },
          parentId: parent.id,
          sort,
          dir,
          visibleStatuses: OWNER,
        } as const;
        const whole = (await listChildren(db, { ...args, limit: 200 })).items;
        expect(whole).toHaveLength(11);
        expect(whole.slice(0, 3).every((n) => n.kind === "folder")).toBe(true);
        expect(whole.slice(3).every((n) => n.kind === "file")).toBe(true);

        const files = whole.slice(3);
        const key = (n: Node): (string | number)[] =>
          sort === "name"
            ? [n.nameKey]
            : sort === "size"
              ? [n.size]
              : sort === "kind"
                ? [n.ext, n.nameKey]
                : [];
        if (sort !== "updated") {
          for (let i = 1; i < files.length; i++) {
            const a = [...key(files[i - 1]!), files[i - 1]!.id];
            const b = [...key(files[i]!), files[i]!.id];
            const firstDiff = a.findIndex((v, n) => v !== b[n]);
            const ordered = a[firstDiff]! < b[firstDiff]!;
            expect(ordered, `${files[i - 1]!.name} before ${files[i]!.name}`).toBe(dir === "asc");
          }
        } else {
          const times = files.map((n) => n.updatedAt.getTime());
          expect(times).toEqual([...times].sort((x, y) => (dir === "asc" ? x - y : y - x)));
        }

        for (const pageSize of [1, 2, 3, 4, 11]) {
          const paged = await allPages(args, pageSize);
          expect(
            paged.map((n) => n.id),
            `page size ${pageSize}`,
          ).toEqual(whole.map((n) => n.id));
        }
      });

      it(`${sort} ${dir}: rows inserted between pages never duplicate or drop an existing row`, async () => {
        const { owner, parent } = await seeded();
        const args = {
          scope: { ownerId: owner },
          parentId: parent.id,
          sort,
          dir,
          visibleStatuses: OWNER,
        } as const;
        const before = (await listChildren(db, { ...args, limit: 200 })).items.map((n) => n.id);
        const paged = await allPages(args, 2, async (page) => {
          // Concurrent inserts at both ends of every order, files and folders — on the first
          // pages only: a listing that grows at its end by a page per page read never ends.
          if (page >= 4) return;
          await Promise.all([
            makeFile(db, owner, parent.id, `aaa-${page}.aaa`, {
              size: 1,
              updatedAt: new Date(Date.UTC(2020, 0, 1)),
            }),
            makeFile(db, owner, parent.id, `zzz-${page}.zzz`, {
              size: 999_999,
              updatedAt: new Date(Date.UTC(2030, 0, 1)),
            }),
            makeFolder(db, owner, parent.id, `aaa-folder-${page}`),
            makeFolder(db, owner, parent.id, `zzzz-folder-${page}`),
          ]);
        });
        const ids = paged.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.filter((id) => before.includes(id))).toEqual(before);
      });
    }
  }

  it("rejects a cursor from another sort, direction, folder or listing, and garbage", async () => {
    const { owner, parent } = await seeded();
    const other = await makeFolder(db, owner, null, `o-${rand()}`);
    await makeFile(db, owner, other.id, "a.txt");
    await makeFile(db, owner, other.id, "b.txt");
    const args = {
      scope: { ownerId: owner },
      parentId: parent.id,
      sort: "name",
      dir: "asc",
      visibleStatuses: OWNER,
      limit: 2,
    } as const;
    const first = await listChildren(db, args);
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = first.nextCursor!;

    expect((await listChildren(db, { ...args, cursor })).items).toHaveLength(2);
    await expectCode(listChildren(db, { ...args, sort: "size", cursor }), "validation");
    await expectCode(listChildren(db, { ...args, dir: "desc", cursor }), "validation");
    await expectCode(listChildren(db, { ...args, parentId: other.id, cursor }), "validation");
    await expectCode(listChildren(db, { ...args, parentId: null, cursor }), "validation");
    // The cursor's last row is a folder; a files-only listing cannot continue from it.
    await expectCode(listChildren(db, { ...args, kind: "file", cursor }), "validation");
    await expectCode(listChildren(db, { ...args, cursor: "not-base64-json" }), "validation");
    await expectCode(
      listChildren(db, { ...args, cursor: Buffer.from('{"t":"nodes","v":{}}').toString("base64url") }),
      "validation",
    );
    await expectCode(listStarred(db, owner, { cursor, limit: 2, visibleStatuses: OWNER }), "validation");
    await expectCode(listChildren(db, { ...args, limit: 0 }), "validation");
  });
});

describe("listRecent and listStarred", () => {
  it("listRecent: own files that were opened, newest first, with the listing exclusions", async () => {
    const owner = await makeUser(db);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const folder = await makeFolder(db, owner, null, "f", { lastAccessedAt: at(1) });
    const newest = await makeFile(db, owner, folder.id, "newest.txt", { lastAccessedAt: at(2) });
    const older = await makeFile(db, owner, null, "older.txt", { lastAccessedAt: at(30) });
    await makeFile(db, owner, null, "never-opened.txt");
    await makeFile(db, owner, null, "avatar", { system: "avatar", lastAccessedAt: at(1) });
    await makeFile(db, owner, null, "down.txt", { takedownAt: new Date(), lastAccessedAt: at(1) });
    await makeFile(db, owner, null, "csam.bin", { scanStatus: "suspected_csam", lastAccessedAt: at(1) });
    const bin = await makeFolder(db, owner, null, "bin", { deletedAt: new Date(), trashedRoot: true });
    await makeFile(db, owner, bin.id, "in-trashed-folder.txt", { lastAccessedAt: at(1) });
    await makeFile(db, owner, null, "trashed.txt", {
      deletedAt: new Date(),
      trashedRoot: true,
      lastAccessedAt: at(1),
    });

    const recent = await listRecent(db, owner, { limit: 50, visibleStatuses: OWNER });
    expect(recent.map((n) => n.id)).toEqual([newest.id, older.id]);
    expect((await listRecent(db, owner, { limit: 1, visibleStatuses: OWNER })).map((n) => n.id)).toEqual([
      newest.id,
    ]);
    expect(await listRecent(db, owner, { limit: 10, visibleStatuses: [] })).toEqual([]);
  });

  it("listStarred: keyset over the owner's starred nodes, folders first, nothing hidden or trashed", async () => {
    const owner = await makeUser(db);
    const expected: string[] = [];
    const folders = [];
    for (const name of ["beta", "alpha"])
      folders.push(await makeFolder(db, owner, null, name, { starred: true }));
    expected.push(folders[1]!.id, folders[0]!.id);
    const files = [];
    for (const name of ["d.txt", "b.txt", "c.txt", "a.txt", "e.txt"])
      files.push(await makeFile(db, owner, folders[0]!.id, name, { starred: true }));
    expected.push(files[3]!.id, files[1]!.id, files[2]!.id, files[0]!.id, files[4]!.id);
    await makeFile(db, owner, null, "not-starred.txt");
    await makeFile(db, owner, null, "avatar", { system: "avatar", starred: true });
    await makeFile(db, owner, null, "down.txt", { takedownAt: new Date(), starred: true });
    await makeFile(db, owner, null, "csam.bin", { scanStatus: "suspected_csam", starred: true });
    const bin = await makeFolder(db, owner, null, "bin", { deletedAt: new Date(), trashedRoot: true });
    await makeFile(db, owner, bin.id, "in-trash.txt", { starred: true });

    const all: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listStarred(db, owner, { cursor, limit: 3, visibleStatuses: OWNER });
      all.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(all).toEqual(expected);
  });
});

describe("createFolder, rename, move", () => {
  it("createFolder writes name, key and owner/creator, and reports collisions as conflict — at the root too", async () => {
    const owner = await makeUser(db);
    const editor = await makeUser(db);
    const top = await createFolder(db, {
      ownerId: owner,
      createdBy: owner,
      parentId: null,
      name: "  Projects ",
    });
    expect(top).toMatchObject({
      name: "Projects",
      nameKey: "projects",
      ext: "",
      kind: "folder",
      scanStatus: "clean",
      parentId: null,
    });
    await expectCode(
      createFolder(db, { ownerId: owner, createdBy: owner, parentId: null, name: "PROJECTS" }),
      "conflict",
    );

    const inner = await createFolder(db, {
      ownerId: owner,
      createdBy: editor,
      parentId: top.id,
      name: "2026",
    });
    expect(inner).toMatchObject({ ownerId: owner, createdBy: editor, parentId: top.id });
    await expectCode(
      createFolder(db, { ownerId: owner, createdBy: editor, parentId: top.id, name: "2026" }),
      "conflict",
    );

    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b"]) {
      await expectCode(
        createFolder(db, { ownerId: owner, createdBy: owner, parentId: null, name: bad }),
        "validation",
      );
    }
    const file = await makeFile(db, owner, null, "a-file.txt");
    await expectCode(
      createFolder(db, { ownerId: owner, createdBy: owner, parentId: file.id, name: "x" }),
      "not_found",
    );
    await expectCode(
      createFolder(db, { ownerId: editor, createdBy: editor, parentId: top.id, name: "x" }),
      "not_found",
    );
    await expectCode(
      createFolder(db, { ownerId: owner, createdBy: owner, parentId: uuidv7(), name: "x" }),
      "not_found",
    );
  });

  it("a collision inside a caller's transaction does not abort that transaction", async () => {
    const owner = await makeUser(db);
    await createFolder(db, { ownerId: owner, createdBy: owner, parentId: null, name: "dup" });
    await db.transaction(async (tx) => {
      await expectCode(
        createFolder(tx, { ownerId: owner, createdBy: owner, parentId: null, name: "dup" }),
        "conflict",
      );
      const ok = await createFolder(tx, { ownerId: owner, createdBy: owner, parentId: null, name: "after" });
      expect(ok.name).toBe("after");
    });
    expect(
      (
        await listChildren(db, {
          scope: { ownerId: owner },
          parentId: null,
          sort: "name",
          dir: "asc",
          limit: 10,
          visibleStatuses: OWNER,
        })
      ).items.map((n) => n.name),
    ).toEqual(["after", "dup"]);
  });

  it("rename rewrites name, nameKey and ext together and keeps the object", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, "Draft.TXT");
    expect(file.ext).toBe("txt");
    const renamed = await rename(db, file.id, "Final Report.PDF");
    expect(renamed).toMatchObject({
      name: "Final Report.PDF",
      nameKey: "final report.pdf",
      ext: "pdf",
      r2Key: file.r2Key,
      versionId: file.versionId,
    });
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(file.updatedAt.getTime());
    const folder = await makeFolder(db, owner, null, "docs");
    expect((await rename(db, folder.id, "docs.v2")).ext).toBe("");

    await makeFile(db, owner, null, "taken.txt");
    await expectCode(rename(db, file.id, "TAKEN.txt"), "conflict");
    await expectCode(rename(db, file.id, ".."), "validation");
    await expectCode(rename(db, uuidv7(), "x"), "not_found");
    expect((await getNode(db, file.id))!.name).toBe("Final Report.PDF");
  });

  it("move rejects a cycle, a collision and a foreign or missing target; moves to a folder and to the root", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const a = await makeFolder(db, owner, null, `a-${rand()}`);
    const b = await makeFolder(db, owner, a.id, "b");
    const c = await makeFolder(db, owner, b.id, "c");
    const file = await makeFile(db, owner, a.id, "note.txt");
    const foreign = await makeFolder(db, other, null, "foreign");

    await expectCode(move(db, a.id, a.id), "conflict");
    await expectCode(move(db, a.id, c.id), "conflict");
    await expectCode(move(db, b.id, c.id), "conflict");
    expect((await getNode(db, a.id))!.parentId).toBeNull();

    await makeFile(db, owner, c.id, "NOTE.txt");
    await expectCode(move(db, file.id, c.id), "conflict");
    await expectCode(move(db, file.id, foreign.id), "not_found");
    await expectCode(move(db, file.id, uuidv7()), "not_found");
    await expectCode(move(db, file.id, file.id), "not_found");
    await expectCode(move(db, uuidv7(), a.id), "not_found");
    expect((await getNode(db, file.id))!.parentId).toBe(a.id);

    expect((await move(db, file.id, b.id)).parentId).toBe(b.id);
    expect((await move(db, c.id, null)).parentId).toBeNull();
    expect((await move(db, c.id, null)).parentId).toBeNull();
    // Into the trash is not a move.
    const bin = await makeFolder(db, owner, null, "bin", { deletedAt: new Date(), trashedRoot: true });
    await expectCode(move(db, file.id, bin.id), "not_found");
  });

  it("concurrent moves cannot build a cycle", async () => {
    const owner = await makeUser(db);
    const x = await makeFolder(db, owner, null, `x-${rand()}`);
    const xChild = await makeFolder(db, owner, x.id, "x-child");
    const y = await makeFolder(db, owner, null, `y-${rand()}`);
    const yChild = await makeFolder(db, owner, y.id, "y-child");
    // x under y's child while y goes under x's child: each alone is fine, both together are a cycle.
    const results = await Promise.allSettled([move(db, x.id, yChild.id), move(db, y.id, xChild.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as QueryError).code).toBe("conflict");
    // Every node still reaches a root.
    const reach = await db.execute<{ n: number }>(sql`
      WITH RECURSIVE up(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM nodes WHERE id = ${xChild.id}
        UNION ALL SELECT p.id, p.parent_id, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id WHERE up.depth < 50
      ) SELECT count(*)::int AS n FROM up WHERE parent_id IS NULL`);
    expect(reach.rows[0]!.n).toBe(1);
  });
});

describe("small writes", () => {
  it("setStar", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, "s.txt");
    expect(await setStar(db, file.id, true)).toBe(true);
    expect((await getNode(db, file.id))!.starred).toBe(true);
    expect(await setStar(db, file.id, false)).toBe(true);
    expect((await getNode(db, file.id))!.starred).toBe(false);
    expect(await setStar(db, uuidv7(), true)).toBe(false);
  });

  it("touchAccessed writes at most once per 10 minutes", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, "t.txt");
    expect(await touchAccessed(db, file.id)).toBe(true);
    const first = (await getNode(db, file.id))!.lastAccessedAt!;
    expect(await touchAccessed(db, file.id)).toBe(false);
    expect((await getNode(db, file.id))!.lastAccessedAt!.getTime()).toBe(first.getTime());
    await db
      .update(nodes)
      .set({ lastAccessedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(nodes.id, file.id));
    expect(await touchAccessed(db, file.id)).toBe(true);
    await db
      .update(nodes)
      .set({ lastAccessedAt: new Date(Date.now() - 9 * 60_000) })
      .where(eq(nodes.id, file.id));
    expect(await touchAccessed(db, file.id)).toBe(false);
  });

  it("requestRescan: one per node per hour, taken once under concurrency", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, "r.txt");
    const results = await Promise.all(Array.from({ length: 10 }, () => requestRescan(db, file.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await requestRescan(db, file.id)).toBe(false);
    await db
      .update(nodes)
      .set({ rescanRequestedAt: new Date(Date.now() - 61 * 60_000) })
      .where(eq(nodes.id, file.id));
    expect(await requestRescan(db, file.id)).toBe(true);
    expect(await requestRescan(db, uuidv7())).toBe(false);
  });
});

describe("by-key helpers", () => {
  it("findByR2Key finds the current version only", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `k-${rand()}.bin`);
    const oldKey = `u/${owner}/${file.id}/old`;
    await db
      .insert(nodeVersions)
      .values({ nodeId: file.id, versionId: "old", r2Key: oldKey, size: 1, purgeAfter: new Date() });
    expect((await findByR2Key(db, file.r2Key!))!.id).toBe(file.id);
    expect(await findByR2Key(db, oldKey)).toBeNull();
    expect(await findByR2Key(db, "u/nobody/none/none")).toBeNull();
  });

  it("findByR2Key with forUpdate holds the row until the transaction ends", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `lock-${rand()}.bin`);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const first = db.transaction(async (tx) => {
      expect((await findByR2Key(tx, file.r2Key!, { forUpdate: true }))!.id).toBe(file.id);
      locked();
      await held;
      order.push("first commits");
    });
    await isLocked;
    const second = db.transaction(async (tx) => {
      await findByR2Key(tx, file.r2Key!, { forUpdate: true });
      order.push("second got the lock");
    });
    // A plain read is not blocked; the locking read is.
    expect((await findByR2Key(db, file.r2Key!))!.id).toBe(file.id);
    const raced = await Promise.race([
      second.then(() => "second"),
      new Promise((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(raced).toBe("timeout");
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first commits", "second got the lock"]);
  });

  it("keyReference names what references a key: node, version, unfinished upload — or nothing", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `ref-${rand()}.bin`);
    expect(await keyReference(db, file.r2Key!)).toEqual({
      kind: "node",
      nodeId: file.id,
      versionId: file.versionId,
    });

    const oldKey = `u/${owner}/${file.id}/v-old`;
    await db
      .insert(nodeVersions)
      .values({ nodeId: file.id, versionId: "v-old", r2Key: oldKey, size: 1, purgeAfter: new Date() });
    expect(await keyReference(db, oldKey)).toEqual({ kind: "version", nodeId: file.id, versionId: "v-old" });

    for (const status of ["open", "completing"] as const) {
      const upload = await makeUpload(db, owner, owner, { status });
      expect(await keyReference(db, upload.r2Key)).toEqual({
        kind: "upload",
        nodeId: upload.nodeId,
        versionId: upload.versionId,
      });
    }
    for (const status of ["done", "aborted"] as const) {
      const upload = await makeUpload(db, owner, owner, { status });
      expect(await keyReference(db, upload.r2Key)).toBeNull();
    }
    // A node wins over the session that created it.
    const completing = await makeUpload(db, owner, owner, { status: "completing" });
    const created = await makeFile(db, owner, null, `made-${rand()}.bin`, {
      id: completing.nodeId,
      versionId: completing.versionId,
      r2Key: completing.r2Key,
    });
    expect(await keyReference(db, completing.r2Key)).toEqual({
      kind: "node",
      nodeId: created.id,
      versionId: created.versionId,
    });
    expect(await keyReference(db, "u/none/none/none")).toBeNull();
  });
});

describe("scan results", () => {
  const scannedAt = new Date("2026-02-03T04:05:06.000Z");

  it("setScanResult writes a verdict and resetToPending clears it", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `v-${rand()}.bin`, {
      scanStatus: "pending",
      sha256: "client-hash",
      mimeSniffed: null,
    });
    const written = await setScanResult(db, file.id, {
      scanStatus: "infected",
      scanDetail: { signatures: ["Eicar-Test"], engine: "clamav", dbVersion: "27000", durationMs: 12 },
      mimeSniffed: "application/x-dosexec",
      sha256: "server-hash",
      scannedAt,
    });
    expect(written).toMatchObject({
      scanStatus: "infected",
      scanReason: null,
      scanDetail: { signatures: ["Eicar-Test"], engine: "clamav", dbVersion: "27000", durationMs: 12 },
      mimeSniffed: "application/x-dosexec",
      sha256: "server-hash",
    });
    expect(written!.scannedAt!.getTime()).toBe(scannedAt.getTime());

    // A later verdict without a reason clears the reason; absent mime and hash are kept.
    await setScanResult(db, file.id, { scanStatus: "skipped", scanReason: "size", scannedAt });
    expect(await getNode(db, file.id)).toMatchObject({
      scanStatus: "skipped",
      scanReason: "size",
      scanDetail: null,
      mimeSniffed: "application/x-dosexec",
      sha256: "server-hash",
    });
    await setScanResult(db, file.id, { scanStatus: "clean", scannedAt });
    expect(await getNode(db, file.id)).toMatchObject({ scanStatus: "clean", scanReason: null });

    expect(await resetToPending(db, file.id)).toBe(true);
    expect(await getNode(db, file.id)).toMatchObject({
      scanStatus: "pending",
      scanReason: null,
      scanDetail: null,
      scannedAt: null,
    });
    expect(await setScanResult(db, uuidv7(), { scanStatus: "clean", scannedAt })).toBeNull();
    expect(await resetToPending(db, uuidv7())).toBe(false);
  });

  it("a verdict never weakens suspected_csam, and goes to scanStatusPrev while under review", async () => {
    const owner = await makeUser(db);
    const csam = await makeFile(db, owner, null, `c-${rand()}.bin`, { scanStatus: "suspected_csam" });
    await setScanResult(db, csam.id, { scanStatus: "clean", scannedAt });
    expect(await getNode(db, csam.id)).toMatchObject({ scanStatus: "suspected_csam", scanStatusPrev: null });
    expect(await resetToPending(db, csam.id)).toBe(false);

    const reviewed = await makeFile(db, owner, null, `u-${rand()}.bin`, {
      scanStatus: "under_review",
      scanStatusPrev: "pending",
    });
    await setScanResult(db, reviewed.id, { scanStatus: "skipped", scanReason: "encrypted", scannedAt });
    expect(await getNode(db, reviewed.id)).toMatchObject({
      scanStatus: "under_review",
      scanStatusPrev: "skipped",
      scanReason: "encrypted",
    });
    expect(await resetToPending(db, reviewed.id)).toBe(false);
    await setScanResult(db, reviewed.id, { scanStatus: "suspected_csam", scannedAt });
    expect(await getNode(db, reviewed.id)).toMatchObject({
      scanStatus: "suspected_csam",
      scanStatusPrev: null,
    });
  });
});

describe("replaceVersion", () => {
  const next = (owner: string) => ({
    r2Key: `u/${owner}/x/${rand(8)}`,
    versionId: rand(8),
    size: 250,
    sha256: "new-hash",
    createdBy: owner,
  });

  it("moves the previous version to node_versions for 30 days and starts the new one pending", async () => {
    const owner = await makeUser(db);
    const editor = await makeUser(db);
    const file = await makeFile(db, owner, null, `rep-${rand()}.txt`, {
      size: 100,
      scanStatus: "clean",
      mimeSniffed: "text/plain",
    });
    const replacement = { ...next(owner), createdBy: editor };
    const result = await db.transaction((tx) => replaceVersion(tx, file.id, replacement));
    expect(result).toEqual({ previousVersionId: file.versionId });

    const after = (await getNode(db, file.id))!;
    expect(after).toMatchObject({
      id: file.id,
      name: file.name,
      r2Key: replacement.r2Key,
      versionId: replacement.versionId,
      size: 250,
      sha256: "new-hash",
      createdBy: editor,
      scanStatus: "pending",
      scanReason: null,
      scanDetail: null,
      scannedAt: null,
      mimeSniffed: null,
    });
    const [old] = await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, file.id));
    expect(old).toMatchObject({
      versionId: file.versionId,
      r2Key: file.r2Key,
      size: 100,
      sha256: file.sha256,
      createdBy: owner,
    });
    const days = (old!.purgeAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("is allowed from skipped and error", async () => {
    const owner = await makeUser(db);
    for (const status of ["skipped", "error"] as const) {
      const file = await makeFile(db, owner, null, `ok-${status}-${rand()}.bin`, {
        scanStatus: status,
        scanReason: "timeout",
      });
      await replaceVersion(db, file.id, next(owner));
      expect((await getNode(db, file.id))!.scanStatus).toBe("pending");
    }
  });

  it("refuses every forbidden status, a held node, a held owner, a taken-down node — and changes nothing", async () => {
    const owner = await makeUser(db);
    const heldOwner = await makeUser(db, { legalHold: true });
    const cases: [string, string, Partial<typeof nodes.$inferInsert>][] = [
      ["scan_pending", owner, { scanStatus: "pending" }],
      ["scan_blocked", owner, { scanStatus: "infected" }],
      ["scan_blocked", owner, { scanStatus: "under_review" }],
      ["not_found", owner, { scanStatus: "suspected_csam" }],
      ["not_found", owner, { scanStatus: "clean", legalHold: true }],
      ["not_found", owner, { scanStatus: "clean", takedownAt: new Date(), takedownReason: "dmca" }],
      ["not_found", heldOwner, { scanStatus: "clean" }],
      ["not_found", owner, { scanStatus: "clean", system: "avatar" }],
    ];
    for (const [code, ownerId, overrides] of cases) {
      const file = await makeFile(db, ownerId, null, `no-${rand()}.bin`, overrides);
      await expectCode(replaceVersion(db, file.id, next(ownerId)), code);
      expect(await getNode(db, file.id), JSON.stringify(overrides)).toMatchObject({
        r2Key: file.r2Key,
        versionId: file.versionId,
        size: file.size,
      });
      expect(await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, file.id))).toHaveLength(0);
    }
    const folder = await makeFolder(db, owner, null, `folder-${rand()}`);
    await expectCode(replaceVersion(db, folder.id, next(owner)), "not_found");
    await expectCode(replaceVersion(db, uuidv7(), next(owner)), "not_found");
    await db.update(user).set({ legalHold: false }).where(eq(user.id, heldOwner));
  });
});

describe("sharingSummary", () => {
  it("counts people (pending included) and reports the best live link state per node", async () => {
    const owner = await makeUser(db);
    const friend = await makeUser(db);
    const plain = await makeFile(db, owner, null, `plain-${rand()}.txt`);
    const shared = await makeFile(db, owner, null, `shared-${rand()}.txt`);
    await makeShare(db, shared.id, owner, { userId: friend });
    await makeShare(db, shared.id, owner, { email: `pending-${rand()}@example.test` });
    await makeLink(db, shared.id, owner);

    const paused = await makeFile(db, owner, null, `paused-${rand()}.txt`);
    await makeLink(db, paused.id, owner, { pauseReasons: ["report"] });
    await makeLink(db, paused.id, owner, { expiresAt: new Date(Date.now() - 1000) });
    const locked = await makeFile(db, owner, null, `locked-${rand()}.txt`);
    await makeLink(db, locked.id, owner, { lockedByAdmin: true });
    const expired = await makeFile(db, owner, null, `expired-${rand()}.txt`);
    await makeLink(db, expired.id, owner, { expiresAt: new Date(Date.now() - 1000) });
    await makeLink(db, expired.id, owner, { maxDownloads: 2, downloadCount: 2 });
    const revoked = await makeFile(db, owner, null, `revoked-${rand()}.txt`);
    await makeLink(db, revoked.id, owner, { revokedAt: new Date() });

    const unknown = uuidv7();
    const summary = await sharingSummary(db, [
      plain.id,
      shared.id,
      paused.id,
      locked.id,
      expired.id,
      revoked.id,
      unknown,
      "junk",
    ]);
    expect(summary.get(plain.id)).toEqual({ people: 0, link: "none" });
    expect(summary.get(shared.id)).toEqual({ people: 2, link: "active" });
    expect(summary.get(paused.id)).toEqual({ people: 0, link: "paused" });
    expect(summary.get(locked.id)).toEqual({ people: 0, link: "paused" });
    expect(summary.get(expired.id)).toEqual({ people: 0, link: "expired" });
    expect(summary.get(revoked.id)).toEqual({ people: 0, link: "none" });
    expect(summary.get(unknown)).toEqual({ people: 0, link: "none" });
    expect(typeof summary.get(shared.id)!.people).toBe("number");
    expect(summary.has("junk")).toBe(false);
    expect((await sharingSummary(db, [])).size).toBe(0);
  });
});
