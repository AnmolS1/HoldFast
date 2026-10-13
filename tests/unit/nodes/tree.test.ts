// Listing, details, create, rename and star: what the routes answer, and the rules that are
// theirs — the share root, the breadcrumbs, the taken folder name.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { NodeDetailDto, NodeDto, NodePage } from "../../../src/shared/schemas/node";
import { nodes, shareLinks } from "../../../src/worker/db/schema";
import { makeLink, makePendingShare } from "../auth/helpers";
import {
  api,
  auditFor,
  comparable,
  makeFile,
  makeFolder,
  makeShare,
  nodeById,
  person,
  rand,
  setStatus,
  sharedTree,
  takeDown,
  testDb,
} from "./helpers";

const SORTS = ["name", "size", "updated", "kind"] as const;
const DIRS = ["asc", "desc"] as const;

type Item = { id: string; kind: string; name: string; size: number; ext: string; updatedAt: string };

/** Every page of a listing, in order, through the route. `between` runs after the first page. */
async function allPages(
  caller: Parameters<typeof api>[0],
  path: string,
  query: string,
  between: () => Promise<void> = async () => {},
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const answer = await api(
      caller,
      "GET",
      `${path}?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(answer.status).toBe(200);
    NodePage.parse(answer.body);
    items.push(...answer.body.items);
    cursor = answer.body.nextCursor;
    if (page === 0) await between();
    if (!cursor) return items;
  }
  throw new Error("the listing never ended");
}

/** A folder with three folders and nine files of differing names, sizes, types and ages. */
async function mixedFolder() {
  const owner = await person();
  const folder = await makeFolder(owner.id);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++)
    ids.push((await makeFolder(owner.id, folder.id, { name: `dir ${"cab"[i]}` })).id);
  for (let i = 0; i < 9; i++) {
    const ext = ["txt", "png", "pdf"][i % 3]!;
    const row = await makeFile(owner.id, folder.id, {
      name: `${"hgfedcbai"[i]}-file.${ext}`,
      size: [500, 20, 500, 7, 90_000, 20, 1, 500, 333][i]!,
      scanStatus: "clean",
      updatedAt: new Date(Date.UTC(2026, 0, 1 + ((i * 5) % 9), 12, 0, i)),
    });
    ids.push(row.id);
  }
  return { owner, folder, ids };
}

describe("children: sort and paging", () => {
  it.each(SORTS.flatMap((sort) => DIRS.map((dir) => ({ sort, dir }))))(
    "sort=$sort dir=$dir: folders first, in order, every page",
    async ({ sort, dir }) => {
      const { owner, folder, ids } = await mixedFolder();
      const items = await allPages(
        owner.as,
        `/nodes/${folder.id}/children`,
        `sort=${sort}&dir=${dir}&limit=4`,
      );
      expect(items.map((item) => item.id).sort()).toEqual([...ids].sort());

      const kinds = items.map((item) => item.kind);
      expect(kinds.lastIndexOf("folder")).toBeLessThan(kinds.indexOf("file"));
      const files = items.filter((item) => item.kind === "file");
      const key = (item: Item): (string | number)[] =>
        sort === "name"
          ? [item.name.toLowerCase()]
          : sort === "size"
            ? [item.size]
            : sort === "updated"
              ? [item.updatedAt]
              : [item.ext, item.name.toLowerCase()];
      const compare = (a: Item, b: Item) => {
        const [ka, kb] = [key(a), key(b)];
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      };
      const sorted = [...files].sort(compare);
      expect(files.map((item) => item.id)).toEqual(
        (dir === "asc" ? sorted : sorted.reverse()).map((i) => i.id),
      );
    },
  );

  it.each(SORTS)("sort=%s: rows inserted while paging neither repeat nor hide a row", async (sort) => {
    const { owner, folder, ids } = await mixedFolder();
    const added: string[] = [];
    const items = await allPages(
      owner.as,
      `/nodes/${folder.id}/children`,
      `sort=${sort}&limit=4`,
      async () => {
        // One row that sorts before everything already read, one after, one folder.
        added.push(
          (
            await makeFile(owner.id, folder.id, {
              name: "0-early.aaa",
              size: 0,
              scanStatus: "clean",
              updatedAt: new Date(0),
            })
          ).id,
          (await makeFile(owner.id, folder.id, { name: "zz-late.zzz", size: 10 ** 9, scanStatus: "clean" }))
            .id,
          (await makeFolder(owner.id, folder.id, { name: "0 dir first" })).id,
        );
      },
    );
    const seen = items.map((item) => item.id);
    expect(new Set(seen).size, "no row twice").toBe(seen.length);
    for (const id of ids) expect(seen, "no row that was there is skipped").toContain(id);
    // What sorts after the cursor is still met; what sorts before it is not gone back for.
    expect(seen).toContain(added[1]);
    expect(seen).not.toContain(added[0]);
    expect(seen).not.toContain(added[2]);
  });

  it("a cursor of another sort, direction or folder is 400 validation; so is a made-up one", async () => {
    const { owner, folder } = await mixedFolder();
    const other = await mixedFolder();
    const first = await api(owner.as, "GET", `/nodes/${folder.id}/children?sort=name&limit=2`);
    const cursor = encodeURIComponent(first.body.nextCursor);
    for (const path of [
      `/nodes/${folder.id}/children?sort=size&limit=2&cursor=${cursor}`,
      `/nodes/${folder.id}/children?sort=name&dir=desc&limit=2&cursor=${cursor}`,
      `/nodes/root?sort=name&limit=2&cursor=${cursor}`,
      `/nodes/${folder.id}/children?sort=name&cursor=bm90IGEgY3Vyc29y`,
    ]) {
      const answer = await api(owner.as, "GET", path);
      expect([answer.status, answer.body.error], path).toEqual([400, "validation"]);
    }
    // Another owner's folder: not there at all, cursor or not.
    const foreign = await api(owner.as, "GET", `/nodes/${other.folder.id}/children?cursor=${cursor}`);
    expect(foreign.status).toBe(404);
    // The control: the cursor works where it belongs.
    expect(
      (await api(owner.as, "GET", `/nodes/${folder.id}/children?sort=name&limit=2&cursor=${cursor}`)).status,
    ).toBe(200);
  });

  it("refuses a query it does not know: limit above 200, an unknown sort, an unknown key", async () => {
    const { owner, folder } = await mixedFolder();
    for (const query of ["limit=201", "limit=0", "sort=owner", "dir=up", "kind=link", "offset=10"]) {
      const answer = await api(owner.as, "GET", `/nodes/${folder.id}/children?${query}`);
      expect([answer.status, answer.body.error], query).toEqual([400, "validation"]);
    }
    const only = await api(owner.as, "GET", `/nodes/${folder.id}/children?kind=folder&limit=200`);
    expect(only.body.items.map((item: Item) => item.kind)).toEqual(["folder", "folder", "folder"]);
  });

  it("leaves out trashed, system and taken-down children; a share partner sees clean files only", async () => {
    const t = await sharedTree();
    const trashed = await makeFile(t.owner.id, t.inner.id, {
      scanStatus: "clean",
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const avatar = await makeFile(t.owner.id, t.inner.id, { scanStatus: "clean", system: "avatar" });
    const down = await makeFolder(t.owner.id, t.inner.id);
    await takeDown(down.id);
    const locked = await makeFile(t.owner.id, t.inner.id, { scanStatus: "suspected_csam" });
    const pending = await makeFile(t.owner.id, t.inner.id, { scanStatus: "pending" });
    const infected = await makeFile(t.owner.id, t.inner.id, { scanStatus: "infected" });

    const idsFor = async (caller: Parameters<typeof api>[0]) =>
      (await api(caller, "GET", `/nodes/${t.inner.id}/children`)).body.items
        .map((item: Item) => item.id)
        .sort();
    expect(await idsFor(t.owner.as)).toEqual(
      [t.notes.id, t.photo.id, t.broken.id, pending.id, infected.id].sort(),
    );
    for (const who of [t.editor, t.viewer]) {
      expect(await idsFor(who.as)).toEqual([t.notes.id, t.photo.id].sort());
    }
    for (const hidden of [trashed, avatar, down, locked]) {
      expect(await idsFor(t.owner.as)).not.toContain(hidden.id);
    }
    // The children of a file are not a listing.
    expect((await api(t.owner.as, "GET", `/nodes/${t.notes.id}/children`)).status).toBe(404);
  });
});

describe("GET /nodes/:id", () => {
  it("answers NodeDetailDto: the role inside `node`, nothing beside `node` and `breadcrumbs`", async () => {
    const t = await sharedTree();
    for (const [who, role] of [
      [t.owner, "owner"],
      [t.editor, "editor"],
      [t.viewer, "viewer"],
    ] as const) {
      const answer = await api(who.as, "GET", `/nodes/${t.notes.id}`);
      expect(answer.status).toBe(200);
      const detail = NodeDetailDto.parse(answer.body);
      expect(Object.keys(answer.body).sort()).toEqual(["breadcrumbs", "node"]);
      expect(detail.node.role).toBe(role);
      expect(detail.node.id).toBe(t.notes.id);
    }
  });

  it("never carries the object key or an address; the version is only the etag", async () => {
    const t = await sharedTree();
    for (const who of [t.owner, t.viewer]) {
      const answer = await api(who.as, "GET", `/nodes/${t.notes.id}`);
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(t.notes.r2Key!);
      expect(text).not.toContain("r2Key");
      expect(text).not.toContain("versionId");
      expect(text).not.toContain("@");
      expect(answer.body.node.etag).toBe(t.notes.versionId);
      expect(answer.body.node.owner).toEqual({ id: t.owner.id, displayName: t.owner.row.name });
      expect(answer.body.node.createdBy).toEqual({ id: t.owner.id, displayName: t.owner.row.name });
    }
  });

  it("breadcrumbs: the whole chain for the owner, from the share root for anyone else", async () => {
    const owner = await person();
    const viewer = await person();
    const top = await makeFolder(owner.id);
    const shared = await makeFolder(owner.id, top.id);
    const inner = await makeFolder(owner.id, shared.id);
    const file = await makeFile(owner.id, inner.id, { scanStatus: "clean" });
    await makeShare(shared.id, owner.id, viewer.id);
    const crumbs = async (caller: Parameters<typeof api>[0], id: string) =>
      (await api(caller, "GET", `/nodes/${id}`)).body.breadcrumbs;
    const crumb = (row: { id: string; name: string }) => ({ id: row.id, name: row.name });

    expect(await crumbs(owner.as, file.id)).toEqual([top, shared, inner].map(crumb));
    expect(await crumbs(viewer.as, file.id)).toEqual([shared, inner].map(crumb));
    expect(await crumbs(viewer.as, inner.id)).toEqual([shared].map(crumb));
    expect(await crumbs(viewer.as, shared.id)).toEqual([]);
    expect(await crumbs(owner.as, top.id)).toEqual([]);
    // What is above the share root is not the viewer's to open either.
    expect((await api(viewer.as, "GET", `/nodes/${top.id}`)).status).toBe(404);
  });

  it("the owner's marks stay the owner's: star and last-opened are false / null for a share partner", async () => {
    const t = await sharedTree();
    await testDb()
      .update(nodes)
      .set({ starred: true, lastAccessedAt: new Date(), sha256: "a".repeat(64) })
      .where(eq(nodes.id, t.notes.id));
    const mine = (await api(t.owner.as, "GET", `/nodes/${t.notes.id}`)).body.node;
    expect(mine.starred).toBe(true);
    expect(mine.lastAccessedAt).not.toBeNull();
    for (const who of [t.editor, t.viewer]) {
      const theirs = (await api(who.as, "GET", `/nodes/${t.notes.id}`)).body.node;
      expect([theirs.starred, theirs.lastAccessedAt, theirs.sha256]).toEqual([false, null, null]);
      const listed = (await api(who.as, "GET", `/nodes/${t.inner.id}/children`)).body.items.find(
        (item: { id: string }) => item.id === t.notes.id,
      );
      expect([listed.starred, listed.lastAccessedAt]).toEqual([false, null]);
    }
  });

  it("a share partner's share root does not say where it sits: parentId null; inside it, parents are kept", async () => {
    const owner = await person();
    const viewer = await person();
    const top = await makeFolder(owner.id);
    const shared = await makeFolder(owner.id, top.id);
    const inner = await makeFolder(owner.id, shared.id);
    await makeShare(shared.id, owner.id, viewer.id);
    expect((await api(owner.as, "GET", `/nodes/${shared.id}`)).body.node.parentId).toBe(top.id);
    const root = await api(viewer.as, "GET", `/nodes/${shared.id}`);
    expect(root.body.node.parentId).toBeNull();
    expect(JSON.stringify(root.body)).not.toContain(top.id);
    expect((await api(viewer.as, "GET", `/nodes/${inner.id}`)).body.node.parentId).toBe(shared.id);
    const listed = await api(viewer.as, "GET", `/nodes/${shared.id}/children`);
    expect(listed.body.items.map((item: { parentId: string }) => item.parentId)).toEqual([shared.id]);
  });

  it("sharing is the owner's to see: people (pending ones too) and the link; zero for anyone else", async () => {
    const t = await sharedTree();
    await makeLink(t.shared.id, t.owner.id);
    const mine = await api(t.owner.as, "GET", `/nodes/${t.shared.id}`);
    // The editor, the viewer and the share that was never activated.
    expect(mine.body.node.sharing).toEqual({ people: 3, link: "active", summary: "both" });
    const theirs = await api(t.editor.as, "GET", `/nodes/${t.shared.id}`);
    expect(theirs.body.node.sharing).toEqual({ people: 0, link: "none", summary: "none" });

    await testDb()
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(eq(shareLinks.nodeId, t.shared.id));
    expect((await api(t.owner.as, "GET", `/nodes/${t.shared.id}`)).body.node.sharing).toEqual({
      people: 3,
      link: "none",
      summary: "people",
    });
    expect((await api(t.owner.as, "GET", `/nodes/${t.notes.id}`)).body.node.sharing.summary).toBe("none");
  });

  it("a node in the trash, or under a trashed folder, is 404 here — for its owner too", async () => {
    const t = await sharedTree();
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true })
      .where(eq(nodes.id, t.inner.id));
    for (const who of [t.owner, t.editor]) {
      for (const id of [t.inner.id, t.notes.id]) {
        expect((await api(who.as, "GET", `/nodes/${id}`)).status).toBe(404);
        expect((await api(who.as, "PATCH", `/nodes/${id}`, { body: { name: "back.txt" } })).status).toBe(404);
      }
      expect((await api(who.as, "GET", `/nodes/${t.inner.id}/children`)).status).toBe(404);
    }
    // The control: its sibling is still there.
    expect((await api(t.owner.as, "GET", `/nodes/${t.dest.id}`)).status).toBe(200);
  });
});

describe("POST /nodes/folder", () => {
  it("creates at the top level and inside a folder; the answer is a NodeDto", async () => {
    const owner = await person();
    const top = await api(owner.as, "POST", "/nodes/folder", {
      body: { parentId: null, name: "  Projects  " },
    });
    expect(top.status).toBe(200);
    const dto = NodeDto.parse(top.body);
    expect(dto).toMatchObject({ kind: "folder", name: "Projects", parentId: null, role: "owner", size: 0 });
    const inside = await api(owner.as, "POST", "/nodes/folder", { body: { parentId: dto.id, name: "2026" } });
    expect(inside.body).toMatchObject({ parentId: dto.id, name: "2026" });
    expect((await auditFor("node.create_folder", dto.id)).map((row) => row.actorUserId)).toEqual([owner.id]);
  });

  it("inside a share: the folder belongs to the tree's owner, the editor made it", async () => {
    const t = await sharedTree();
    const answer = await api(t.editor.as, "POST", "/nodes/folder", {
      body: { parentId: t.inner.id, name: "from the editor" },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.owner.id).toBe(t.owner.id);
    expect(answer.body.createdBy.id).toBe(t.editor.id);
    expect(answer.body.role).toBe("editor");
    const row = await nodeById(answer.body.id);
    expect([row!.ownerId, row!.createdBy]).toEqual([t.owner.id, t.editor.id]);
    // Not in the editor's own tree.
    expect((await api(t.editor.as, "GET", "/nodes/root")).body.items).toEqual([]);
  });

  it("refuses a body it does not know, an unusable name, a file as the parent", async () => {
    const t = await sharedTree();
    for (const body of [
      {},
      { name: "no parent" },
      { parentId: null },
      { parentId: null, name: "" },
      { parentId: null, name: "a/b" },
      { parentId: null, name: ".." },
      { parentId: "not-an-id", name: "x" },
      { parentId: null, name: "x", extra: true },
    ]) {
      const answer = await api(t.owner.as, "POST", "/nodes/folder", { body });
      expect([answer.status, answer.body.error], JSON.stringify(body)).toEqual([400, "validation"]);
    }
    const inFile = await api(t.owner.as, "POST", "/nodes/folder", {
      body: { parentId: t.notes.id, name: "x" },
    });
    expect(inFile.status).toBe(404);
  });

  describe("on a taken name", () => {
    it("a folder the caller owns holds it: 409 with its id — also at the top level, in another case, in another normal form", async () => {
      const owner = await person();
      const parent = await makeFolder(owner.id);
      // "é" precomposed in the stored name, decomposed (e + U+0301) and upper-cased in the request.
      const stored = `Café ${rand()}`;
      const asked = stored.normalize("NFD").toUpperCase();
      expect(asked).not.toBe(stored.toUpperCase());
      for (const parentId of [parent.id, null]) {
        const existing = await makeFolder(owner.id, parentId, { name: stored });
        const answer = await api(owner.as, "POST", "/nodes/folder", { body: { parentId, name: asked } });
        expect([answer.status, answer.body.error]).toEqual([409, "conflict"]);
        expect(answer.body.details).toEqual({ existingId: existing.id });
      }
    });

    it("an editor inside a share gets the id of the folder they can see", async () => {
      const t = await sharedTree();
      const answer = await api(t.editor.as, "POST", "/nodes/folder", {
        body: { parentId: t.shared.id, name: t.dest.name },
      });
      expect(answer.status).toBe(409);
      expect(answer.body.details).toEqual({ existingId: t.dest.id });
    });

    it("a file, a taken-down folder or a locked file holds it: 409 with no details, and the answers are the same", async () => {
      const owner = await person();
      const parent = await makeFolder(owner.id);
      const file = await makeFile(owner.id, parent.id, { name: "held by a file", scanStatus: "clean" });
      const down = await makeFolder(owner.id, parent.id, { name: "held by a hidden folder" });
      await takeDown(down.id);
      const locked = await makeFile(owner.id, parent.id, { name: "held by a locked file" });
      await setStatus(locked.id, "suspected_csam");
      const visible = await makeFolder(owner.id, parent.id, { name: "held by a folder" });

      const ask = (name: string) =>
        api(owner.as, "POST", "/nodes/folder", { body: { parentId: parent.id, name } });
      const [byFile, byHidden, byLocked] = [
        await ask(file.name),
        await ask(down.name),
        await ask(locked.name),
      ];
      for (const answer of [byFile, byHidden, byLocked]) {
        expect([answer.status, answer.body.error]).toEqual([409, "conflict"]);
        expect("details" in answer.body).toBe(false);
      }
      expect(comparable(byHidden)).toEqual(comparable(byFile));
      expect(comparable(byLocked)).toEqual(comparable(byFile));
      expect(JSON.stringify(byHidden.body)).not.toContain(down.id);

      // The control: the same question about a folder that may be seen differs ONLY by `details`.
      const byFolder = await ask(visible.name);
      expect(byFolder.body.details).toEqual({ existingId: visible.id });
      expect({
        ...comparable(byFolder),
        body: { ...byFolder.body, requestId: undefined, details: undefined },
      }).toEqual({
        ...comparable(byFile),
        body: { ...byFile.body, requestId: undefined, details: undefined },
      });
    });

    it("the same at the top level", async () => {
      const owner = await person();
      const down = await makeFolder(owner.id, null, { name: `hidden ${rand()}` });
      await takeDown(down.id);
      const file = await makeFile(owner.id, null, { name: `file ${rand()}`, scanStatus: "clean" });
      const byHidden = await api(owner.as, "POST", "/nodes/folder", {
        body: { parentId: null, name: down.name },
      });
      const byFile = await api(owner.as, "POST", "/nodes/folder", {
        body: { parentId: null, name: file.name },
      });
      expect(byHidden.status).toBe(409);
      expect("details" in byHidden.body).toBe(false);
      expect(comparable(byHidden)).toEqual(comparable(byFile));
    });

    it("a trashed folder of that name does not hold it", async () => {
      const owner = await person();
      const gone = await makeFolder(owner.id, null, {
        name: `gone ${rand()}`,
        deletedAt: new Date(),
        trashedRoot: true,
      });
      const answer = await api(owner.as, "POST", "/nodes/folder", {
        body: { parentId: null, name: gone.name },
      });
      expect(answer.status).toBe(200);
      expect(answer.body.id).not.toBe(gone.id);
    });
  });
});

describe("PATCH /nodes/:id", () => {
  it("rename keeps the version and the object; the name, its key and the extension change together", async () => {
    const t = await sharedTree();
    const answer = await api(t.editor.as, "PATCH", `/nodes/${t.notes.id}`, {
      body: { name: "Final Report.PDF" },
    });
    expect(answer.status).toBe(200);
    expect(NodeDto.parse(answer.body)).toMatchObject({
      name: "Final Report.PDF",
      ext: "pdf",
      etag: t.notes.versionId,
    });
    const row = await nodeById(t.notes.id);
    expect([row!.r2Key, row!.versionId, row!.nameKey]).toEqual([
      t.notes.r2Key,
      t.notes.versionId,
      "final report.pdf",
    ]);
    const audited = await auditFor("node.rename", t.notes.id);
    expect(audited.map((entry) => entry.actorUserId)).toEqual([t.editor.id]);
  });

  it("a taken name is 409 conflict, with no details", async () => {
    const t = await sharedTree();
    const answer = await api(t.owner.as, "PATCH", `/nodes/${t.notes.id}`, {
      body: { name: t.photo.name.toUpperCase() },
    });
    expect([answer.status, answer.body.error]).toEqual([409, "conflict"]);
    expect("details" in answer.body).toBe(false);
    expect((await nodeById(t.notes.id))!.name).toBe(t.notes.name);
  });

  it("star is the owner's alone, and is audited", async () => {
    const t = await sharedTree();
    const starred = await api(t.owner.as, "PATCH", `/nodes/${t.notes.id}`, { body: { starred: true } });
    expect([starred.status, starred.body.starred]).toEqual([200, true]);
    expect((await auditFor("node.star", t.notes.id)).map((row) => row.meta)).toEqual([{ starred: true }]);
    for (const who of [t.editor, t.viewer]) {
      const answer = await api(who.as, "PATCH", `/nodes/${t.notes.id}`, { body: { starred: false } });
      expect([answer.status, answer.body.error]).toEqual([403, "forbidden"]);
    }
    expect((await nodeById(t.notes.id))!.starred).toBe(true);
  });

  it("name and star in one request: refused as a whole when either is not allowed", async () => {
    const t = await sharedTree();
    // The editor may rename, not star: nothing is renamed.
    const answer = await api(t.editor.as, "PATCH", `/nodes/${t.notes.id}`, {
      body: { name: "half.txt", starred: true },
    });
    expect(answer.status).toBe(403);
    const row = await nodeById(t.notes.id);
    expect([row!.name, row!.starred]).toEqual([t.notes.name, false]);
    expect(await auditFor("node.rename", t.notes.id)).toEqual([]);

    const both = await api(t.owner.as, "PATCH", `/nodes/${t.notes.id}`, {
      body: { name: "both.txt", starred: true },
    });
    expect(both.body).toMatchObject({ name: "both.txt", starred: true });
  });

  it("refuses an empty change and a body it does not know", async () => {
    const t = await sharedTree();
    for (const body of [
      {},
      { name: "" },
      { starred: "yes" },
      { name: "x", parentId: null },
      { name: "a/b" },
    ]) {
      const answer = await api(t.owner.as, "PATCH", `/nodes/${t.notes.id}`, { body });
      expect([answer.status, answer.body.error], JSON.stringify(body)).toEqual([400, "validation"]);
    }
    const noJson = await api(t.owner.as, "PATCH", `/nodes/${t.notes.id}`, {
      headers: { "content-type": "application/json" },
    });
    expect(noJson.status).toBe(400);
  });
});

describe("the share root", () => {
  it("an editor may not rename or move the node that was shared with them — only what is inside it", async () => {
    const t = await sharedTree();
    const rename = await api(t.editor.as, "PATCH", `/nodes/${t.shared.id}`, { body: { name: "Ours now" } });
    expect([rename.status, rename.body.error]).toEqual([403, "forbidden"]);
    const move = await api(t.editor.as, "POST", `/nodes/${t.shared.id}/move`, {
      body: { parentId: t.dest.id },
    });
    expect([move.status, move.body.error]).toEqual([403, "forbidden"]);
    expect((await nodeById(t.shared.id))!.name).toBe(t.shared.name);

    // Inside the root: allowed.
    expect(
      (await api(t.editor.as, "PATCH", `/nodes/${t.inner.id}`, { body: { name: "Inner, renamed" } })).status,
    ).toBe(200);
    expect(
      (await api(t.editor.as, "POST", `/nodes/${t.inner.id}/move`, { body: { parentId: t.dest.id } })).status,
    ).toBe(200);
    // The owner may do both to the root itself.
    expect(
      (await api(t.owner.as, "PATCH", `/nodes/${t.shared.id}`, { body: { name: "Shared, renamed" } })).status,
    ).toBe(200);
  });

  it("a share on a FILE: its editor may read it, not rename or move it", async () => {
    const owner = await person();
    const editor = await person();
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    await makeShare(file.id, owner.id, editor.id, { role: "editor" });
    expect((await api(editor.as, "GET", `/nodes/${file.id}`)).body.node.role).toBe("editor");
    expect((await api(editor.as, "PATCH", `/nodes/${file.id}`, { body: { name: "x.bin" } })).status).toBe(
      403,
    );
    expect(
      (await api(editor.as, "POST", `/nodes/${file.id}/move`, { body: { parentId: null } })).status,
    ).toBe(403);
  });

  it("an address that was invited but never activated gets nothing, on any id of the tree", async () => {
    const t = await sharedTree();
    await makePendingShare(t.notes.id, t.owner.id, t.invited.row.email);
    for (const id of [t.shared.id, t.inner.id, t.notes.id]) {
      expect((await api(t.invited.as, "GET", `/nodes/${id}`)).status).toBe(404);
    }
  });
});
