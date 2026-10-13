// Search by category `other`: the complement of every other category, as `categoryOf` decides it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIME_CATEGORIES, type MimeCategoryName } from "../../../src/shared/constants";
import type { Db } from "../../../src/worker/db/client";
import { OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import { type SearchOptions, searchNames } from "../../../src/worker/db/queries/search";
import type { Node } from "../../../src/worker/db/schema";
import { categoryOf } from "../../../src/worker/services/mime";
import { makeFile, makeFolder, makeShare, makeUser, openDb, rand } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const NAMES = Object.keys(MIME_CATEGORIES) as MimeCategoryName[];
/** What a route passes for `category=other`: every category's types and extensions, negated. */
const OTHER = {
  mimes: NAMES.flatMap((name) => [...MIME_CATEGORIES[name].types]),
  exts: NAMES.flatMap((name) => [...MIME_CATEGORIES[name].exts]),
  not: true,
} as const;
const only = (name: MimeCategoryName) => ({
  mimes: [...MIME_CATEGORIES[name].types],
  exts: [...MIME_CATEGORIES[name].exts],
});

describe("searchNames, category with not: true", () => {
  it("files of three categories and one of none: `other` returns only the last", async () => {
    const me = await makeUser(db);
    const token = `oth${rand()}`;
    const file = (name: string, mimeSniffed: string | null) =>
      makeFile(db, me, null, `${token}-${name}`, { mimeSniffed });
    const image = await file("a.png", "image/png");
    const pdf = await file("b.pdf", "application/pdf");
    const audio = await file("c.mp3", "audio/mpeg");
    const none = await file("d.qqq", "application/x-unheard-of");
    await makeFolder(db, me, null, `${token}-folder`);
    const ids = async (category?: SearchOptions["category"]) =>
      (
        await searchNames(db, me, token, {
          scope: "mine",
          visibleStatuses: OWNER_VISIBLE_STATUSES,
          limit: 50,
          category,
        })
      ).items
        .map((hit) => hit.node.id)
        .sort();

    expect(await ids(OTHER)).toEqual([none.id]);
    // The controls: the same lists without `not` find the three others, and each category its own.
    expect(await ids({ mimes: OTHER.mimes, exts: OTHER.exts })).toEqual([image.id, pdf.id, audio.id].sort());
    expect(await ids(only("image"))).toEqual([image.id]);
    expect(await ids(only("pdf"))).toEqual([pdf.id]);
    expect(await ids()).toHaveLength(5);
  });

  it("the eight categories partition a tree of awkward files, and agree with categoryOf row by row", async () => {
    const me = await makeUser(db);
    const token = `par${rand()}`;
    const types = [
      null,
      "",
      "application/octet-stream",
      "text/plain",
      "TEXT/PLAIN",
      "image/png",
      "application/zip",
      "application/x-unheard-of",
    ];
    const exts = ["", "png", "pdf", "ts", "zip", "mp3", "qqq"];
    const files: Node[] = [];
    for (const [t, mimeSniffed] of types.entries()) {
      for (const [e, ext] of exts.entries()) {
        const name = `${token}-${t}-${e}${ext ? "." + ext : ""}`;
        files.push(
          await makeFile(db, me, null, name, { mimeSniffed, scanStatus: mimeSniffed ? "clean" : "pending" }),
        );
      }
    }
    const expected = new Map(NAMES.map((name) => [name, [] as string[]]));
    for (const row of files) expected.get(categoryOf(row.mimeSniffed, row.ext))!.push(row.name);
    // The fixture has the cases a filter by type alone gets wrong: a scanned source file
    // (text/plain, .ts) is code, an octet-stream .png an image, a text file of no known
    // extension a document, and an unsniffed file of no known extension nothing at all.
    const called = (mimeSniffed: string | null, ext: string) =>
      categoryOf(files.find((row) => row.mimeSniffed === mimeSniffed && row.ext === ext)!.mimeSniffed, ext);
    expect(called("text/plain", "ts")).toBe("code");
    expect(called("application/octet-stream", "png")).toBe("image");
    expect(called("text/plain", "qqq")).toBe("document");
    expect(called("image/png", "pdf")).toBe("image");
    expect(called(null, "qqq")).toBe("other");
    expect(expected.get("other")!.length).toBeGreaterThan(5);

    const found = new Map<MimeCategoryName, string[]>();
    for (const name of NAMES) {
      const hits: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof searchNames>> = await searchNames(db, me, token, {
          scope: "mine",
          visibleStatuses: OWNER_VISIBLE_STATUSES,
          limit: 50,
          cursor,
          category: name === "other" ? OTHER : only(name),
        });
        for (const hit of page.items) hits.push(hit.node.name);
        cursor = page.nextCursor;
      } while (cursor);
      found.set(name, hits);
    }
    for (const name of NAMES) {
      expect(found.get(name)!.sort(), name).toEqual(expected.get(name)!.sort());
    }
    // Nothing in two categories, nothing in none.
    const everything = [...found.values()].flat();
    expect(everything).toHaveLength(files.length);
    expect(new Set(everything).size).toBe(files.length);
  });

  it("applies to the shared side as well", async () => {
    const owner = await makeUser(db);
    const me = await makeUser(db);
    const token = `sho${rand()}`;
    const folder = await makeFolder(db, owner, null, `f-${rand()}`);
    await makeFile(db, owner, folder.id, `${token}.png`, { mimeSniffed: "image/png" });
    const none = await makeFile(db, owner, folder.id, `${token}.qqq`, {
      mimeSniffed: "application/x-unheard-of",
    });
    await makeShare(db, folder.id, owner, { userId: me });
    const hits = await searchNames(db, me, token, {
      scope: "shared",
      visibleStatuses: ["clean"],
      limit: 50,
      category: OTHER,
    });
    expect(hits.items.map((hit) => hit.node.id)).toEqual([none.id]);
  });
});
