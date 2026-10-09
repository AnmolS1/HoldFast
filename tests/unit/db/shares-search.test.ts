import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { QueryError } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import { OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import { escapeLike, searchNames } from "../../../src/worker/db/queries/search";
import {
  activatePendingShares,
  countGrantees,
  findShare,
  hasShareBetween,
  sharedByMe,
  sharedWithMe,
} from "../../../src/worker/db/queries/shares";
import { effectiveRole } from "../../../src/worker/db/queries/tree";
import { nodes, shares, user } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeShare, makeUser, openDb, rand, rejection } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const OWNER = OWNER_VISIBLE_STATUSES;
const emailOf = async (userId: string) =>
  (await db.select({ email: user.email }).from(user).where(eq(user.id, userId)))[0]!.email;

describe("shares", () => {
  it("findShare returns the activated direct share only; countGrantees counts pending rows too", async () => {
    const owner = await makeUser(db);
    const friend = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `s-${rand()}`);
    const child = await makeFile(db, owner, folder.id, "c.txt");
    const share = await makeShare(db, folder.id, owner, { userId: friend }, { role: "editor" });
    await makeShare(db, folder.id, owner, { email: `p-${rand()}@example.test` });

    expect(await findShare(db, { nodeId: folder.id, granteeUserId: friend })).toMatchObject({
      id: share.id,
      role: "editor",
      canUpload: true,
    });
    expect(await findShare(db, { nodeId: child.id, granteeUserId: friend })).toBeNull();
    expect(await findShare(db, { nodeId: folder.id, granteeUserId: owner })).toBeNull();
    expect(await findShare(db, { nodeId: "junk", granteeUserId: friend })).toBeNull();
    expect(await countGrantees(db, folder.id)).toBe(2);
    expect(await countGrantees(db, child.id)).toBe(0);
    expect(typeof (await countGrantees(db, folder.id))).toBe("number");
  });

  it("hasShareBetween: an active share in either direction, never a pending one", async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    const c = await makeUser(db);
    const d = await makeUser(db);
    const folder = await makeFolder(db, a, null, `rel-${rand()}`);
    await makeShare(db, folder.id, a, { userId: b });
    await makeShare(db, folder.id, a, { email: await emailOf(c) });
    expect(await hasShareBetween(db, a, b)).toBe(true);
    expect(await hasShareBetween(db, b, a)).toBe(true);
    expect(await hasShareBetween(db, a, c)).toBe(false);
    expect(await hasShareBetween(db, c, a)).toBe(false);
    expect(await hasShareBetween(db, b, d)).toBe(false);
    expect(await hasShareBetween(db, b, c)).toBe(false);
    expect(await hasShareBetween(db, a, a)).toBe(true);
  });

  it("activatePendingShares turns the address's pending rows into grants, case-insensitively", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const newcomer = await makeUser(db);
    const address = await emailOf(newcomer);
    const one = await makeFolder(db, owner, null, `one-${rand()}`);
    const two = await makeFolder(db, other, null, `two-${rand()}`);
    const file = await makeFile(db, owner, one.id, "inside.txt");
    await makeShare(db, one.id, owner, { email: address.toUpperCase() }, { role: "editor" });
    await makeShare(db, two.id, other, { email: address });
    const stranger = await makeShare(db, one.id, owner, { email: `someone-else-${rand()}@example.test` });

    expect(await effectiveRole(db, newcomer, file.id)).toBeNull();
    const activated = await activatePendingShares(db, newcomer, address);
    expect(activated.map((s) => s.nodeId).sort()).toEqual([one.id, two.id].sort());
    for (const share of activated) {
      expect(share.granteeUserId).toBe(newcomer);
      expect(share.activatedAt).toBeInstanceOf(Date);
      // The address as the owner typed it is kept.
      expect(share.granteeEmail.toLowerCase()).toBe(address.toLowerCase());
    }
    expect(await effectiveRole(db, newcomer, file.id)).toBe("editor");
    expect(await effectiveRole(db, newcomer, two.id)).toBe("viewer");
    const [untouched] = await db.select().from(shares).where(eq(shares.id, stranger.id));
    expect(untouched).toMatchObject({ granteeUserId: null, activatedAt: null });
    expect(await activatePendingShares(db, newcomer, address)).toEqual([]);
  });

  it("activation does not duplicate a share the user already holds on the node", async () => {
    const owner = await makeUser(db);
    const grantee = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `dup-${rand()}`);
    const direct = await makeShare(db, folder.id, owner, { userId: grantee }, { role: "viewer" });
    const newAddress = `new-${rand()}@example.test`;
    await makeShare(db, folder.id, owner, { email: newAddress }, { role: "editor" });

    expect(await activatePendingShares(db, grantee, newAddress)).toEqual([]);
    const rows = await db.select().from(shares).where(eq(shares.nodeId, folder.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: direct.id, granteeUserId: grantee, role: "viewer" });
  });

  it("sharedWithMe: active shares on live nodes of active owners; sharedByMe: everything I granted", async () => {
    const me = await makeUser(db);
    const good = await makeUser(db);
    const suspended = await makeUser(db, { suspendedAt: new Date() });
    const banned = await makeUser(db, { banned: true });
    const banExpired = await makeUser(db, { banned: true, banExpires: new Date(Date.now() - 60_000) });
    const leaving = await makeUser(db, { deleteScheduledAt: new Date(Date.now() + 86_400_000) });

    const visible = await makeFolder(db, good, null, `visible-${rand()}`);
    const visibleShare = await makeShare(db, visible.id, good, { userId: me }, { role: "editor" });
    const fromExpiredBan = await makeFolder(db, banExpired, null, `ok-${rand()}`);
    await makeShare(db, fromExpiredBan.id, banExpired, { userId: me });
    for (const owner of [suspended, banned, leaving]) {
      const folder = await makeFolder(db, owner, null, `hidden-${rand()}`);
      await makeShare(db, folder.id, owner, { userId: me });
    }
    const trashed = await makeFolder(db, good, null, `trashed-${rand()}`, {
      deletedAt: new Date(),
      trashedRoot: true,
    });
    await makeShare(db, trashed.id, good, { userId: me });
    const insideTrash = await makeFile(db, good, trashed.id, "inside.txt");
    await makeShare(db, insideTrash.id, good, { userId: me });
    const down = await makeFile(db, good, null, `down-${rand()}.txt`, { takedownAt: new Date() });
    await makeShare(db, down.id, good, { userId: me });
    const pendingOnly = await makeFolder(db, good, null, `pending-${rand()}`);
    await makeShare(db, pendingOnly.id, good, { email: await emailOf(me) });

    const mine = await sharedWithMe(db, me);
    expect(mine.map((r) => r.node.id).sort()).toEqual([visible.id, fromExpiredBan.id].sort());
    const entry = mine.find((r) => r.node.id === visible.id)!;
    expect(entry.share).toMatchObject({ id: visibleShare.id, role: "editor", granteeUserId: me });
    expect(entry.node).toMatchObject({ ownerId: good, name: visible.name });

    const granted = await sharedByMe(db, good);
    expect(granted.map((r) => r.node.id).sort()).toEqual(
      [visible.id, trashed.id, insideTrash.id, down.id, pendingOnly.id].sort(),
    );
    expect(granted.find((r) => r.node.id === pendingOnly.id)!.share).toMatchObject({
      granteeUserId: null,
      activatedAt: null,
    });
    expect(await sharedByMe(db, me)).toEqual([]);
  });
});

describe("searchNames", () => {
  /** A unique token keeps this fixture apart from every other row in the database. */
  async function library() {
    const token = `q${rand(5)}`;
    const me = await makeUser(db);
    const friend = await makeUser(db);
    const docs = await makeFolder(db, me, null, `${token} documents`);
    const prefix = await makeFile(db, me, docs.id, `${token}-budget.xlsx`, {
      mimeSniffed: "application/vnd.ms-excel",
    });
    const word = await makeFile(db, me, docs.id, `annual ${token} report.pdf`, {
      mimeSniffed: "application/pdf",
    });
    const inner = await makeFile(db, me, null, `x${token}y.txt`, { mimeSniffed: "text/plain" });
    const pending = await makeFile(db, me, docs.id, `${token}-pending.png`, {
      scanStatus: "pending",
      mimeSniffed: null,
    });
    const csam = await makeFile(db, me, null, `${token}-quarantined.bin`, { scanStatus: "suspected_csam" });
    const avatar = await makeFile(db, me, null, `${token}-avatar`, { system: "avatar" });
    const down = await makeFile(db, me, null, `${token}-taken-down.txt`, { takedownAt: new Date() });
    const trashed = await makeFile(db, me, null, `${token}-trashed.txt`, {
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const bin = await makeFolder(db, me, null, `bin-${rand()}`, { deletedAt: new Date(), trashedRoot: true });
    const inBin = await makeFile(db, me, bin.id, `${token}-in-trashed-folder.txt`);

    const theirs = await makeFolder(db, friend, null, `their-${rand()}`);
    const sharedClean = await makeFile(db, friend, theirs.id, `${token}-shared.txt`);
    const sharedInfected = await makeFile(db, friend, theirs.id, `${token}-shared-infected.exe`, {
      scanStatus: "infected",
    });
    const notShared = await makeFile(db, friend, null, `${token}-private.txt`);
    await makeShare(db, theirs.id, friend, { userId: me }, { role: "editor" });
    return {
      token,
      me,
      friend,
      docs,
      prefix,
      word,
      inner,
      pending,
      csam,
      avatar,
      down,
      trashed,
      inBin,
      theirs,
      sharedClean,
      sharedInfected,
      notShared,
    };
  }

  it("mine: ranks a name prefix, then a word prefix, then the rest; hides what listings hide", async () => {
    const lib = await library();
    const result = await searchNames(db, lib.me, lib.token, {
      scope: "mine",
      visibleStatuses: OWNER,
      limit: 50,
    });
    const ids = result.items.map((hit) => hit.node.id);
    // The three names that START with the token come first (among themselves by similarity),
    // then the name with a WORD that starts with it, then the name that merely contains it.
    expect(ids).toHaveLength(5);
    expect(ids.slice(0, 3).sort()).toEqual([lib.prefix.id, lib.docs.id, lib.pending.id].sort());
    expect(ids.slice(3)).toEqual([lib.word.id, lib.inner.id]);
    for (const hidden of [
      lib.csam,
      lib.avatar,
      lib.down,
      lib.trashed,
      lib.inBin,
      lib.sharedClean,
      lib.notShared,
    ]) {
      expect(ids).not.toContain(hidden.id);
    }
    expect(result.items.every((hit) => hit.role === "owner")).toBe(true);
    expect(result.items.find((hit) => hit.node.id === lib.prefix.id)!.pathHint).toBe(lib.docs.name);
    expect(result.items.find((hit) => hit.node.id === lib.docs.id)!.pathHint).toBeNull();
    expect(result.nextCursor).toBeNull();
  });

  it("visibleStatuses hides suspected_csam from the owner and non-clean files from a grantee", async () => {
    const lib = await library();
    const shared = await searchNames(db, lib.me, lib.token, {
      scope: "shared",
      visibleStatuses: ["clean"],
      limit: 50,
    });
    expect(shared.items.map((hit) => hit.node.id)).toEqual([lib.sharedClean.id]);
    expect(shared.items[0]).toMatchObject({ role: "editor", pathHint: lib.theirs.name });

    const all = await searchNames(db, lib.me, lib.token, {
      scope: "all",
      visibleStatuses: { mine: OWNER, shared: ["clean"] },
      limit: 50,
    });
    const ids = all.items.map((hit) => hit.node.id);
    expect(ids).toContain(lib.pending.id);
    expect(ids).toContain(lib.sharedClean.id);
    expect(ids).not.toContain(lib.sharedInfected.id);
    expect(ids).not.toContain(lib.csam.id);
    expect(ids).not.toContain(lib.notShared.id);
    expect(new Set(ids).size).toBe(ids.length);

    // One list for both sides would leak the owner's rule to shared rows: refused.
    const error = await rejection(
      searchNames(db, lib.me, lib.token, { scope: "all", visibleStatuses: OWNER, limit: 50 }),
    );
    expect((error as QueryError).code).toBe("validation");
    expect(
      (await searchNames(db, lib.me, lib.token, { scope: "mine", visibleStatuses: [], limit: 50 })).items,
    ).toEqual([]);
  });

  it("shared: nothing from a pending share, an inactive owner or a trashed share root", async () => {
    const lib = await library();
    const query = { scope: "shared", visibleStatuses: ["clean"], limit: 50 } as const;
    const outsider = await makeUser(db);
    await makeShare(db, lib.theirs.id, lib.friend, { email: `pending-${rand()}@example.test` });
    expect((await searchNames(db, outsider, lib.token, query)).items).toEqual([]);
    // A row that names the user but was never activated grants nothing either.
    const half = await makeUser(db);
    const inactive = await makeShare(db, lib.theirs.id, lib.friend, { userId: half });
    expect((await searchNames(db, half, lib.token, query)).items).toHaveLength(1);
    await db.update(shares).set({ activatedAt: null }).where(eq(shares.id, inactive.id));
    expect((await searchNames(db, half, lib.token, query)).items).toEqual([]);

    await db.update(user).set({ suspendedAt: new Date() }).where(eq(user.id, lib.friend));
    expect((await searchNames(db, lib.me, lib.token, query)).items).toEqual([]);
    await db.update(user).set({ suspendedAt: null }).where(eq(user.id, lib.friend));
    expect((await searchNames(db, lib.me, lib.token, query)).items).toHaveLength(1);

    await db
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true })
      .where(eq(nodes.id, lib.theirs.id));
    expect((await searchNames(db, lib.me, lib.token, query)).items).toEqual([]);
  });

  it("filters by kind, category (sniffed type, or extension while unsniffed) and folder", async () => {
    const lib = await library();
    const base = { scope: "mine", visibleStatuses: OWNER, limit: 50 } as const;
    const ids = async (extra: object) =>
      (await searchNames(db, lib.me, lib.token, { ...base, ...extra })).items.map((hit) => hit.node.id);

    expect(await ids({ kind: "folder" })).toEqual([lib.docs.id]);
    expect((await ids({ kind: "file" })).sort()).toEqual(
      [lib.prefix.id, lib.pending.id, lib.word.id, lib.inner.id].sort(),
    );
    expect(await ids({ category: { mimes: ["application/pdf"], exts: ["pdf"] } })).toEqual([lib.word.id]);
    // The pending image has no sniffed type yet: it matches by extension.
    expect(await ids({ category: { mimes: ["image/png", "image/jpeg"], exts: ["png", "jpg"] } })).toEqual([
      lib.pending.id,
    ]);
    // A sniffed type wins over the extension: the .xlsx is not an image, whatever the list says.
    expect(await ids({ category: { mimes: ["image/png"], exts: ["xlsx"] } })).toEqual([]);
    expect(await ids({ category: { mimes: [], exts: [] } })).toEqual([]);
    expect((await ids({ inFolder: lib.docs.id })).sort()).toEqual(
      [lib.prefix.id, lib.pending.id, lib.word.id].sort(),
    );
    expect(await ids({ inFolder: uuidv7() })).toEqual([]);
    expect(await ids({ inFolder: "junk" })).toEqual([]);
  });

  it("treats %, _ and \\ in the query as plain characters", async () => {
    const me = await makeUser(db);
    const tag = rand(4);
    const percent = await makeFile(db, me, null, `100%-${tag}.txt`);
    const underscore = await makeFile(db, me, null, `snake_case-${tag}.txt`);
    const backslash = await makeFile(db, me, null, `back\\slash-${tag}.txt`);
    await makeFile(db, me, null, `100x-${tag}.txt`);
    await makeFile(db, me, null, `snakeXcase-${tag}.txt`);
    const search = async (q: string) =>
      (
        await searchNames(db, me, q, { scope: "mine", visibleStatuses: OWNER, limit: 50, threshold: 1 })
      ).items.map((hit) => hit.node.id);
    expect(await search(`100%-${tag}`)).toEqual([percent.id]);
    expect(await search(`snake_case-${tag}`)).toEqual([underscore.id]);
    expect(await search(`back\\slash-${tag}`)).toEqual([backslash.id]);
    expect(await search(`%-${tag}`)).toEqual([percent.id]);
    expect(escapeLike("50%_off\\now")).toBe("50\\%\\_off\\\\now");
  });

  it("finds a near miss by trigram similarity, and a higher threshold drops it", async () => {
    const me = await makeUser(db);
    const word = `zylophonic${rand(3)}`;
    const file = await makeFile(db, me, null, `${word}.txt`);
    const typo = word.replace("ph", "f");
    const fuzzy = await searchNames(db, me, typo, { scope: "mine", visibleStatuses: OWNER, limit: 10 });
    expect(fuzzy.items.map((hit) => hit.node.id)).toEqual([file.id]);
    const strict = await searchNames(db, me, typo, {
      scope: "mine",
      visibleStatuses: OWNER,
      limit: 10,
      threshold: 0.99,
    });
    expect(strict.items).toEqual([]);
  });

  it("pages with an opaque cursor that belongs to one query", async () => {
    const me = await makeUser(db);
    const token = `pg${rand(5)}`;
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push((await makeFile(db, me, null, `${token}-${i}.txt`)).id);
    const base = { scope: "mine", visibleStatuses: OWNER, limit: 3 } as const;
    const first = await searchNames(db, me, token, base);
    const second = await searchNames(db, me, token, { ...base, cursor: first.nextCursor });
    const third = await searchNames(db, me, token, { ...base, cursor: second.nextCursor });
    expect([first, second, third].map((page) => page.items.length)).toEqual([3, 3, 1]);
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((hit) => hit.node.id)).toEqual(made);

    const stranger = await makeUser(db);
    const bad: (() => Promise<unknown>)[] = [
      () => searchNames(db, me, `${token}x`, { ...base, cursor: first.nextCursor }),
      () =>
        searchNames(db, me, token, {
          ...base,
          scope: "shared",
          visibleStatuses: ["clean"],
          cursor: first.nextCursor,
        }),
      () => searchNames(db, stranger, token, { ...base, cursor: first.nextCursor }),
      () => searchNames(db, me, token, { ...base, cursor: "garbage" }),
      () => searchNames(db, me, "   ", base),
      () => searchNames(db, me, token, { ...base, limit: 0 }),
    ];
    for (const attempt of bad) {
      expect(((await rejection(attempt())) as QueryError).code).toBe("validation");
    }
  });
});
