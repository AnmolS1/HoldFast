// The Node → NodeDto mapper: which fields of a file an answer carries, and for whom.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { NodeDto, TrashItemDto } from "../../../src/shared/schemas/node";
import { SearchResultDto } from "../../../src/shared/schemas/search";
import { statementsSent } from "../../../src/worker/db/client";
import { displayNames } from "../../../src/worker/db/queries/node-dto";
import { nodes, shareLinks, user } from "../../../src/worker/db/schema";
import {
  toNodeDto,
  toNodeDtos,
  toSearchResultDtos,
  toTrashItemDto,
  toTrashItemDtos,
} from "../../../src/worker/services/node-dto";
import { baId, makeFile, makeFolder, makeShare, makeUser, nodeById, rand, testDb } from "./helpers";

// `z.object` drops unknown keys, so a plain parse would pass an answer that carries more than
// the contract. The strict forms refuse any key the contract does not name.
const Strict = { node: NodeDto.strict(), trash: TrashItemDto.strict(), hit: SearchResultDto.strict() };

const SHA = "ab".repeat(32);
const DAY = 86_400_000;

/** An owner with a shared folder, a friend who edits in it, and one file of every interesting kind. */
async function library() {
  const owner = await makeUser({ name: `Olive ${rand()}` });
  const friend = await makeUser({ name: `Farid ${rand()}` });
  const folder = await makeFolder(owner.id, null, { starred: true });
  const image = await makeFile(owner.id, folder.id, {
    name: `photo-${rand()}.png`,
    scanStatus: "clean",
    mimeSniffed: "image/png",
    sha256: SHA,
    starred: true,
    lastAccessedAt: new Date(Date.now() - DAY),
    scanDetail: { pua: ["PUA.Win.Packer.Test"], signatures: ["Sig.Internal.Test"], engine: "stub" },
  });
  // Uploaded by the friend into the owner's folder: owner and uploader differ.
  const theirs = await makeFile(owner.id, folder.id, {
    name: `notes-${rand()}.pdf`,
    createdBy: friend.id,
    scanStatus: "skipped",
    scanReason: "size",
    mimeSniffed: "application/pdf",
    sha256: SHA,
  });
  await makeShare(folder.id, owner.id, friend.id, { role: "editor" });
  await makeShare(folder.id, owner.id, baId(), { granteeUserId: null, activatedAt: null });
  return { owner, friend, folder, image, theirs };
}

const asOwner = (id: string) => ({ viewerId: id, role: "owner" as const });
const asEditor = (id: string) => ({ viewerId: id, role: "editor" as const });

describe("toNodeDto", () => {
  it("the owner's view: every field, parsed strictly", async () => {
    const t = await library();
    const [folder, image, theirs] = await toNodeDtos(
      testDb(),
      [t.folder, t.image, t.theirs],
      asOwner(t.owner.id),
    );
    for (const dto of [folder, image, theirs]) Strict.node.parse(dto);

    expect(image).toEqual({
      id: t.image.id,
      parentId: t.folder.id,
      kind: "file",
      name: t.image.name,
      ext: "png",
      size: 100,
      mimeCategory: "image",
      mimeSniffed: "image/png",
      etag: t.image.versionId,
      sha256: SHA,
      scanStatus: "clean",
      scanReason: null,
      pua: ["PUA.Win.Packer.Test"],
      thumb: true,
      starred: true,
      createdAt: t.image.createdAt.toISOString(),
      updatedAt: t.image.updatedAt.toISOString(),
      lastAccessedAt: t.image.lastAccessedAt!.toISOString(),
      deletedAt: null,
      purgeAfter: null,
      owner: { id: t.owner.id, displayName: t.owner.name },
      createdBy: { id: t.owner.id, displayName: t.owner.name },
      role: "owner",
      sharing: { people: 0, link: "none", summary: "none" },
    });
    // Two share rows on the folder itself — the accepted one and the pending one.
    expect(folder).toMatchObject({
      kind: "folder",
      etag: "",
      mimeCategory: "other",
      thumb: false,
      starred: true,
      sharing: { people: 2, link: "none", summary: "people" },
    });
    expect(theirs).toMatchObject({
      scanStatus: "skipped",
      scanReason: "size",
      thumb: false,
      mimeCategory: "pdf",
      owner: { id: t.owner.id, displayName: t.owner.name },
      createdBy: { id: t.friend.id, displayName: t.friend.name },
    });
  });

  it("sharing: people, link, both — the best link state, for the owner only", async () => {
    const t = await library();
    const link = (nodeId: string, overrides: Partial<typeof shareLinks.$inferInsert> = {}) =>
      testDb()
        .insert(shareLinks)
        .values({
          nodeId,
          createdBy: t.owner.id,
          tokenHash: rand(32),
          tokenEnc: crypto.getRandomValues(new Uint8Array(48)),
          tokenIv: crypto.getRandomValues(new Uint8Array(12)),
          ...overrides,
        });
    await link(t.folder.id);
    await link(t.image.id, { expiresAt: new Date(Date.now() - DAY) });
    const sharing = async (view: { viewerId: string; role: "owner" | "editor" }) =>
      (await toNodeDtos(testDb(), [t.folder, t.image, t.theirs], view)).map((dto) => dto.sharing);

    expect(await sharing(asOwner(t.owner.id))).toEqual([
      { people: 2, link: "active", summary: "both" },
      { people: 0, link: "expired", summary: "link" },
      { people: 0, link: "none", summary: "none" },
    ]);
    const none = { people: 0, link: "none", summary: "none" };
    expect(await sharing(asEditor(t.friend.id))).toEqual([none, none, none]);
  });

  it("a non-owner's view: the zero value of everything that is the owner's", async () => {
    const t = await library();
    const rows = [t.folder, t.image, t.theirs];
    const mine = await toNodeDtos(testDb(), rows, asOwner(t.owner.id));
    const shared = await toNodeDtos(testDb(), rows, asEditor(t.friend.id));
    for (const dto of shared) Strict.node.parse(dto);

    for (const dto of shared) {
      expect(dto.role).toBe("editor");
      expect(dto.sharing).toEqual({ people: 0, link: "none", summary: "none" });
      expect(dto.starred).toBe(false);
      expect(dto.lastAccessedAt).toBeNull();
      expect(dto.sha256).toBeNull();
      expect(dto.scanReason).toBeNull();
      expect(dto.pua).toEqual([]);
    }
    // The control: the same rows carry each of those for the owner.
    expect(mine[0]!.sharing.people).toBe(2);
    expect(mine[0]!.starred).toBe(true);
    expect(mine[1]!.lastAccessedAt).not.toBeNull();
    expect(mine[1]!.sha256).toBe(SHA);
    expect(mine[1]!.pua).toHaveLength(1);
    expect(mine[2]!.scanReason).toBe("size");
    // What both see alike.
    expect(shared[1]).toMatchObject({
      name: t.image.name,
      etag: t.image.versionId,
      thumb: true,
      owner: mine[1]!.owner,
      createdBy: mine[1]!.createdBy,
    });
  });

  it("a grantee's share root goes out without its parent; rows inside the share keep theirs", async () => {
    const t = await library();
    // The shared folder sits inside a folder of the owner's that is not shared.
    const above = await makeFolder(t.owner.id, null);
    await testDb().update(nodes).set({ parentId: above.id }).where(eq(nodes.id, t.folder.id));
    const root = (await nodeById(t.folder.id))!;
    const rows = [root, t.image];
    const parents = async (view: Parameters<typeof toNodeDtos>[2]) =>
      (await toNodeDtos(testDb(), rows, view)).map((dto) => Strict.node.parse(dto).parentId);

    expect(await parents({ ...asEditor(t.friend.id), shareRootId: root.id })).toEqual([null, root.id]);
    expect(
      JSON.stringify(await toNodeDtos(testDb(), rows, { ...asEditor(t.friend.id), shareRootId: root.id })),
    ).not.toContain(above.id);
    // The owner sees where their own folder is, whatever the view names.
    expect(await parents({ ...asOwner(t.owner.id), shareRootId: root.id })).toEqual([above.id, root.id]);
    expect(await parents(asOwner(t.owner.id))).toEqual([above.id, root.id]);
    // Without a share root named, nothing is hidden: naming it is the caller's part.
    expect(await parents({ ...asEditor(t.friend.id), shareRootId: null })).toEqual([above.id, root.id]);

    // A search hit without a path hint is the root of a share (or at the top level).
    const hits = await toSearchResultDtos(
      testDb(),
      [
        { node: root, pathHint: null, role: "editor" },
        { node: t.image, pathHint: root.name, role: "editor" },
      ],
      { viewerId: t.friend.id },
    );
    expect(hits.map((hit) => Strict.hit.parse(hit).parentId)).toEqual([null, root.id]);
    const own = await toSearchResultDtos(testDb(), [{ node: root, pathHint: above.name, role: "owner" }], {
      viewerId: t.owner.id,
    });
    expect(own[0]!.parentId).toBe(above.id);
  });

  it("never an email, an object key or the scan's internals — in any variant, for anyone", async () => {
    const t = await library();
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true, purgeAfter: new Date(Date.now() + 30 * DAY) })
      .where(eq(nodes.id, t.theirs.id));
    const trashed = (await nodeById(t.theirs.id))!;
    const rows = [t.folder, t.image, t.theirs];
    const hits = (role: "owner" | "editor") =>
      rows.map((node) => ({ node, pathHint: node.parentId ? t.folder.name : null, role }));
    const everything = JSON.stringify([
      await toNodeDtos(testDb(), rows, asOwner(t.owner.id)),
      await toNodeDtos(testDb(), rows, asEditor(t.friend.id)),
      await toTrashItemDtos(testDb(), [trashed], asOwner(t.owner.id)),
      await toTrashItemDtos(testDb(), [trashed], asEditor(t.friend.id)),
      await toSearchResultDtos(testDb(), hits("owner"), { viewerId: t.owner.id }),
      await toSearchResultDtos(testDb(), hits("editor"), { viewerId: t.friend.id }),
      [...(await displayNames(testDb(), [t.owner.id, t.friend.id]))],
    ]);

    // The control for the assertions below: the names ARE there.
    expect(everything).toContain(t.owner.name);
    expect(everything).toContain(t.friend.name);
    expect(everything).not.toContain("@");
    expect(everything.toLowerCase()).not.toContain(t.owner.email.toLowerCase());
    expect(everything.toLowerCase()).not.toContain(t.friend.email.toLowerCase());
    expect(t.image.r2Key).toBeTruthy();
    expect(everything).not.toContain(t.image.r2Key);
    expect(everything).not.toContain(`u/${t.owner.id}`);
    expect(everything).not.toContain("Sig.Internal.Test");
    expect(everything).not.toContain("stub");
  });

  it("a name that is the user's own address goes out empty", async () => {
    const plain = await makeUser();
    const id = baId();
    // A made-up address at a reserved test domain.
    const address = `${id.toLowerCase()}@services-core.example.test`;
    const addressed = await makeUser({ id, email: address, name: address.toUpperCase() });
    const file = await makeFile(addressed.id, null, { scanStatus: "clean" });

    const names = await displayNames(testDb(), [plain.id, addressed.id, baId()]);
    expect([...names].sort()).toEqual(
      [
        [plain.id, plain.name],
        [addressed.id, ""],
      ].sort(),
    );
    const dto = Strict.node.parse(await toNodeDto(testDb(), file, asOwner(addressed.id)));
    expect(dto.owner).toEqual({ id: addressed.id, displayName: "" });
  });

  it("thumb is true only for a clean image", async () => {
    const owner = await makeUser();
    const png = { mimeSniffed: "image/png" } as const;
    const rows = [
      await makeFile(owner.id, null, { ...png, scanStatus: "clean" }),
      await makeFile(owner.id, null, { ...png, scanStatus: "pending" }),
      await makeFile(owner.id, null, { ...png, scanStatus: "infected" }),
      await makeFile(owner.id, null, { ...png, scanStatus: "under_review" }),
      await makeFile(owner.id, null, { ...png, scanStatus: "skipped", scanReason: "size" }),
      await makeFile(owner.id, null, { ...png, scanStatus: "error", scanReason: "engine" }),
      await makeFile(owner.id, null, { mimeSniffed: "application/pdf", scanStatus: "clean" }),
    ];
    const dtos = await toNodeDtos(testDb(), rows, asOwner(owner.id));
    for (const dto of dtos) Strict.node.parse(dto);
    expect(dtos.map((dto) => dto.thumb)).toEqual([true, false, false, false, false, false, false]);
    expect(dtos.map((dto) => dto.scanStatus)).toEqual(rows.map((row) => row.scanStatus));
  });

  it("createdBy is null for an anonymised uploader; a role given as a function is asked per row", async () => {
    const owner = await makeUser();
    const friend = await makeUser();
    const anonymous = await makeFile(owner.id, null, { createdBy: null, scanStatus: "clean" });
    const own = await makeFile(friend.id, null, { scanStatus: "clean" });

    const [first, second] = await toNodeDtos(testDb(), [anonymous, own], {
      viewerId: friend.id,
      role: (row) => (row.ownerId === friend.id ? "owner" : "viewer"),
    });
    expect(Strict.node.parse(first)).toMatchObject({ id: anonymous.id, createdBy: null, role: "viewer" });
    expect(Strict.node.parse(second)).toMatchObject({ id: own.id, role: "owner" });
    expect(await toNodeDtos(testDb(), [], asOwner(owner.id))).toEqual([]);
  });

  it("refuses a role that does not agree with the owner, and a node nobody may see", async () => {
    const t = await library();
    const db = testDb();
    await expect(toNodeDto(db, t.image, asOwner(t.friend.id))).rejects.toThrow(/role/);
    await expect(toNodeDto(db, t.image, asEditor(t.owner.id))).rejects.toThrow(/role/);
    await expect(
      toSearchResultDtos(db, [{ node: t.image, pathHint: null, role: "owner" }], { viewerId: t.friend.id }),
    ).rejects.toThrow(/role/);

    const owner = asOwner(t.owner.id);
    await expect(toNodeDto(db, { ...t.image, scanStatus: "suspected_csam" }, owner)).rejects.toThrow(
      /hidden/,
    );
    await expect(toNodeDto(db, { ...t.image, takedownAt: new Date() }, owner)).rejects.toThrow(/hidden/);
    await expect(toNodeDto(db, { ...t.image, system: "avatar" }, owner)).rejects.toThrow(/hidden/);
    // One such row refuses the whole page: nothing of it is answered.
    await expect(
      toNodeDtos(db, [t.folder, { ...t.image, scanStatus: "suspected_csam" }], owner),
    ).rejects.toThrow(/hidden/);
    // The control: the same row, as it is.
    expect((await toNodeDto(db, t.image, owner)).id).toBe(t.image.id);
  });

  it("a page costs the same statements whatever its length", async () => {
    const t = await library();
    const db = testDb();
    const files = [t.folder, t.image, t.theirs];
    for (let i = 0; i < 22; i++) {
      files.push(
        await makeFile(t.owner.id, t.folder.id, {
          scanStatus: "clean",
          createdBy: i % 2 ? t.friend.id : t.owner.id,
        }),
      );
    }
    const cost = async (work: () => Promise<unknown>) => {
      const before = statementsSent(db);
      await work();
      return statementsSent(db) - before;
    };
    // The control: the counter counts.
    expect(await cost(() => displayNames(db, [t.owner.id]))).toBe(1);

    // The owner: one names read and one `sharingSummary` call (its two statements).
    expect(await cost(() => toNodeDtos(db, files.slice(0, 1), asOwner(t.owner.id)))).toBe(3);
    expect(await cost(() => toNodeDtos(db, files, asOwner(t.owner.id)))).toBe(3);
    // Anyone else: the names read alone — sharing is not even asked.
    expect(await cost(() => toNodeDtos(db, files.slice(0, 1), asEditor(t.friend.id)))).toBe(1);
    expect(await cost(() => toNodeDtos(db, files, asEditor(t.friend.id)))).toBe(1);
    expect(await cost(() => toNodeDtos(db, [], asOwner(t.owner.id)))).toBe(0);
    const hits = files.map((node) => ({ node, pathHint: null, role: "owner" as const }));
    expect(await cost(() => toSearchResultDtos(db, hits, { viewerId: t.owner.id }))).toBe(3);

    const dtos = await toNodeDtos(db, files, asOwner(t.owner.id));
    expect(dtos.map((dto) => dto.id)).toEqual(files.map((row) => row.id));
  });
});

describe("toTrashItemDto", () => {
  it("carries deletedAt and purgeAfter, and refuses a node that is not in the trash", async () => {
    const t = await library();
    const db = testDb();
    const deletedAt = new Date(Date.now() - DAY);
    const purgeAfter = new Date(Date.now() + 29 * DAY);
    await db
      .update(nodes)
      .set({ deletedAt, trashedRoot: true, purgeAfter, trashedBy: t.friend.id })
      .where(eq(nodes.id, t.theirs.id));
    const trashed = (await nodeById(t.theirs.id))!;

    const mine = Strict.trash.parse(await toTrashItemDto(db, trashed, asOwner(t.owner.id)));
    expect(mine).toMatchObject({
      id: trashed.id,
      deletedAt: deletedAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
      scanReason: "size",
      role: "owner",
    });
    // The editor who trashed it gets the same row under the non-owner rules.
    const theirs = Strict.trash.parse(await toTrashItemDto(db, trashed, asEditor(t.friend.id)));
    expect(theirs).toMatchObject({ deletedAt: deletedAt.toISOString(), scanReason: null, sha256: null });
    // Outside the trash variant the two stay null, for the same row.
    expect(await toNodeDto(db, trashed, asOwner(t.owner.id))).toMatchObject({
      deletedAt: null,
      purgeAfter: null,
    });

    await expect(toTrashItemDto(db, t.image, asOwner(t.owner.id))).rejects.toThrow(/not in the trash/);
    await expect(toTrashItemDtos(db, [trashed, t.image], asOwner(t.owner.id))).rejects.toThrow(
      /not in the trash/,
    );
    await expect(toTrashItemDto(db, { ...trashed, purgeAfter: null }, asOwner(t.owner.id))).rejects.toThrow(
      /not in the trash/,
    );
  });
});

describe("toSearchResultDtos", () => {
  it("each hit under its own role; a null path hint goes out as an empty string", async () => {
    const t = await library();
    const mineToo = await makeFile(t.friend.id, null, { scanStatus: "clean" });
    const hits = [
      { node: t.folder, pathHint: null, role: "editor" as const },
      { node: t.image, pathHint: t.folder.name, role: "editor" as const },
      { node: mineToo, pathHint: null, role: "owner" as const },
    ];
    const dtos = await toSearchResultDtos(testDb(), hits, { viewerId: t.friend.id });
    for (const dto of dtos) Strict.hit.parse(dto);
    expect(dtos.map((dto) => [dto.id, dto.role, dto.pathHint])).toEqual([
      [t.folder.id, "editor", ""],
      [t.image.id, "editor", t.folder.name],
      [mineToo.id, "owner", ""],
    ]);
    expect(dtos[1]!.sha256).toBeNull();
    expect(await toSearchResultDtos(testDb(), [], { viewerId: t.friend.id })).toEqual([]);
  });

  it("a deleted account's display name is not invented", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    // A row as a listing read it, whose uploader's account has gone since.
    const dto = await toNodeDto(testDb(), { ...file, createdBy: baId() }, asOwner(owner.id));
    expect(Strict.node.parse(dto).createdBy).toBeNull();
    await expect(
      toNodeDto(testDb(), { ...file, ownerId: baId() }, { viewerId: owner.id, role: "viewer" }),
    ).rejects.toThrow(/no user row/);
    expect((await testDb().select({ id: user.id }).from(user).where(eq(user.id, owner.id))).length).toBe(1);
  });
});
