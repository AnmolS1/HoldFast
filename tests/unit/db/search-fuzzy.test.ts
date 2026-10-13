// Fuzzy search by word: a swapped pair of letters still finds the file, a short query is not
// flooded, and the server setting the match needs never outlives the search.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, statementsSent } from "../../../src/worker/db/client";
import { OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import {
  type SearchOptions,
  searchNames,
  WORD_MATCH_MIN_CHARS,
  WORD_SIMILARITY_THRESHOLD,
} from "../../../src/worker/db/queries/search";
import { makeFile, makeFolder, makeShare, makeUser, openDb } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const SETTING = "pg_trgm.word_similarity_threshold";
const mine = { scope: "mine", visibleStatuses: OWNER_VISIBLE_STATUSES, limit: 50 } as const;
const names = async (userId: string, q: string, extra: Partial<SearchOptions> = {}) =>
  (await searchNames(db, userId, q, { ...mine, ...extra })).items.map((hit) => hit.node.name);

describe("searchNames, fuzzy by word", () => {
  it('"reprot" finds report.pdf — also inside a longer name, and on the shared side', async () => {
    const me = await makeUser(db);
    await makeFile(db, me, null, "report.pdf");
    await makeFile(db, me, null, "Annual Report 2024 (final).docx");
    await makeFile(db, me, null, "holiday.jpg");
    expect((await names(me, "reprot")).sort()).toEqual(["Annual Report 2024 (final).docx", "report.pdf"]);
    // The near misses that whole-name similarity already found are still found.
    expect(await names(me, "reporr")).toContain("report.pdf");
    expect(await names(me, "reprt")).toContain("report.pdf");
    // The control: without the word match (a caller's own threshold turns it off, at the
    // default value) the transposition finds nothing — whole-name similarity is 0.2.
    expect(await names(me, "reprot", { threshold: 0.3 })).toEqual([]);

    const friend = await makeUser(db);
    const folder = await makeFolder(db, me, null, "shared things");
    await makeFile(db, me, folder.id, "report-q3.pdf");
    await makeShare(db, folder.id, me, { userId: friend });
    const shared = await searchNames(db, friend, "reprot", {
      scope: "shared",
      visibleStatuses: ["clean"],
      limit: 50,
    });
    expect(shared.items.map((hit) => hit.node.name)).toEqual(["report-q3.pdf"]);
    const all = await searchNames(db, friend, "reprot", {
      scope: "all",
      visibleStatuses: { mine: OWNER_VISIBLE_STATUSES, shared: ["clean"] },
      limit: 50,
    });
    expect(all.items.map((hit) => hit.node.name)).toEqual(["report-q3.pdf"]);
  });

  it("ranks a prefix, a word prefix and a substring before every fuzzy match", async () => {
    const me = await makeUser(db);
    // Contains the query, in a name so long that its whole-name similarity is the lowest here.
    const buried = "minutes of the long meeting about xreportx and several other things.txt";
    for (const name of [
      "repro.txt",
      "reporter notes.txt",
      "reporr.txt",
      "my report.txt",
      buried,
      "report.txt",
    ]) {
      await makeFile(db, me, null, name);
    }
    const found = await names(me, "report");
    // Starts with it (the closer name first), a word starts with it, contains it — then fuzzy,
    // although reporr.txt is far closer to the query as a whole than the buried name is.
    expect(found.slice(0, 4)).toEqual(["report.txt", "reporter notes.txt", "my report.txt", buried]);
    expect(found.slice(4).sort()).toEqual(["reporr.txt", "repro.txt"]);
  });

  it("a query shorter than the minimum is searched exactly as before: no word match, no transaction", async () => {
    const me = await makeUser(db);
    for (const name of ["car.txt", "calendar.ics", "cat.txt", "concatenate.md", "repeat.txt", "taxi.txt"]) {
      await makeFile(db, me, null, name);
    }
    expect(WORD_MATCH_MIN_CHARS).toBe(5);
    // By word, "cat" is 0.5 from car.txt and calendar.ics — any word beginning "ca".
    expect((await names(me, "cat")).sort()).toEqual(["cat.txt", "concatenate.md"]);
    expect(await names(me, "ca")).toHaveLength(4);
    expect(await names(me, "re")).toEqual(["repeat.txt"]);
    expect(await names(me, "repo")).toEqual([]);
    // The control: the same tree does answer a word match once the query is long enough.
    expect(await names(me, "repot")).toEqual(["repeat.txt"]);

    const cost = async (q: string, extra: Partial<SearchOptions> = {}) => {
      const before = statementsSent(db);
      await names(me, q, extra);
      return statementsSent(db) - before;
    };
    // Two statements as before: the ranked read and the rows of the page.
    expect(await cost("cat")).toBe(2);
    expect(await cost("repeat", { threshold: 0.5 })).toBe(2);
    // By word: the transaction (BEGIN, its limits, COMMIT) and the setting on top.
    expect(await cost("repeat")).toBe(6);
  });

  it("the setting ends with the search: no pooled connection keeps it", async () => {
    const me = await makeUser(db);
    await makeFile(db, me, null, "report.pdf");
    // The pool has five connections; several searches at once put the setting on several.
    await Promise.all(Array.from({ length: 8 }, () => names(me, "reprot")));

    // Hold five transactions open together, so that every connection of the pool answers.
    let waiting = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => (release = resolve));
    const settings = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.transaction(async (tx) => {
          const result = await tx.execute<{ pid: number; value: string | null }>(
            sql`SELECT pg_backend_pid() AS pid, current_setting(${SETTING}, true) AS value`,
          );
          if (++waiting === 5) release();
          await all;
          return result.rows[0]!;
        }),
      ),
    );
    expect(new Set(settings.map((row) => row.pid)).size).toBe(5);
    // The server's default, or not set at all on a connection that has not loaded the extension.
    for (const row of settings) expect([null, "", "0.6"]).toContain(row.value);
    expect(settings.some((row) => row.value === "0.6")).toBe(true);

    // The control: inside the search's own transaction the setting IS the constant.
    const inside = await db.transaction(async (tx) => {
      await searchNames(tx, me, "reprot", mine);
      const result = await tx.execute<{ value: string }>(sql`SELECT current_setting(${SETTING}) AS value`);
      return result.rows[0]!.value;
    });
    expect(Number(inside)).toBe(WORD_SIMILARITY_THRESHOLD);
  });
});
