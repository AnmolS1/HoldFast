// Search by category `other`: the complement of every other category, as `categoryOf` decides it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIME_CATEGORIES, type MimeCategoryName } from "../../../src/shared/constants";
import type { Db } from "../../../src/worker/db/client";
import { OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import { type SearchOptions, searchNames } from "../../../src/worker/db/queries/search";
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

  it("agrees with categoryOf for every pairing of a detected type and an extension", async () => {
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
    const exts = ["", "png", "pdf", "ts", "zip", "qqq"];
    const files = [];
    for (const [t, mimeSniffed] of types.entries()) {
      for (const [e, ext] of exts.entries()) {
        const name = `${token}-${t}-${e}${ext ? "." + ext : ""}`;
        files.push(
          await makeFile(db, me, null, name, { mimeSniffed, scanStatus: mimeSniffed ? "clean" : "pending" }),
        );
      }
    }
    const expected = files.filter((row) => categoryOf(row.mimeSniffed, row.ext) === "other");
    const others = files.filter((row) => categoryOf(row.mimeSniffed, row.ext) !== "other");
    // The fixture has both kinds, and the cases a plain negation gets wrong: an unsniffed file
    // (NULL) of no known extension, and a generic type with a known one.
    expect(expected.length).toBeGreaterThan(5);
    expect(others.length).toBeGreaterThan(5);
    expect(expected.some((row) => row.mimeSniffed === null)).toBe(true);
    expect(others.some((row) => row.mimeSniffed === "application/octet-stream" && row.ext === "png")).toBe(
      true,
    );

    const found = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof searchNames>> = await searchNames(db, me, token, {
        scope: "mine",
        visibleStatuses: OWNER_VISIBLE_STATUSES,
        limit: 50,
        cursor,
        category: OTHER,
      });
      for (const hit of page.items) found.add(hit.node.name);
      cursor = page.nextCursor;
    } while (cursor);
    expect([...found].sort()).toEqual(expected.map((row) => row.name).sort());
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
