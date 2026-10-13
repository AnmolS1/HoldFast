// GET /api/search, through the real route: matching and ranking, who sees what in each scope,
// what is hidden from everyone, `inFolder`, the category filter, the query's validation, the
// answer's shape — and that the query text reaches nothing but the database.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIME_CATEGORIES, MIME_CATEGORY_NAMES } from "../../../src/shared/constants";
import { SearchResponse } from "../../../src/shared/schemas/search";
import { uuidv7 } from "../../../src/worker/db/ids";
import { auditRows, makePendingShare } from "../auth/helpers";
import { makeFile, makeFolder, makeShare, makeUser, rand } from "../services-core/helpers";
import { get, searchPath, type Answer, type Caller } from "./helpers";

type UserRow = Awaited<ReturnType<typeof makeUser>>;
const as = (row: UserRow): Caller => ({ user: row });

/** A token no other test's names contain: letters only, so it is one word to pg_trgm. */
const token = () =>
  "q" + Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => "abcdefghijklmnop"[b % 16]).join("");

const page = (answer: Answer) => {
  expect(answer.status).toBe(200);
  return SearchResponse.parse(answer.body);
};
const namesOf = (answer: Answer) => page(answer).items.map((item) => item.name);
const idsOf = (answer: Answer) => page(answer).items.map((item) => item.id);
const errorOf = (answer: Answer) => (answer.body as { error?: string }).error;

const SCOPES = ["mine", "shared", "all"] as const;
const clean = { scanStatus: "clean" } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("matching and ranking", () => {
  it("finds a name through a typo", async () => {
    const me = await makeUser();
    await makeFile(me.id, null, { name: "report.pdf", ...clean });
    await makeFile(me.id, null, { name: "holiday.jpg", ...clean });
    // A transposition, a wrong letter, a dropped letter.
    for (const q of ["reprot", "reporr", "reprt"]) {
      expect(namesOf(await get(as(me), searchPath({ q, scope: "mine" }))), q).toEqual(["report.pdf"]);
    }
  });

  it("ranks a name that starts with the query, then a word that starts with it, then the rest", async () => {
    const me = await makeUser();
    const t = token();
    await makeFile(me.id, null, { name: `inside${t}here.txt`, ...clean });
    await makeFile(me.id, null, { name: `my ${t} notes.txt`, ...clean });
    await makeFile(me.id, null, { name: `${t} plan.txt`, ...clean });
    expect(namesOf(await get(as(me), searchPath({ q: t, scope: "mine" })))).toEqual([
      `${t} plan.txt`,
      `my ${t} notes.txt`,
      `inside${t}here.txt`,
    ]);
  });

  it("takes % and _ and \\ in the query as themselves", async () => {
    const me = await makeUser();
    await makeFile(me.id, null, { name: "50%% off.txt", ...clean });
    await makeFile(me.id, null, { name: "snake__case.txt", ...clean });
    await makeFile(me.id, null, { name: "back\\\\slash.txt", ...clean });
    await makeFile(me.id, null, { name: "plain words.txt", ...clean });
    // As LIKE wildcards "%%" and "__" would match every name here; as text, one each.
    expect(namesOf(await get(as(me), searchPath({ q: "%%", scope: "mine" })))).toEqual(["50%% off.txt"]);
    expect(namesOf(await get(as(me), searchPath({ q: "__", scope: "mine" })))).toEqual(["snake__case.txt"]);
    expect(namesOf(await get(as(me), searchPath({ q: "\\\\", scope: "mine" })))).toEqual([
      "back\\\\slash.txt",
    ]);
  });

  it("pages with a cursor that belongs to its own query", async () => {
    const me = await makeUser();
    const t = token();
    for (let i = 0; i < 5; i++) await makeFile(me.id, null, { name: `${t} ${i}.txt`, ...clean });
    const first = page(await get(as(me), searchPath({ q: t, scope: "mine", limit: 2 })));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = page(
      await get(as(me), searchPath({ q: t, scope: "mine", limit: 2, cursor: first.nextCursor! })),
    );
    const third = page(
      await get(as(me), searchPath({ q: t, scope: "mine", limit: 2, cursor: second.nextCursor! })),
    );
    expect(third.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items, ...third.items].map((item) => item.name);
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4].map((i) => `${t} ${i}.txt`));

    const other = await get(as(me), searchPath({ q: `${t}x`, scope: "mine", cursor: first.nextCursor! }));
    expect(other.status).toBe(400);
    expect(errorOf(other)).toBe("validation");
  });
});

describe("scopes", () => {
  /**
   * owner's tree:  shared/ ← an activated viewer share to `me`
   *                  inner/
   *                    <t> deep.txt         clean
   *                  <t> clean.txt          clean
   *                  <t> pending.txt        pending
   *                  <t> infected.txt       infected
   *                invited/ ← a share to an address with no account (pending)
   *                  <t> invited.txt        clean
   *                <t> private.txt          clean, shared with nobody
   * me:            <t> mine.txt             clean
   *                <t> mine pending.txt     pending
   */
  async function world() {
    const t = token();
    const owner = await makeUser();
    const me = await makeUser();
    const shared = await makeFolder(owner.id, null, { name: "shared with me" });
    const inner = await makeFolder(owner.id, shared.id, { name: "inner" });
    const deep = await makeFile(owner.id, inner.id, { name: `${t} deep.txt`, ...clean });
    const sharedClean = await makeFile(owner.id, shared.id, { name: `${t} clean.txt`, ...clean });
    const sharedPending = await makeFile(owner.id, shared.id, { name: `${t} pending.txt` });
    const sharedInfected = await makeFile(owner.id, shared.id, {
      name: `${t} infected.txt`,
      scanStatus: "infected",
    });
    const invited = await makeFolder(owner.id, null, { name: "invited" });
    const invitedFile = await makeFile(owner.id, invited.id, { name: `${t} invited.txt`, ...clean });
    const privateFile = await makeFile(owner.id, null, { name: `${t} private.txt`, ...clean });
    await makeShare(shared.id, owner.id, me.id);
    await makePendingShare(invited.id, owner.id, me.email);
    const mine = await makeFile(me.id, null, { name: `${t} mine.txt`, ...clean });
    const minePending = await makeFile(me.id, null, { name: `${t} mine pending.txt` });
    return {
      t,
      owner,
      me,
      shared,
      inner,
      deep,
      sharedClean,
      sharedPending,
      sharedInfected,
      invitedFile,
      privateFile,
      mine,
      minePending,
    };
  }

  it("another user's files appear in no scope; a share that was never accepted exposes nothing", async () => {
    const w = await world();
    const stranger = await makeUser();
    for (const scope of SCOPES) {
      const ids = idsOf(await get(as(w.me), searchPath({ q: w.t, scope })));
      expect(ids).not.toContain(w.privateFile.id);
      expect(ids).not.toContain(w.invitedFile.id);
      // Someone with no share at all finds nothing of either user's.
      expect(idsOf(await get(as(stranger), searchPath({ q: w.t, scope })))).toEqual([]);
    }
    // The owner does find both: the names match, only the caller differs.
    const own = idsOf(await get(as(w.owner), searchPath({ q: w.t, scope: "mine" })));
    expect(own).toContain(w.privateFile.id);
    expect(own).toContain(w.invitedFile.id);
  });

  it("mine is the caller's own tree, shared is what was shared with them, all is both", async () => {
    const w = await world();
    const search = async (scope: string) => idsOf(await get(as(w.me), searchPath({ q: w.t, scope }))).sort();
    const mine = [w.mine.id, w.minePending.id].sort();
    const shared = [w.deep.id, w.sharedClean.id].sort();
    expect(await search("mine")).toEqual(mine);
    expect(await search("shared")).toEqual(shared);
    expect(await search("all")).toEqual([...mine, ...shared].sort());
    // The default scope is `all`.
    expect(idsOf(await get(as(w.me), searchPath({ q: w.t }))).sort()).toEqual([...mine, ...shared].sort());
  });

  it("a grantee sees only clean files; the owner's own side keeps its own rule in `all`", async () => {
    const w = await world();
    for (const scope of ["shared", "all"] as const) {
      const ids = idsOf(await get(as(w.me), searchPath({ q: w.t, scope })));
      expect(ids).toContain(w.sharedClean.id);
      expect(ids).not.toContain(w.sharedPending.id);
      expect(ids).not.toContain(w.sharedInfected.id);
    }
    // One list per side: the caller's own pending file is theirs to see in `all`.
    expect(idsOf(await get(as(w.me), searchPath({ q: w.t, scope: "all" })))).toContain(w.minePending.id);
    // The owner sees their own pending and infected files.
    const own = idsOf(await get(as(w.owner), searchPath({ q: w.t, scope: "mine" })));
    expect(own).toContain(w.sharedPending.id);
    expect(own).toContain(w.sharedInfected.id);
  });

  it("a grantee is shown no file that is not clean, whatever else its state is called", async () => {
    const w = await world();
    const notClean = ["pending", "infected", "under_review", "skipped", "error", "suspected_csam"] as const;
    const made = new Map<string, string>();
    for (const scanStatus of notClean) {
      const file = await makeFile(w.owner.id, w.inner.id, {
        name: `${w.t} state ${scanStatus}.txt`,
        scanStatus,
      });
      made.set(scanStatus, file.id);
    }
    for (const scope of ["shared", "all"] as const) {
      const found = page(await get(as(w.me), searchPath({ q: w.t, scope, limit: 50 })));
      for (const id of made.values()) expect(found.items.map((item) => item.id)).not.toContain(id);
      // No answer names a state a grantee may not know of (a file under review was reported).
      expect(found.items.filter((item) => item.role !== "owner").map((item) => item.scanStatus)).toEqual(
        found.items.filter((item) => item.role !== "owner").map(() => "clean"),
      );
    }
    // The owner sees every one of them but the locked file.
    const own = idsOf(await get(as(w.owner), searchPath({ q: w.t, scope: "mine", limit: 50 })));
    for (const [status, id] of made) {
      if (status === "suspected_csam") expect(own).not.toContain(id);
      else expect(own, status).toContain(id);
    }
  });

  it("what a suspended, banned or leaving owner shared is found by no grantee, and is no folder to search in", async () => {
    const t = token();
    const me = await makeUser();
    const active = await makeUser();
    const owners = [
      await makeUser({ suspendedAt: new Date() }),
      await makeUser({ banned: true }),
      await makeUser({ deleteScheduledAt: new Date(Date.now() + 86_400_000) }),
    ];
    const gone: string[] = [];
    const folders: string[] = [];
    for (const owner of [active, ...owners]) {
      const folder = await makeFolder(owner.id);
      const file = await makeFile(owner.id, folder.id, {
        name: `${t} of ${owner.id.slice(0, 6)}.txt`,
        ...clean,
      });
      await makeShare(folder.id, owner.id, me.id);
      if (owner !== active) {
        gone.push(file.id);
        folders.push(folder.id);
      }
    }
    for (const scope of ["shared", "all"] as const) {
      const ids = idsOf(await get(as(me), searchPath({ q: t, scope })));
      // Only the active owner's file: the fixture is live, the other three are absent.
      expect(ids).toHaveLength(1);
      for (const id of gone) expect(ids).not.toContain(id);
    }
    const unknown = await get(as(me), searchPath({ q: t, inFolder: uuidv7() }));
    const withoutId = (answer: Answer) => ({ ...(answer.body as object), requestId: "" });
    for (const folder of folders) {
      const answer = await get(as(me), searchPath({ q: t, inFolder: folder }));
      expect(answer.status).toBe(404);
      expect(withoutId(answer)).toEqual(withoutId(unknown));
    }
  });

  it("a file locked as suspected CSAM is found by nobody, its owner included", async () => {
    const w = await world();
    const locked = await makeFile(w.owner.id, w.shared.id, {
      name: `${w.t} locked.txt`,
      scanStatus: "suspected_csam",
    });
    for (const scope of SCOPES) {
      expect(idsOf(await get(as(w.owner), searchPath({ q: w.t, scope })))).not.toContain(locked.id);
      expect(idsOf(await get(as(w.me), searchPath({ q: w.t, scope })))).not.toContain(locked.id);
    }
  });

  it("the trash, the avatar and anything taken down are found by nobody, in every scope", async () => {
    const w = await world();
    const at = new Date();
    const down = { takedownAt: at, takedownReason: "abuse" } as const;
    const trashed = await makeFile(w.owner.id, w.shared.id, {
      name: `${w.t} trashed.txt`,
      deletedAt: at,
      trashedRoot: true,
      ...clean,
    });
    const bin = await makeFolder(w.owner.id, w.shared.id, { name: "bin", deletedAt: at, trashedRoot: true });
    const inBin = await makeFile(w.owner.id, bin.id, { name: `${w.t} in bin.txt`, ...clean });
    const avatar = await makeFile(w.owner.id, null, {
      name: `${w.t} avatar.png`,
      system: "avatar",
      ...clean,
    });
    const takenDown = await makeFile(w.owner.id, w.shared.id, {
      name: `${w.t} taken.txt`,
      ...down,
      ...clean,
    });
    const downFolder = await makeFolder(w.owner.id, w.shared.id, { name: `${w.t} down folder`, ...down });
    const underDown = await makeFile(w.owner.id, downFolder.id, { name: `${w.t} under.txt`, ...clean });
    const hidden = [trashed, inBin, avatar, takenDown, downFolder, underDown].map((row) => row.id);

    for (const scope of SCOPES) {
      for (const caller of [w.owner, w.me]) {
        const found = page(await get(as(caller), searchPath({ q: w.t, scope, limit: 50 })));
        for (const id of hidden) expect(found.items.map((item) => item.id)).not.toContain(id);
        // Not as a path hint either: nothing names the taken-down folder.
        expect(found.items.map((item) => item.pathHint)).not.toContain(downFolder.name);
      }
    }
    // The fixture is live: what sits beside the hidden rows is found.
    expect(idsOf(await get(as(w.owner), searchPath({ q: w.t, scope: "mine" })))).toContain(w.sharedClean.id);
    expect(idsOf(await get(as(w.me), searchPath({ q: w.t, scope: "shared" })))).toContain(w.sharedClean.id);
  });
});

describe("inFolder", () => {
  it("restricts the results to that folder's content, at any depth", async () => {
    const me = await makeUser();
    const t = token();
    const folder = await makeFolder(me.id);
    const inner = await makeFolder(me.id, folder.id);
    const direct = await makeFile(me.id, folder.id, { name: `${t} direct.txt`, ...clean });
    const deep = await makeFile(me.id, inner.id, { name: `${t} deep.txt`, ...clean });
    await makeFile(me.id, null, { name: `${t} outside.txt`, ...clean });
    const ids = idsOf(await get(as(me), searchPath({ q: t, scope: "mine", inFolder: folder.id })));
    expect(ids.sort()).toEqual([direct.id, deep.id].sort());
  });

  it("works for a folder shared with the caller", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const t = token();
    const shared = await makeFolder(owner.id);
    const inner = await makeFolder(owner.id, shared.id);
    const deep = await makeFile(owner.id, inner.id, { name: `${t} deep.txt`, ...clean });
    await makeFile(owner.id, shared.id, { name: `${t} beside.txt`, ...clean });
    await makeShare(shared.id, owner.id, me.id);
    expect(idsOf(await get(as(me), searchPath({ q: t, inFolder: inner.id })))).toEqual([deep.id]);
  });

  it("is 404 for a folder the caller has no role on — the same answer as for an id nobody has", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const t = token();
    const theirs = await makeFolder(owner.id);
    await makeFile(owner.id, theirs.id, { name: `${t} theirs.txt`, ...clean });
    const invited = await makeFolder(owner.id);
    await makePendingShare(invited.id, owner.id, me.email);
    const down = { takedownAt: new Date(), takedownReason: "abuse" } as const;
    const takenDown = await makeFolder(me.id, null, down);
    const underTakenDown = await makeFolder(me.id, takenDown.id);
    const locked = await makeFile(me.id, null, { scanStatus: "suspected_csam" });
    // Shared with the caller, then taken down: the share is no way in.
    const sharedDown = await makeFolder(owner.id, null, down);
    const underSharedDown = await makeFolder(owner.id, sharedDown.id);
    await makeShare(sharedDown.id, owner.id, me.id, { role: "editor" });

    const unknown = await get(as(me), searchPath({ q: t, inFolder: uuidv7() }));
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown)).toBe("not_found");
    const withoutId = (answer: Answer) => ({ ...(answer.body as object), requestId: "" });
    for (const folder of [theirs, invited, takenDown, underTakenDown, locked, sharedDown, underSharedDown]) {
      const answer = await get(as(me), searchPath({ q: t, inFolder: folder.id }));
      expect(answer.status).toBe(404);
      expect(withoutId(answer)).toEqual(withoutId(unknown));
    }
    // The owner's own request for the same folder is answered.
    expect(namesOf(await get(as(owner), searchPath({ q: t, inFolder: theirs.id })))).toEqual([
      `${t} theirs.txt`,
    ]);
  });

  it("is 404 for a folder in the trash — itself or by a folder above it — for a grantee and for its owner", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const t = token();
    const shared = await makeFolder(owner.id);
    const live = await makeFile(owner.id, shared.id, { name: `${t} live.txt`, ...clean });
    const trashed = await makeFolder(owner.id, shared.id, { deletedAt: new Date(), trashedRoot: true });
    const under = await makeFolder(owner.id, trashed.id);
    await makeFile(owner.id, under.id, { name: `${t} binned.txt`, ...clean });
    await makeShare(shared.id, owner.id, me.id);

    const unknown = await get(as(me), searchPath({ q: t, inFolder: uuidv7() }));
    expect(unknown.status).toBe(404);
    const withoutId = (answer: Answer) => ({ ...(answer.body as object), requestId: "" });
    for (const caller of [me, owner]) {
      for (const folder of [trashed, under]) {
        const answer = await get(as(caller), searchPath({ q: t, inFolder: folder.id }));
        expect(answer.status).toBe(404);
        expect(withoutId(answer)).toEqual(withoutId(unknown));
      }
      // The folder they sit in is searched as before.
      expect(idsOf(await get(as(caller), searchPath({ q: t, inFolder: shared.id })))).toEqual([live.id]);
    }
  });

  it("costs the same statements whatever makes it a 404: no such id, no role, in the trash", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const t = token();
    const theirs = await makeFolder(owner.id);
    const shared = await makeFolder(owner.id);
    const trashed = await makeFolder(owner.id, shared.id, { deletedAt: new Date(), trashedRoot: true });
    const underTrashed = await makeFolder(owner.id, trashed.id);
    const mineTrashed = await makeFolder(me.id, null, { deletedAt: new Date(), trashedRoot: true });
    await makeShare(shared.id, owner.id, me.id);

    const cost = async (inFolder: string) => {
      const answer = await get(as(me), searchPath({ q: t, inFolder }));
      expect(answer.status).toBe(404);
      return answer.statements;
    };
    const unknown = await cost(uuidv7());
    // Something was counted: the role's questions and the trash's, at the least.
    expect(unknown).toBeGreaterThanOrEqual(4);
    // A folder the caller may see but that is in the trash is refused by the SECOND question; an
    // id they have no role on by the first. Answering after the first would make these differ.
    expect({
      foreign: await cost(theirs.id),
      trashedShared: await cost(trashed.id),
      underTrashedShared: await cost(underTrashed.id),
      ownTrashed: await cost(mineTrashed.id),
    }).toEqual({
      foreign: unknown,
      trashedShared: unknown,
      underTrashedShared: unknown,
      ownTrashed: unknown,
    });
  });

  it("is 400 for an id that is not a node id", async () => {
    const me = await makeUser();
    const answer = await get(as(me), searchPath({ q: "anything", inFolder: "root" }));
    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toBe("validation");
  });
});

describe("category and kind", () => {
  const listed = MIME_CATEGORY_NAMES.filter((name) => name !== "other");

  it("every category finds its files by detected type, and by extension before a scan has run", async () => {
    const me = await makeUser();
    const t = token();
    for (const name of listed) {
      const { types, exts } = MIME_CATEGORIES[name];
      // Detected: the name's extension says nothing. Not yet scanned: only the extension speaks.
      await makeFile(me.id, null, { name: `${t} ${name} detected`, mimeSniffed: types[0], ...clean });
      await makeFile(me.id, null, { name: `${t} ${name} waiting.${exts[0]}`, mimeSniffed: null });
    }
    await makeFile(me.id, null, {
      name: `${t} other detected`,
      mimeSniffed: "application/x-made-up",
      ...clean,
    });
    await makeFile(me.id, null, { name: `${t} other waiting.zzz`, mimeSniffed: null });
    await makeFolder(me.id, null, { name: `${t} folder` });

    for (const name of MIME_CATEGORY_NAMES) {
      const found = page(await get(as(me), searchPath({ q: t, scope: "mine", category: name, limit: 50 })));
      const ext = name === "other" ? "zzz" : MIME_CATEGORIES[name].exts[0];
      expect(found.items.map((item) => item.name).sort()).toEqual(
        [`${t} ${name} detected`, `${t} ${name} waiting.${ext}`].sort(),
      );
      // The label on each hit is the category that was asked for.
      expect(found.items.map((item) => item.mimeCategory)).toEqual([name, name]);
    }
  });

  it("a file is found under the category its answer shows, and under no other", async () => {
    const me = await makeUser();
    const t = token();
    // Sniffed as nothing in particular: the extension is the label. A specific type is never
    // overruled by the name.
    await makeFile(me.id, null, { name: `${t} script.py`, mimeSniffed: "text/plain", ...clean });
    await makeFile(me.id, null, {
      name: `${t} blob.jpg`,
      mimeSniffed: "application/octet-stream",
      ...clean,
    });
    await makeFile(me.id, null, { name: `${t} program.jpg`, mimeSniffed: "application/zip", ...clean });
    await makeFile(me.id, null, { name: `${t} readme`, mimeSniffed: "text/plain", ...clean });

    const everything = page(await get(as(me), searchPath({ q: t, scope: "mine" })));
    const shown = new Map(everything.items.map((item) => [item.name, item.mimeCategory]));
    expect(shown.get(`${t} script.py`)).toBe("code");
    expect(shown.get(`${t} blob.jpg`)).toBe("image");
    expect(shown.get(`${t} program.jpg`)).toBe("archive");
    for (const name of MIME_CATEGORY_NAMES) {
      const found = namesOf(await get(as(me), searchPath({ q: t, scope: "mine", category: name })));
      const expected = [...shown].filter(([, category]) => category === name).map(([file]) => file);
      expect(found.sort(), name).toEqual(expected.sort());
    }
  });

  it("refuses a category that is not one of the eight, and any other name for the filter", async () => {
    const me = await makeUser();
    const refused: Record<string, string>[] = [
      { q: "report", category: "doc" },
      { q: "report", category: "images" },
      { q: "report", category: "" },
      { q: "report", mime: "image" },
      { q: "report", type: "image" },
    ];
    for (const params of refused) {
      const answer = await get(as(me), searchPath(params));
      expect(answer.status).toBe(400);
      expect(errorOf(answer)).toBe("validation");
    }
  });

  it("kind keeps files or folders", async () => {
    const me = await makeUser();
    const t = token();
    const folder = await makeFolder(me.id, null, { name: `${t} folder` });
    const file = await makeFile(me.id, null, { name: `${t} file.txt`, ...clean });
    expect(idsOf(await get(as(me), searchPath({ q: t, scope: "mine", kind: "folder" })))).toEqual([
      folder.id,
    ]);
    expect(idsOf(await get(as(me), searchPath({ q: t, scope: "mine", kind: "file" })))).toEqual([file.id]);
  });
});

describe("the query", () => {
  it("is refused when it does not parse as SearchQuery", async () => {
    const me = await makeUser();
    for (const path of [
      "/search",
      searchPath({ q: "a" }),
      searchPath({ q: "a".repeat(101) }),
      searchPath({ q: "report", limit: 51 }),
      searchPath({ q: "report", limit: 0 }),
      searchPath({ q: "report", scope: "everyone" }),
      searchPath({ q: "report", kind: "link" }),
      searchPath({ q: "report", cursor: "" }),
      searchPath({ q: "report", cursor: "not-a-cursor" }),
      searchPath({ q: "report", sort: "name" }),
      searchPath({ q: "  " }),
    ]) {
      const answer = await get(as(me), path);
      expect(answer.status, path).toBe(400);
      expect(errorOf(answer), path).toBe("validation");
    }
    expect((await get(as(me), searchPath({ q: "a".repeat(100) }))).status).toBe(200);
    expect((await get(as(me), searchPath({ q: "ab", limit: 50 }))).status).toBe(200);
  });

  it("needs a signed-in, verified user", async () => {
    const signedOut = await get(null, searchPath({ q: "report" }));
    expect(signedOut.status).toBe(401);
    expect(errorOf(signedOut)).toBe("unauthorized");
    const unverified = await makeUser({ emailVerified: false });
    const answer = await get(as(unverified), searchPath({ q: "report" }));
    expect(answer.status).toBe(403);
    expect(errorOf(answer)).toBe("forbidden");
  });
});

describe("the answer", () => {
  it("is a page of nodes, each with the caller's role and a path hint that is always text", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const t = token();
    const folder = await makeFolder(owner.id, null, { name: `Reports ${rand()}` });
    const top = await makeFile(owner.id, null, { name: `${t} top.txt`, ...clean });
    const inFolder = await makeFile(owner.id, folder.id, { name: `${t} in folder.txt`, ...clean });
    const sharedRoot = await makeFolder(owner.id, folder.id, { name: `${t} shared root` });
    const sharedFile = await makeFile(owner.id, sharedRoot.id, { name: `${t} shared file.txt`, ...clean });
    await makeShare(sharedRoot.id, owner.id, me.id, { role: "editor" });

    const answer = await get(as(owner), searchPath({ q: t, scope: "mine" }));
    // The page parses as it was sent: no hint is null, none is missing.
    const own = page(answer);
    expect(Object.keys(answer.body as object).sort()).toEqual(["items", "nextCursor"]);
    expect(own.nextCursor).toBeNull();
    const hint = (id: string, items = own.items) => items.find((item) => item.id === id)?.pathHint;
    expect(hint(top.id)).toBe("");
    expect(hint(inFolder.id)).toBe(folder.name);
    expect(hint(sharedFile.id)).toBe(sharedRoot.name);
    expect(own.items.every((item) => item.role === "owner")).toBe(true);
    expect(own.items.every((item) => item.owner.id === owner.id)).toBe(true);

    // The grantee: the share's role; and above the share's root there is no name to show.
    const theirs = page(await get(as(me), searchPath({ q: t, scope: "shared" })));
    expect(theirs.items.map((item) => item.id).sort()).toEqual([sharedRoot.id, sharedFile.id].sort());
    expect(hint(sharedRoot.id, theirs.items)).toBe("");
    expect(hint(sharedFile.id, theirs.items)).toBe(sharedRoot.name);
    expect(theirs.items.every((item) => item.role === "editor")).toBe(true);
    // Nothing of the owner's own folder above the share: not its name, not its id.
    expect(JSON.stringify(theirs)).not.toContain(folder.name);
    expect(JSON.stringify(theirs)).not.toContain(folder.id);
    expect(theirs.items.find((item) => item.id === sharedRoot.id)?.parentId).toBeNull();
    expect(own.items.find((item) => item.id === sharedRoot.id)?.parentId).toBe(folder.id);
  });

  it("tells a grantee nothing about how the owner shares the node", async () => {
    const owner = await makeUser();
    const me = await makeUser();
    const other = await makeUser();
    const t = token();
    const folder = await makeFolder(owner.id, null, { name: `${t} folder`, ...clean });
    await makeShare(folder.id, owner.id, me.id);
    await makeShare(folder.id, owner.id, other.id);
    const mine = page(await get(as(owner), searchPath({ q: t, scope: "mine" })));
    expect(mine.items[0]!.sharing).toEqual({ people: 2, link: "none", summary: "people" });
    const theirs = page(await get(as(me), searchPath({ q: t, scope: "shared" })));
    expect(theirs.items[0]!.id).toBe(folder.id);
    expect(theirs.items[0]!.sharing).toEqual({ people: 0, link: "none", summary: "none" });
  });
});

describe("the query text stays out of everything but the database", () => {
  it("the audit row has the query's length and the scope; no log line, metric or row has its text", async () => {
    const me = await makeUser();
    const q = `zebra${token()}crossing`;
    await makeFile(me.id, null, { name: `${q}.txt`, ...clean });
    // Spied on, not silenced: what is logged still reaches the run's output, where it can be searched.
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    );

    const found = await get(as(me), searchPath({ q, scope: "mine" }));
    expect(namesOf(found)).toEqual([`${q}.txt`]);
    // Refused requests carry the text too: a bad limit, and a folder that is not the caller's.
    const refused = await get(as(me), searchPath({ q, scope: "mine", limit: 99 }));
    expect(refused.status).toBe(400);
    const missing = await get(as(me), searchPath({ q, inFolder: uuidv7() }));
    expect(missing.status).toBe(404);

    const rows = await auditRows({ action: "search.query", actorUserId: me.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ length: q.length, scope: "mine" });
    expect(rows[0]!.targetType).toBeNull();
    expect(rows[0]!.targetId).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(q);

    const metrics = [...found.metrics, ...refused.metrics, ...missing.metrics];
    expect(metrics.length).toBeGreaterThan(0);
    expect(JSON.stringify(metrics)).not.toContain(q);
    expect(refused.text).not.toContain(q);
    expect(missing.text).not.toContain(q);
    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")));
    expect(logged.join("\n")).not.toContain(q);
  });
});
