import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  ancestors,
  effectiveAccess,
  effectiveRole,
  effectiveTrashed,
  isDescendantOrSelf,
  ownedRoots,
  subtree,
} from "../../../src/worker/db/queries/tree";
import { type Node, nodes, shares, user } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeShare, makeUser, openDb, rand } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

/**
 * root/
 *   a/
 *     b/
 *       deep.txt
 *     zeta.txt
 *   alpha.txt
 */
async function fixture() {
  const owner = await makeUser(db);
  const root = await makeFolder(db, owner, null, `root-${rand()}`);
  const a = await makeFolder(db, owner, root.id, "a");
  const b = await makeFolder(db, owner, a.id, "b");
  const deep = await makeFile(db, owner, b.id, "deep.txt", { size: 7 });
  const zeta = await makeFile(db, owner, a.id, "zeta.txt");
  const alpha = await makeFile(db, owner, root.id, "alpha.txt");
  return { owner, root, a, b, deep, zeta, alpha };
}

describe("ancestors", () => {
  it("returns the chain root first, without the node itself", async () => {
    const f = await fixture();
    const chain = await ancestors(db, f.deep.id);
    expect(chain.map((r) => r.id)).toEqual([f.root.id, f.a.id, f.b.id]);
    expect(chain.map((r) => r.depth)).toEqual([3, 2, 1]);
    expect(chain[0]).toMatchObject({ parentId: null, ownerId: f.owner, kind: "folder", name: f.root.name });
  });

  it("is empty for a root-level node, an unknown id and a non-uuid", async () => {
    const f = await fixture();
    expect(await ancestors(db, f.root.id)).toEqual([]);
    expect(await ancestors(db, uuidv7())).toEqual([]);
    expect(await ancestors(db, "not-a-uuid")).toEqual([]);
  });
});

describe("subtree", () => {
  it("walks depth first, each folder before its content, siblings by name", async () => {
    const f = await fixture();
    const rows = await subtree(db, f.root.id);
    expect(rows.map((r) => r.name)).toEqual([f.root.name, "a", "b", "deep.txt", "zeta.txt", "alpha.txt"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 2, 1]);
    const deep = rows.find((r) => r.id === f.deep.id)!;
    expect(deep).toMatchObject({
      size: 7,
      r2Key: f.deep.r2Key,
      versionId: f.deep.versionId,
      kind: "file",
      deletedAt: null,
    });
    expect(typeof deep.size).toBe("number");
  });

  it("includes trashed rows and reports their deletedAt", async () => {
    const f = await fixture();
    const when = new Date("2026-03-04T05:06:07.890Z");
    await db.update(nodes).set({ deletedAt: when, trashedRoot: true }).where(eq(nodes.id, f.a.id));
    const rows = await subtree(db, f.root.id);
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.id === f.a.id)!.deletedAt!.getTime()).toBe(when.getTime());
  });

  it("starts anywhere and is empty for an unknown id", async () => {
    const f = await fixture();
    expect((await subtree(db, f.b.id)).map((r) => r.id)).toEqual([f.b.id, f.deep.id]);
    expect((await subtree(db, f.alpha.id)).map((r) => r.id)).toEqual([f.alpha.id]);
    expect(await subtree(db, uuidv7())).toEqual([]);
  });
});

describe("isDescendantOrSelf", () => {
  it("is true for the node itself and anything below, false otherwise", async () => {
    const f = await fixture();
    expect(await isDescendantOrSelf(db, f.a.id, f.a.id)).toBe(true);
    expect(await isDescendantOrSelf(db, f.deep.id, f.a.id)).toBe(true);
    expect(await isDescendantOrSelf(db, f.deep.id, f.root.id)).toBe(true);
    expect(await isDescendantOrSelf(db, f.a.id, f.deep.id)).toBe(false);
    expect(await isDescendantOrSelf(db, f.alpha.id, f.a.id)).toBe(false);
    expect(await isDescendantOrSelf(db, uuidv7(), f.a.id)).toBe(false);
    expect(await isDescendantOrSelf(db, "x", f.a.id)).toBe(false);
  });
});

describe("effectiveTrashed", () => {
  it("is true below a trashed ancestor, false elsewhere, true for an unknown node", async () => {
    const f = await fixture();
    expect(await effectiveTrashed(db, f.deep.id)).toBe(false);
    await db.update(nodes).set({ deletedAt: new Date(), trashedRoot: true }).where(eq(nodes.id, f.a.id));
    expect(await effectiveTrashed(db, f.a.id)).toBe(true);
    expect(await effectiveTrashed(db, f.deep.id)).toBe(true);
    expect(await effectiveTrashed(db, f.zeta.id)).toBe(true);
    expect(await effectiveTrashed(db, f.alpha.id)).toBe(false);
    expect(await effectiveTrashed(db, f.root.id)).toBe(false);
    expect(await effectiveTrashed(db, uuidv7())).toBe(true);
    expect(await effectiveTrashed(db, "nope")).toBe(true);
  });
});

describe("effectiveAccess", () => {
  it("gives the owner the owner role everywhere", async () => {
    const f = await fixture();
    expect(await effectiveAccess(db, f.owner, f.deep.id)).toEqual({
      role: "owner",
      shareRootId: null,
      canUpload: true,
    });
    expect(await effectiveRole(db, f.owner, f.root.id)).toBe("owner");
  });

  it("gives nobody else anything without a share", async () => {
    const f = await fixture();
    const stranger = await makeUser(db);
    expect(await effectiveAccess(db, stranger, f.deep.id)).toBeNull();
    expect(await effectiveRole(db, stranger, f.root.id)).toBeNull();
    expect(await effectiveAccess(db, stranger, uuidv7())).toBeNull();
    expect(await effectiveAccess(db, stranger, "garbage")).toBeNull();
  });

  it("inherits a share through folder ancestry and names the share root", async () => {
    const f = await fixture();
    const viewer = await makeUser(db);
    await makeShare(db, f.a.id, f.owner, { userId: viewer });
    expect(await effectiveAccess(db, viewer, f.a.id)).toEqual({
      role: "viewer",
      shareRootId: f.a.id,
      canUpload: false,
    });
    expect(await effectiveAccess(db, viewer, f.deep.id)).toEqual({
      role: "viewer",
      shareRootId: f.a.id,
      canUpload: false,
    });
    // Nothing above or beside the shared folder.
    expect(await effectiveAccess(db, viewer, f.root.id)).toBeNull();
    expect(await effectiveAccess(db, viewer, f.alpha.id)).toBeNull();
  });

  it("takes the highest role over the chain, the nearest grant as share root, and the editor share's upload toggle", async () => {
    const f = await fixture();
    const grantee = await makeUser(db);
    await makeShare(db, f.root.id, f.owner, { userId: grantee }, { role: "editor", canUpload: false });
    await makeShare(db, f.b.id, f.owner, { userId: grantee }, { role: "viewer" });
    // Below `b`: the viewer share is nearer, the editor share higher.
    expect(await effectiveAccess(db, grantee, f.deep.id)).toEqual({
      role: "editor",
      shareRootId: f.b.id,
      canUpload: false,
    });
    expect(await effectiveAccess(db, grantee, f.zeta.id)).toEqual({
      role: "editor",
      shareRootId: f.root.id,
      canUpload: false,
    });

    const uploader = await makeUser(db);
    await makeShare(db, f.a.id, f.owner, { userId: uploader }, { role: "editor", canUpload: true });
    expect(await effectiveAccess(db, uploader, f.deep.id)).toEqual({
      role: "editor",
      shareRootId: f.a.id,
      canUpload: true,
    });
  });

  it("a pending share grants nothing — by address, or with a user id but no activation", async () => {
    const f = await fixture();
    const invited = await makeUser(db);
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, invited));
    await makeShare(db, f.a.id, f.owner, { email: row!.email }, { role: "editor" });
    expect(await effectiveAccess(db, invited, f.deep.id)).toBeNull();

    const half = await makeUser(db);
    const share = await makeShare(db, f.a.id, f.owner, { userId: half });
    await db.update(shares).set({ activatedAt: null }).where(eq(shares.id, share.id));
    expect(await effectiveAccess(db, half, f.deep.id)).toBeNull();
  });

  it("returns null for a grantee when the owner is banned, suspended or scheduled for deletion", async () => {
    const states: Partial<typeof user.$inferInsert>[] = [
      { banned: true },
      { banned: true, banExpires: new Date(Date.now() + 86_400_000) },
      { suspendedAt: new Date() },
      { deleteScheduledAt: new Date(Date.now() + 7 * 86_400_000) },
    ];
    for (const state of states) {
      const f = await fixture();
      const grantee = await makeUser(db);
      await makeShare(db, f.a.id, f.owner, { userId: grantee }, { role: "editor" });
      expect(await effectiveRole(db, grantee, f.deep.id)).toBe("editor");
      await db.update(user).set(state).where(eq(user.id, f.owner));
      expect(await effectiveAccess(db, grantee, f.deep.id), JSON.stringify(state)).toBeNull();
      // The owner's own access is not this function's business to remove.
      expect(await effectiveRole(db, f.owner, f.deep.id)).toBe("owner");
    }
  });

  it("an expired ban no longer blocks the owner's grantees", async () => {
    const f = await fixture();
    const grantee = await makeUser(db);
    await makeShare(db, f.a.id, f.owner, { userId: grantee });
    await db
      .update(user)
      .set({ banned: true, banExpires: new Date(Date.now() - 60_000) })
      .where(eq(user.id, f.owner));
    expect(await effectiveRole(db, grantee, f.deep.id)).toBe("viewer");
  });

  it("a share on an avatar's owner does not reach the system node", async () => {
    const f = await fixture();
    const partner = await makeUser(db);
    await makeShare(db, f.root.id, f.owner, { userId: partner });
    const avatar = await makeFile(db, f.owner, null, "avatar", { system: "avatar" });
    expect(await effectiveAccess(db, partner, avatar.id)).toBeNull();
  });
});

describe("ownedRoots", () => {
  it("lists the owner's top level, trashed and hidden rows included, system nodes only on request", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const live = await makeFolder(db, owner, null, "live");
    const trashed = await makeFolder(db, owner, null, "trashed", {
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const hidden = await makeFile(db, owner, null, "hidden.bin", {
      scanStatus: "suspected_csam",
      takedownAt: new Date(),
    });
    const avatar = await makeFile(db, owner, null, "avatar", { system: "avatar" });
    await makeFile(db, owner, live.id, "child.txt");
    await makeFolder(db, other, null, "not-mine");

    const ids = (rows: Node[]) => rows.map((r) => r.id).sort();
    expect(ids(await ownedRoots(db, owner))).toEqual([live.id, trashed.id, hidden.id].sort());
    expect(ids(await ownedRoots(db, owner, { includeSystem: true }))).toEqual(
      [live.id, trashed.id, hidden.id, avatar.id].sort(),
    );
    expect(ids(await ownedRoots(db, owner, { includeSystem: false }))).toEqual(
      [live.id, trashed.id, hidden.id].sort(),
    );
  });
});
