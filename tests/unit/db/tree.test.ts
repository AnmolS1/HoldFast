import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, statementsSent } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  ancestors,
  effectiveAccess,
  effectiveHidden,
  effectiveRole,
  effectiveTrashed,
  isDescendantOrSelf,
  NO_SUCH_OWNER_ID,
  notEffectivelyHidden,
  ownedRoots,
  subtree,
} from "../../../src/worker/db/queries/tree";
import { userState } from "../../../src/worker/db/queries/users";
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

describe("effectiveHidden", () => {
  it("is true for a taken-down node and everything below it, false elsewhere, true for an unknown node", async () => {
    const f = await fixture();
    for (const node of [f.root, f.a, f.b, f.deep, f.zeta, f.alpha]) {
      expect(await effectiveHidden(db, node.id)).toBe(false);
    }
    await db
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "abuse" })
      .where(eq(nodes.id, f.a.id));
    expect(await effectiveHidden(db, f.a.id)).toBe(true);
    expect(await effectiveHidden(db, f.b.id)).toBe(true);
    expect(await effectiveHidden(db, f.deep.id)).toBe(true);
    expect(await effectiveHidden(db, f.zeta.id)).toBe(true);
    // Not above it, and not beside it.
    expect(await effectiveHidden(db, f.root.id)).toBe(false);
    expect(await effectiveHidden(db, f.alpha.id)).toBe(false);
    expect(await effectiveHidden(db, uuidv7())).toBe(true);
    expect(await effectiveHidden(db, "nope")).toBe(true);
  });

  it("suspected CSAM hides the file itself and is not inherited; no other scan state hides", async () => {
    const f = await fixture();
    await db.update(nodes).set({ scanStatus: "suspected_csam" }).where(eq(nodes.id, f.deep.id));
    expect(await effectiveHidden(db, f.deep.id)).toBe(true);
    expect(await effectiveHidden(db, f.b.id)).toBe(false);
    expect(await effectiveHidden(db, f.zeta.id)).toBe(false);
    // A state only a file has: on an ancestor (which cannot happen through the product) it
    // hides that node alone.
    await db.update(nodes).set({ scanStatus: "suspected_csam" }).where(eq(nodes.id, f.a.id));
    expect(await effectiveHidden(db, f.a.id)).toBe(true);
    expect(await effectiveHidden(db, f.zeta.id)).toBe(false);
    for (const scanStatus of ["pending", "clean", "infected", "under_review", "error"] as const) {
      await db.update(nodes).set({ scanStatus }).where(eq(nodes.id, f.alpha.id));
      expect(await effectiveHidden(db, f.alpha.id), scanStatus).toBe(false);
    }
    // In the trash is not hidden: that is `effectiveTrashed`'s question.
    await db.update(nodes).set({ deletedAt: new Date(), trashedRoot: true }).where(eq(nodes.id, f.alpha.id));
    expect(await effectiveHidden(db, f.alpha.id)).toBe(false);
  });
});

describe("notEffectivelyHidden", () => {
  /** The ids of `among` the predicate lets through. */
  const shown = async (among: Node[]): Promise<Set<string>> => {
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          inArray(
            nodes.id,
            among.map((n) => n.id),
          ),
          notEffectivelyHidden(),
        ),
      );
    return new Set(rows.map((r) => r.id));
  };
  const takeDown = (id: string) =>
    db.update(nodes).set({ takedownAt: new Date(), takedownReason: "abuse" }).where(eq(nodes.id, id));
  const restore = (id: string) =>
    db.update(nodes).set({ takedownAt: null, takedownReason: null }).where(eq(nodes.id, id));

  it("excludes a taken-down row and everything under it — parent or grandparent — and nothing else; a restored ancestor shows its content again", async () => {
    const f = await fixture();
    const all = [f.root, f.a, f.b, f.deep, f.zeta, f.alpha];
    const ids = (list: Node[]) => new Set(list.map((n) => n.id));
    // The control: nothing is taken down, everything is let through.
    expect(await shown(all)).toEqual(ids(all));

    await takeDown(f.a.id);
    // `a` itself, `zeta` (parent), `b` (parent) and `deep` (grandparent) are out; the folder
    // above and the sibling outside are in.
    expect(await shown(all)).toEqual(ids([f.root, f.alpha]));

    await restore(f.a.id);
    expect(await shown(all)).toEqual(ids(all));

    // A file taken down by itself hides nothing else.
    await takeDown(f.deep.id);
    expect(await shown(all)).toEqual(ids([f.root, f.a, f.b, f.zeta, f.alpha]));
  });

  it("works under another alias, and suspected CSAM is not its business", async () => {
    const f = await fixture();
    await takeDown(f.b.id);
    await db.update(nodes).set({ scanStatus: "suspected_csam" }).where(eq(nodes.id, f.zeta.id));
    const result = await db.execute<{ id: string }>(
      sql`SELECT n.id FROM nodes n WHERE n.owner_id = ${f.owner} AND ${notEffectivelyHidden("n")}`,
    );
    // `zeta` is locked, not taken down: the predicate lets it through (the status list hides it).
    expect(new Set(result.rows.map((r) => r.id))).toEqual(
      new Set([f.root.id, f.a.id, f.zeta.id, f.alpha.id]),
    );
  });

  it("agrees with effectiveHidden on every node, suspected CSAM aside", async () => {
    const f = await fixture();
    const all = [f.root, f.a, f.b, f.deep, f.zeta, f.alpha];
    const agree = async (label: string) => {
      const letThrough = await shown(all);
      for (const node of all) {
        expect(await effectiveHidden(db, node.id), `${label}: ${node.name}`).toBe(!letThrough.has(node.id));
      }
      return letThrough.size;
    };
    expect(await agree("nothing down")).toBe(6);
    await takeDown(f.b.id);
    expect(await agree("b down")).toBe(4);
    await takeDown(f.root.id);
    expect(await agree("root and b down")).toBe(0);
    await restore(f.root.id);
    expect(await agree("root restored, b still down")).toBe(4);
    await restore(f.b.id);
    expect(await agree("all restored")).toBe(6);

    // The one place they differ, by design: a locked file is hidden by id and let through here.
    await db.update(nodes).set({ scanStatus: "suspected_csam" }).where(eq(nodes.id, f.alpha.id));
    expect(await effectiveHidden(db, f.alpha.id)).toBe(true);
    expect((await shown(all)).has(f.alpha.id)).toBe(true);
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

  it("sends the same two statements for the owner, a grantee, a stranger and an unknown id", async () => {
    const f = await fixture();
    const grantee = await makeUser(db);
    const stranger = await makeUser(db);
    await makeShare(db, f.a.id, f.owner, { userId: grantee });
    const cost = async (userId: string, nodeId: string) => {
      const before = statementsSent(db);
      const access = await effectiveAccess(db, userId, nodeId);
      return { statements: statementsSent(db) - before, role: access?.role ?? null };
    };
    expect(await cost(f.owner, f.deep.id)).toEqual({ statements: 2, role: "owner" });
    expect(await cost(grantee, f.deep.id)).toEqual({ statements: 2, role: "viewer" });
    expect(await cost(grantee, f.alpha.id)).toEqual({ statements: 2, role: null });
    expect(await cost(stranger, f.deep.id)).toEqual({ statements: 2, role: null });
    expect(await cost(stranger, uuidv7())).toEqual({ statements: 2, role: null });
    await db.update(user).set({ suspendedAt: new Date() }).where(eq(user.id, f.owner));
    expect(await cost(grantee, f.deep.id)).toEqual({ statements: 2, role: null });
    expect(await cost(f.owner, f.deep.id)).toEqual({ statements: 2, role: "owner" });
    // Not an id at all: nothing is asked.
    expect(await cost(stranger, "garbage")).toEqual({ statements: 0, role: null });
    // The padding read is of an id no account has.
    expect(await userState(db, NO_SUCH_OWNER_ID)).toBeNull();
    expect(NO_SUCH_OWNER_ID).not.toMatch(/^[A-Za-z0-9]+$/);
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
