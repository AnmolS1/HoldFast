// GET /api/recent and GET /api/starred, through the real routes: the caller's own nodes only,
// in the listed order, without what is hidden from everyone, in the shared shapes.
import { describe, expect, it } from "vitest";
import { RecentResponse, StarredResponse } from "../../../src/shared/schemas/search";
import { makeFile, makeFolder, makeShare, makeUser } from "../services-core/helpers";
import { get, type Answer, type Caller } from "./helpers";

type UserRow = Awaited<ReturnType<typeof makeUser>>;
const as = (row: UserRow): Caller => ({ user: row });
const errorOf = (answer: Answer) => (answer.body as { error?: string }).error;
const clean = { scanStatus: "clean" } as const;

/** Minutes before a fixed instant: each row is given its own time, the clock is never moved. */
const BASE = Date.parse("2026-09-01T12:00:00.000Z");
const ago = (minutes: number) => new Date(BASE - minutes * 60_000);

const recent = (answer: Answer) => {
  expect(answer.status).toBe(200);
  return RecentResponse.parse(answer.body);
};
const starred = (answer: Answer) => {
  expect(answer.status).toBe(200);
  return StarredResponse.parse(answer.body);
};

/** One of each thing no listing shows, each opened a moment ago and starred. */
async function hiddenRows(ownerId: string) {
  const at = new Date();
  const mark = { lastAccessedAt: ago(0), starred: true } as const;
  const down = { takedownAt: at, takedownReason: "abuse" } as const;
  const trashed = await makeFile(ownerId, null, { deletedAt: at, trashedRoot: true, ...mark, ...clean });
  const bin = await makeFolder(ownerId, null, { deletedAt: at, trashedRoot: true });
  const inBin = await makeFile(ownerId, bin.id, { ...mark, ...clean });
  const avatar = await makeFile(ownerId, null, { system: "avatar", ...mark, ...clean });
  const takenDown = await makeFile(ownerId, null, { ...down, ...mark, ...clean });
  const downFolder = await makeFolder(ownerId, null, { ...down, starred: true });
  const underDown = await makeFile(ownerId, downFolder.id, { ...mark, ...clean });
  const locked = await makeFile(ownerId, null, { scanStatus: "suspected_csam", ...mark });
  return [trashed, inBin, avatar, takenDown, downFolder, underDown, locked].map((row) => row.id);
}

describe("GET /api/recent", () => {
  it("lists the caller's opened files, the latest first, then by the latest change", async () => {
    const me = await makeUser();
    const older = await makeFile(me.id, null, { lastAccessedAt: ago(30), ...clean });
    const newest = await makeFile(me.id, null, { lastAccessedAt: ago(1) });
    // Opened at the same instant: the one changed later comes first.
    const tieOld = await makeFile(me.id, null, { lastAccessedAt: ago(10), updatedAt: ago(500), ...clean });
    const tieNew = await makeFile(me.id, null, { lastAccessedAt: ago(10), updatedAt: ago(400), ...clean });
    const neverOpened = await makeFile(me.id, null, { ...clean });
    const folder = await makeFolder(me.id, null, { lastAccessedAt: ago(0) });

    const answer = await get(as(me), "/recent");
    const body = recent(answer);
    expect(Object.keys(answer.body as object)).toEqual(["items"]);
    expect(body.items.map((item) => item.id)).toEqual([newest.id, tieNew.id, tieOld.id, older.id]);
    expect(body.items.map((item) => item.id)).not.toContain(neverOpened.id);
    expect(body.items.map((item) => item.id)).not.toContain(folder.id);
    expect(body.items.every((item) => item.role === "owner" && item.owner.id === me.id)).toBe(true);
    expect(body.items[0]!.lastAccessedAt).toBe(ago(1).toISOString());
  });

  it("takes a limit of 1 to 50 and gives 20 without one", async () => {
    const me = await makeUser();
    const made: string[] = [];
    for (let i = 0; i < 22; i++) {
      made.push((await makeFile(me.id, null, { lastAccessedAt: ago(i), ...clean })).id);
    }
    expect(recent(await get(as(me), "/recent")).items.map((item) => item.id)).toEqual(made.slice(0, 20));
    expect(recent(await get(as(me), "/recent?limit=3")).items.map((item) => item.id)).toEqual(
      made.slice(0, 3),
    );
    expect(recent(await get(as(me), "/recent?limit=50")).items).toHaveLength(22);
    for (const path of ["/recent?limit=51", "/recent?limit=0", "/recent?limit=x", "/recent?cursor=abc"]) {
      const answer = await get(as(me), path);
      expect(answer.status, path).toBe(400);
      expect(errorOf(answer), path).toBe("validation");
    }
  });

  it("never lists another user's files — not even ones shared with the caller", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const shared = await makeFolder(owner.id);
    await makeFile(owner.id, shared.id, { lastAccessedAt: ago(1), ...clean });
    await makeFile(owner.id, null, { lastAccessedAt: ago(2), ...clean });
    await makeShare(shared.id, owner.id, me.id, { role: "editor" });
    const mine = await makeFile(me.id, null, { lastAccessedAt: ago(3), ...clean });
    expect(recent(await get(as(me), "/recent")).items.map((item) => item.id)).toEqual([mine.id]);
    // The owner's own request lists both of theirs.
    expect(recent(await get(as(owner), "/recent")).items).toHaveLength(2);
  });

  it("leaves out the trash, the avatar, anything taken down or under it, and a locked file", async () => {
    const me = await makeUser();
    const shown = await makeFile(me.id, null, { lastAccessedAt: ago(5), ...clean });
    const hidden = await hiddenRows(me.id);
    const ids = recent(await get(as(me), "/recent?limit=50")).items.map((item) => item.id);
    expect(ids).toEqual([shown.id]);
    for (const id of hidden) expect(ids).not.toContain(id);
  });

  it("needs a signed-in, verified user", async () => {
    expect((await get(null, "/recent")).status).toBe(401);
    const unverified = await makeUser({ emailVerified: false });
    const answer = await get(as(unverified), "/recent");
    expect(answer.status).toBe(403);
    expect(errorOf(answer)).toBe("forbidden");
  });
});

describe("GET /api/starred", () => {
  it("pages through the caller's starred nodes by name, folders first", async () => {
    const me = await makeUser();
    const star = { starred: true } as const;
    const folderB = await makeFolder(me.id, null, { name: "b folder", ...star });
    const folderA = await makeFolder(me.id, null, { name: "a folder", ...star });
    const fileC = await makeFile(me.id, null, { name: "c.txt", ...star, ...clean });
    const fileA = await makeFile(me.id, folderA.id, { name: "a.txt", ...star });
    const fileB = await makeFile(me.id, null, { name: "b.txt", ...star, ...clean });
    await makeFile(me.id, null, { name: "not starred.txt", ...clean });
    const order = [folderA.id, folderB.id, fileA.id, fileB.id, fileC.id];

    const whole = await get(as(me), "/starred");
    expect(Object.keys(whole.body as object).sort()).toEqual(["items", "nextCursor"]);
    expect(starred(whole).items.map((item) => item.id)).toEqual(order);
    expect(starred(whole).nextCursor).toBeNull();
    expect(starred(whole).items.every((item) => item.starred && item.role === "owner")).toBe(true);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = cursor
        ? `/starred?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "/starred?limit=2";
      const body = starred(await get(as(me), path));
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(order);
  });

  it("takes a limit of 1 to 200 and no other key", async () => {
    const me = await makeUser();
    expect((await get(as(me), "/starred?limit=200")).status).toBe(200);
    for (const path of [
      "/starred?limit=201",
      "/starred?limit=0",
      "/starred?cursor=",
      "/starred?cursor=not-a-cursor",
      "/starred?sort=name",
    ]) {
      const answer = await get(as(me), path);
      expect(answer.status, path).toBe(400);
      expect(errorOf(answer), path).toBe("validation");
    }
  });

  it("never lists another user's nodes — not even ones shared with the caller", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const shared = await makeFolder(owner.id, null, { starred: true });
    await makeFile(owner.id, shared.id, { starred: true, ...clean });
    await makeShare(shared.id, owner.id, me.id, { role: "editor" });
    const mine = await makeFile(me.id, null, { starred: true, ...clean });
    expect(starred(await get(as(me), "/starred")).items.map((item) => item.id)).toEqual([mine.id]);
    expect(starred(await get(as(owner), "/starred")).items).toHaveLength(2);
    // A cursor is one user's: the owner's does not page the caller's list.
    const first = starred(await get(as(owner), "/starred?limit=1"));
    const answer = await get(as(me), `/starred?cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toBe("validation");
  });

  it("leaves out the trash, the avatar, anything taken down or under it, and a locked file", async () => {
    const me = await makeUser();
    const shown = await makeFile(me.id, null, { starred: true });
    const hidden = await hiddenRows(me.id);
    const ids = starred(await get(as(me), "/starred?limit=200")).items.map((item) => item.id);
    expect(ids).toEqual([shown.id]);
    for (const id of hidden) expect(ids).not.toContain(id);
  });

  it("needs a signed-in, verified user", async () => {
    expect((await get(null, "/starred")).status).toBe(401);
    const unverified = await makeUser({ emailVerified: false });
    const answer = await get(as(unverified), "/starred");
    expect(answer.status).toBe(403);
    expect(errorOf(answer)).toBe("forbidden");
  });
});
