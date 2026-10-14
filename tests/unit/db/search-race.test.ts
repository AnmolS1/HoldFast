// `searchNames` reads twice: the ranked ids, then the rows of the window. Between the two a row
// can be taken down, locked, trashed or change its scan status. What the second read returns is
// what leaves the function, so it has to apply the exclusions again: a row that no longer passes
// is dropped from the page — never handed on (the mapper refuses a hidden row: a 500), and never
// shown once to a grantee as `under_review`.
//
// The seam: the handle is wrapped so that a change is committed right after the ranked read has
// answered and before the row read is sent.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { OWNER_VISIBLE_STATUSES, SHARED_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import { searchNames, type SearchOptions } from "../../../src/worker/db/queries/search";
import { nodes } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeShare, makeUser, openDb, rand } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

/** The handle, with `between()` run once — after the `after`-th ranked read (`execute`) has answered. */
function withChangeBetweenReads(between: () => Promise<void>, after = 1): Db {
  let ranked = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return async (...args: Parameters<Db["execute"]>) => {
          const result = await target.execute(...args);
          ranked += 1;
          if (ranked === after) await between();
          return result;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** owner: folder/ { <token>-hit.txt, <token>-stays.txt }, the folder shared with a grantee. */
async function library() {
  const owner = await makeUser(db);
  const grantee = await makeUser(db);
  // Short on purpose (under five characters): the word fallback never runs, one ranked read per side.
  const token = `q${rand(1)}z`;
  const folder = await makeFolder(db, owner, null, `folder-${rand()}`);
  const hit = await makeFile(db, owner, folder.id, `${token}-hit.txt`, { scanStatus: "clean" });
  const stays = await makeFile(db, owner, folder.id, `${token}-stays.txt`, { scanStatus: "clean" });
  await makeShare(db, folder.id, owner, { userId: grantee });
  return { owner, grantee, token, folder, hit, stays };
}

const set = (id: string, values: Partial<typeof nodes.$inferInsert>) => async () => {
  await db.update(nodes).set(values).where(eq(nodes.id, id));
};

type Lib = Awaited<ReturnType<typeof library>>;
const changes: Record<string, { change: (l: Lib) => () => Promise<void>; owner: boolean; grantee: boolean }> =
  {
    "taken down": {
      change: (l) => set(l.hit.id, { takedownAt: new Date(), takedownReason: "abuse" }),
      owner: false,
      grantee: false,
    },
    "its folder taken down": {
      change: (l) => set(l.folder.id, { takedownAt: new Date(), takedownReason: "dmca" }),
      owner: false,
      grantee: false,
    },
    "locked as suspected CSAM": {
      change: (l) => set(l.hit.id, { scanStatus: "suspected_csam", legalHold: true }),
      owner: false,
      grantee: false,
    },
    trashed: {
      change: (l) => set(l.hit.id, { deletedAt: new Date(), trashedRoot: true }),
      owner: false,
      grantee: false,
    },
    // The owner sees their own file under review or infected; a grantee must not, not even once.
    "reported (under review)": {
      change: (l) => set(l.hit.id, { scanStatus: "under_review" }),
      owner: true,
      grantee: false,
    },
    "found infected": {
      change: (l) => set(l.hit.id, { scanStatus: "infected" }),
      owner: true,
      grantee: false,
    },
    "replaced (pending again)": {
      change: (l) => set(l.hit.id, { scanStatus: "pending" }),
      owner: true,
      grantee: false,
    },
  };

describe("searchNames: a row that changes between the ranked read and the row read", () => {
  it.each(Object.keys(changes))(
    "%s: dropped from the page where its reader may no longer see it",
    async (name) => {
      const spec = changes[name]!;
      const sides: [
        keyof Pick<Lib, "owner" | "grantee">,
        SearchOptions["scope"],
        SearchOptions["visibleStatuses"],
        boolean,
      ][] = [
        ["owner", "mine", OWNER_VISIBLE_STATUSES, spec.owner],
        ["grantee", "shared", SHARED_VISIBLE_STATUSES, spec.grantee],
      ];
      for (const [who, scope, visibleStatuses, stillThere] of sides) {
        const l = await library();
        const opts: SearchOptions = { scope, visibleStatuses, limit: 50 };
        // The control: with nothing happening in between, both are found.
        const calm = await searchNames(db, l[who], l.token, opts);
        expect(calm.items.map((hit) => hit.node.id).sort(), `${who}, calm`).toEqual(
          [l.hit.id, l.stays.id].sort(),
        );

        let changed = false;
        const racing = withChangeBetweenReads(async () => {
          await spec.change(l)();
          changed = true;
        });
        const found = await searchNames(racing, l[who], l.token, opts);
        expect(changed, "the change landed between the two reads").toBe(true);
        const ids = found.items.map((hit) => hit.node.id);
        const folderDown = name === "its folder taken down";
        expect(ids.includes(l.hit.id), `${who}: the changed row`).toBe(stillThere);
        // The row beside it is untouched by the change (unless its folder went with it).
        expect(ids.includes(l.stays.id), `${who}: the row beside it`).toBe(!folderDown);
        // Whatever is returned is the row AS IT IS NOW, and one its reader may see.
        for (const hit of found.items) {
          expect(visibleStatuses).toContain(hit.node.scanStatus);
          expect(hit.node.takedownAt).toBeNull();
          expect(hit.node.deletedAt).toBeNull();
        }
      }
    },
  );

  it("scope all: each side is read back by its own status list", async () => {
    const l = await library();
    // The grantee's own file with the same token, and the owner's shared one; both go under review.
    const mine = await makeFile(db, l.grantee, null, `${l.token}-mine.txt`, { scanStatus: "clean" });
    const racing = withChangeBetweenReads(async () => {
      await set(mine.id, { scanStatus: "under_review" })();
      await set(l.hit.id, { scanStatus: "under_review" })();
    }, 2);
    const found = await searchNames(racing, l.grantee, l.token, {
      scope: "all",
      visibleStatuses: { mine: OWNER_VISIBLE_STATUSES, shared: SHARED_VISIBLE_STATUSES },
      limit: 50,
    });
    // Their own file under review: theirs to see. The owner's: not.
    expect(found.items.map((hit) => hit.node.id).sort()).toEqual([mine.id, l.stays.id].sort());
    expect(found.items.find((hit) => hit.node.id === mine.id)).toMatchObject({
      role: "owner",
      node: { scanStatus: "under_review" },
    });
  });

  it("a row deleted between the two reads is dropped, not an error; the cursor is the ranked window's", async () => {
    const l = await library();
    const racing = withChangeBetweenReads(async () => {
      await db.delete(nodes).where(eq(nodes.id, l.hit.id));
    });
    const found = await searchNames(racing, l.owner, l.token, {
      scope: "mine",
      visibleStatuses: OWNER_VISIBLE_STATUSES,
      limit: 50,
    });
    expect(found.items.map((hit) => hit.node.id)).toEqual([l.stays.id]);
    expect(found.nextCursor).toBeNull();
  });
});
