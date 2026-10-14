// What no account holder may see — a node that is taken down (itself or by a folder above it), a
// file locked as suspected CSAM — answers on EVERY route exactly as an id that was never issued:
// the same status, the same headers, the same body. For the owner too. And a system node (an
// avatar) is in no listing and behind no route.
import { describe, expect, it } from "vitest";
import { listRecent, listStarred, OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import { BY_ID } from "./by-id-routes";
import {
  api,
  comparable,
  makeFile,
  makeFolder,
  nodeById,
  setStatus,
  sharedTree,
  takeDown,
  testDb,
  type SharedTree,
} from "./helpers";

const sources = import.meta.glob("../../../src/worker/routes/nodes.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const ROUTE_SOURCE = Object.values(sources)[0]!;

/** The hidden things of one tree, each with the kind of node it is. */
async function hiddenIn(t: SharedTree) {
  const downFile = await makeFile(t.owner.id, t.inner.id, { scanStatus: "clean", mimeSniffed: "image/png" });
  await takeDown(downFile.id);
  const downFolder = await makeFolder(t.owner.id, t.shared.id);
  const fileInside = await makeFile(t.owner.id, downFolder.id, {
    scanStatus: "error",
    mimeSniffed: "image/png",
  });
  const folderInside = await makeFolder(t.owner.id, downFolder.id);
  const deepFile = await makeFile(t.owner.id, folderInside.id, { scanStatus: "clean" });
  await takeDown(downFolder.id);
  const locked = await makeFile(t.owner.id, t.inner.id, { mimeSniffed: "image/png" });
  await setStatus(locked.id, "suspected_csam");
  const trashedFile = await makeFile(t.owner.id, t.inner.id, {
    scanStatus: "clean",
    mimeSniffed: "image/png",
    deletedAt: new Date(),
    trashedRoot: true,
  });
  const trashedFolder = await makeFolder(t.owner.id, t.shared.id, {
    deletedAt: new Date(),
    trashedRoot: true,
  });
  const inTrashedFolder = await makeFile(t.owner.id, trashedFolder.id, { scanStatus: "clean" });
  return {
    "a file in the trash": trashedFile,
    "a folder in the trash": trashedFolder,
    "a file inside a trashed folder": inTrashedFolder,
    "a taken-down file": downFile,
    "a taken-down folder": downFolder,
    "a file inside a taken-down folder": fileInside,
    "a folder inside a taken-down folder": folderInside,
    "a file two levels under a taken-down folder": deepFile,
    "a suspected_csam file": locked,
  };
}

describe("hidden and trashed nodes answer as an id that was never issued — same answer, same work", () => {
  it.each(BY_ID)("$name — for the owner and for a share partner", async (route) => {
    const t = await sharedTree();
    const hidden = await hiddenIn(t);
    for (const who of [t.owner, t.editor, t.viewer]) {
      const unknownId = crypto.randomUUID();
      const unknown = await route.call(who.as, unknownId, t);
      // Not a success of any kind — except the batch, whose answer is per node.
      if (route.name === "POST /nodes/download-urls") {
        expect(unknown.body.items).toEqual([{ nodeId: unknownId, error: "not_found" }]);
      } else if (who === t.viewer && route.name.includes("(as the target)")) {
        // The viewer may not move the visible node at all: refused before the target is looked at.
        expect([unknown.status, unknown.body.error]).toEqual([403, "forbidden"]);
      } else {
        expect([unknown.status, unknown.body.error]).toEqual([404, "not_found"]);
      }
      for (const [label, node] of Object.entries(hidden)) {
        const answer = await route.call(who.as, node.id, t);
        expect(
          comparable(answer, { [node.id]: "ID" }),
          `${label}, as the ${who === t.owner ? "owner" : "partner"}`,
        ).toEqual(comparable(unknown, { [unknownId]: "ID" }));
        expect(JSON.stringify(answer.body).replaceAll(node.id, "")).not.toContain(node.name);
        // The same WORK too: the number of statements must not tell the kinds of "not there" apart.
        expect(answer.statements, `${route.name}: statements for ${label}`).toBe(unknown.statements);
      }
    }
    // Nothing a refused request asked for was done.
    for (const node of Object.values(hidden)) {
      const row = (await nodeById(node.id))!;
      expect([row.name, row.parentId, row.starred, row.rescanRequestedAt, row.lastAccessedAt]).toEqual([
        node.name,
        node.parentId,
        false,
        null,
        null,
      ]);
    }
  });

  it("the control: the same routes answer for the visible nodes of the same tree", async () => {
    const t = await sharedTree();
    await hiddenIn(t);
    const ok = async (name: string, id: string) => {
      const answer = await BY_ID.find((route) => route.name === name)!.call(t.owner.as, id, t);
      return answer.status;
    };
    expect(await ok("GET /nodes/:id", t.notes.id)).toBe(200);
    expect(await ok("GET /nodes/:id/children", t.inner.id)).toBe(200);
    expect(await ok("PATCH /nodes/:id {starred}", t.notes.id)).toBe(200);
    expect(await ok("POST /nodes/folder (as the parent)", t.inner.id)).toBe(200);
    expect(await ok("POST /nodes/:id/download-url (download)", t.notes.id)).toBe(200);
    expect(await ok("GET /nodes/:id/thumb-url", t.photo.id)).toBe(200);
    expect(await ok("POST /nodes/:id/rescan", t.broken.id)).toBe(202);
    expect(await ok("POST /nodes/zip-manifest", t.inner.id)).toBe(200);
    expect(await ok("POST /nodes/:id/move", t.notes.id)).toBe(200);
  });

  it("absent from the listings: the taken-down folder among its siblings, the hidden files among theirs", async () => {
    const t = await sharedTree();
    const hidden = await hiddenIn(t);
    for (const who of [t.owner, t.editor]) {
      const listed = async (folderId: string) =>
        (await api(who.as, "GET", `/nodes/${folderId}/children?limit=200`)).body.items.map(
          (item: { id: string }) => item.id,
        );
      const inShared = await listed(t.shared.id);
      expect(inShared).toEqual(expect.arrayContaining([t.inner.id, t.dest.id]));
      expect(inShared).not.toContain(hidden["a taken-down folder"].id);
      const inInner = await listed(t.inner.id);
      expect(inInner).toContain(t.notes.id);
      expect(inInner).not.toContain(hidden["a taken-down file"].id);
      expect(inInner).not.toContain(hidden["a suspected_csam file"].id);
    }
    const root = await makeFolder(t.owner.id);
    await takeDown(root.id);
    const top = (await api(t.owner.as, "GET", "/nodes/root?limit=200")).body.items.map(
      (item: { id: string }) => item.id,
    );
    expect(top).toContain(t.shared.id);
    expect(top).not.toContain(root.id);
  });

  it("a file opened and starred BEFORE its folder was taken down is in neither Recent nor Starred afterwards", async () => {
    const t = await sharedTree();
    const folder = await makeFolder(t.owner.id, t.shared.id);
    const file = await makeFile(t.owner.id, folder.id, { scanStatus: "clean" });
    // Through the routes: this is how a file comes to be in either list.
    expect((await api(t.owner.as, "PATCH", `/nodes/${file.id}`, { body: { starred: true } })).status).toBe(
      200,
    );
    expect(
      (await api(t.owner.as, "POST", `/nodes/${file.id}/download-url`, { body: { kind: "download" } }))
        .status,
    ).toBe(200);

    // /recent and /starred are another task's routes: the queries they will call, called directly.
    const lists = async () => {
      const options = { limit: 50, visibleStatuses: OWNER_VISIBLE_STATUSES };
      const recent = await listRecent(testDb(), t.owner.id, options);
      const starred = await listStarred(testDb(), t.owner.id, options);
      return { recent: recent.map((row) => row.id), starred: starred.items.map((row) => row.id) };
    };
    expect(await lists()).toEqual({ recent: [file.id], starred: [file.id] });
    await takeDown(folder.id);
    expect(await lists()).toEqual({ recent: [], starred: [] });
    // The row itself is untouched: it is hidden by the folder above it, not changed.
    const row = (await nodeById(file.id))!;
    expect([row.starred, row.takedownAt, row.lastAccessedAt !== null]).toEqual([true, null, true]);
  });
});

describe("system nodes (avatars)", () => {
  it("404 on every route, for their owner; in no listing and no manifest", async () => {
    const t = await sharedTree();
    const avatar = await makeFile(t.owner.id, null, {
      scanStatus: "clean",
      mimeSniffed: "image/png",
      system: "avatar",
    });
    for (const route of BY_ID) {
      const answer = await route.call(t.owner.as, avatar.id, t);
      if (route.name === "POST /nodes/download-urls") {
        expect(answer.body.items, route.name).toEqual([{ nodeId: avatar.id, error: "not_found" }]);
      } else {
        expect([answer.status, answer.body.error], route.name).toEqual([404, "not_found"]);
      }
    }
    const top = await api(t.owner.as, "GET", "/nodes/root?limit=200");
    expect(top.body.items.map((item: { id: string }) => item.id)).not.toContain(avatar.id);
    const everything = await api(t.owner.as, "POST", "/nodes/zip-manifest", { body: { allOwned: true } });
    expect(JSON.stringify(everything.body)).not.toContain(avatar.id);
    // The control: an ordinary image in the same place is served.
    const image = await makeFile(t.owner.id, null, { scanStatus: "clean", mimeSniffed: "image/png" });
    expect((await api(t.owner.as, "GET", `/nodes/${image.id}/thumb-url?size=320`)).status).toBe(200);
  });
});

describe("the route file itself", () => {
  // Comments are part of the scan on purpose: the words must not be there at all.
  it("has no takedown branch of its own: the permission service decides", () => {
    expect(ROUTE_SOURCE.length).toBeGreaterThan(5_000);
    expect(ROUTE_SOURCE).toContain("requireRole(");
    expect(ROUTE_SOURCE).not.toMatch(/takedown/i);
    expect(ROUTE_SOURCE).not.toContain("suspected_csam");
    expect(ROUTE_SOURCE).not.toContain("includeHidden");
  });

  it("never writes the retired download action", () => {
    expect(ROUTE_SOURCE).toContain('"file.download"');
    expect(ROUTE_SOURCE).not.toContain("node.download_url");
  });

  it("has no branch on why a rescan was refused", () => {
    expect(ROUTE_SOURCE).toContain("enqueueRescan(");
    expect(ROUTE_SOURCE).not.toMatch(/\breason\b/);
    expect(ROUTE_SOURCE).not.toMatch(/queued\s*:\s*false/);
    expect(ROUTE_SOURCE).not.toMatch(/\bqueued\b/);
  });

  it("reads a node by id only after asking the permission service about it", () => {
    // `getNode` appears once, inside `liveNode`, after `requireRole`.
    const calls = [...ROUTE_SOURCE.matchAll(/\bgetNode\(/g)];
    expect(calls).toHaveLength(1);
    const helper = ROUTE_SOURCE.slice(ROUTE_SOURCE.indexOf("async function liveNode"));
    expect(helper.indexOf("requireRole(")).toBeLessThan(helper.indexOf("getNode("));
    expect(helper.indexOf("requireRole(")).toBeGreaterThan(-1);
  });

  it("keeps no visibility rule of its own: no trash check, no partner rule — the permission service has both", () => {
    expect(ROUTE_SOURCE).toContain("notTrashed: true");
    expect(ROUTE_SOURCE).not.toContain("assertNotTrashed");
    expect(ROUTE_SOURCE).not.toContain("effectiveTrashed");
    expect(ROUTE_SOURCE).not.toMatch(/function partnerSees|createdBy ===/);
    // …and no status list of its own: the listings' lists are the ones `nodes.partnerSees` uses.
    expect(ROUTE_SOURCE).not.toMatch(/VISIBLE_STATUSES(\s*:[^=;\n]*)?\s*=[^=]/);
  });
});
