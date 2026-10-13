// What the three routes do with text Postgres would refuse, or that is shorter than it looks:
// `400 validation` at the door — never a 500, a Sentry event or an `error` metric — and nothing
// of it reaches a query.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchResponse } from "../../../src/shared/schemas/search";
import { encodeCursor } from "../../../src/worker/db/cursor";
import { auditRows } from "../auth/helpers";
import { makeFile, makeFolder, makeShare, makeUser } from "../services-core/helpers";
import { get, searchPath, type Answer, type Caller } from "./helpers";

const captured = vi.hoisted(() => ({ errors: [] as unknown[] }));

// The reporting exit of the Worker (src/worker/sentry.ts#captureError) ends here.
vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
  withScope: (callback: (scope: { setTag(key: string, value: string): void }) => void) =>
    callback({ setTag: () => {} }),
  captureException: (error: unknown) => void captured.errors.push(error),
}));

type UserRow = Awaited<ReturnType<typeof makeUser>>;
const as = (row: UserRow): Caller => ({ user: row });
const clean = { scanStatus: "clean" } as const;

type Point = { indexes?: string[]; blobs?: string[] };
/** The metric names and outcomes one request wrote. */
const written = (answer: Answer) =>
  (answer.metrics as Point[]).map((point) => `${point.indexes?.[0]}/${point.blobs?.[1]}`);

/** `400 validation`, and nothing that says the server failed. */
function expectRefused(answer: Answer, what: string): void {
  expect(answer.status, what).toBe(400);
  expect((answer.body as { error?: string }).error, what).toBe("validation");
  expect(captured.errors, what).toEqual([]);
  expect(
    written(answer).filter((point) => point.startsWith("error/")),
    what,
  ).toEqual([]);
  expect(written(answer), what).not.toContain("request/5xx");
  // The request was measured at all: the capture is live.
  expect(
    written(answer).some((point) => point.startsWith("request/")),
    what,
  ).toBe(true);
}

afterEach(() => {
  captured.errors.length = 0;
});

describe("GET /api/search — a query Postgres would refuse", () => {
  it("refuses a control character anywhere in q: a NUL, a tab, a line break, a C1 control", async () => {
    const me = await makeUser();
    for (const q of [
      "ab%00",
      "%00%00",
      "re%00port",
      "ab%09cd",
      "ab%0Acd",
      "ab%1Fcd",
      "ab%7Fcd",
      "ab%C2%85cd", // U+0085, a C1 control
      "ab%C2%9Fcd", // U+009F
    ]) {
      expectRefused(await get(as(me), `/search?q=${q}`), q);
    }
  });

  it("measures q after trimming: one letter between blanks is too short, and the audit row has the trimmed length", async () => {
    const me = await makeUser();
    await makeFile(me.id, null, { name: "a b.txt", ...clean });
    for (const q of ["%20a%20", "%20%20a", "a%20%20%20", "%20%20", "%09a%09"]) {
      expectRefused(await get(as(me), `/search?q=${q}`), q);
    }
    expect(await auditRows({ action: "search.query", actorUserId: me.id })).toEqual([]);

    // Two letters between blanks is a search for the two letters.
    const answer = await get(as(me), "/search?q=%20%20a%20b%20%20&scope=mine");
    expect(SearchResponse.parse(answer.body).items.map((item) => item.name)).toEqual(["a b.txt"]);
    const rows = await auditRows({ action: "search.query", actorUserId: me.id });
    expect(rows.map((row) => row.meta)).toEqual([{ length: 3, scope: "mine" }]);

    // 100 characters after trimming is the most; blanks around them do not count.
    expect((await get(as(me), `/search?q=%20${"a".repeat(100)}%20`)).status).toBe(200);
    expectRefused(await get(as(me), `/search?q=%20${"a".repeat(101)}%20`), "101 letters");
  });
});

describe("the other text the three routes pass on", () => {
  it("a cursor that is not one — a NUL in it, or around a real one — is refused before any query", async () => {
    const me = await makeUser();
    for (let i = 0; i < 3; i++) await makeFile(me.id, null, { name: `nulcase ${i}.txt`, starred: true });
    const search = SearchResponse.parse(
      (await get(as(me), searchPath({ q: "nulcase", scope: "mine", limit: 1 }))).body,
    );
    const starred = (await get(as(me), "/starred?limit=1")).body as { nextCursor: string };
    expect(search.nextCursor).not.toBeNull();
    expect(starred.nextCursor).not.toBeNull();

    // A cursor's value, forged with a NUL where the listing expects text or a number.
    const forgedSearch = encodeCursor(`search:${me.id}:mine:nulcase`, { offset: "1\u0000" });
    const forgedStarred = encodeCursor(`starred:${me.id}`, { k: "folder", v: "a\u0000", id: "\u0000" });
    for (const path of [
      "/search?q=nulcase&scope=mine&cursor=%00",
      `/search?q=nulcase&scope=mine&cursor=${search.nextCursor}%00`,
      `/search?q=nulcase&scope=mine&cursor=${forgedSearch}`,
      "/starred?cursor=%00",
      `/starred?cursor=${starred.nextCursor}%00`,
      `/starred?cursor=${forgedStarred}`,
    ]) {
      expectRefused(await get(as(me), path), path);
    }
  });

  it("inFolder and the numbers are refused unless they are exactly what they claim to be", async () => {
    const me = await makeUser();
    for (const path of [
      "/search?q=report&inFolder=%00",
      "/search?q=report&inFolder=0199d3c2-7a10-7000-8000-0000000000d4%00",
      "/search?q=report&limit=5%00",
      "/search?q=report&scope=mine%00",
      "/search?q=report&kind=file%00",
      "/search?q=report&category=image%00",
      "/recent?limit=5%00",
      "/starred?limit=5%00",
    ]) {
      expectRefused(await get(as(me), path), path);
    }
  });
});

describe("a search cursor written by the caller", () => {
  // The cursor is not signed: it is base64 of `{ t: tag, v: { offset } }`, and the tag is made of
  // things the caller knows (their own id, the scope, the query). So a caller can write one.
  const forged = (userId: string, scope: string, q: string, offset: unknown) =>
    encodeCursor(`search:${userId}:${scope}:${q}`, { offset });

  it("windows the caller's own visible results and nothing else; past the last offset it is an empty page", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const q = "forgedoffset";
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      mine.push((await makeFile(me.id, null, { name: `${q} ${i}.txt`, ...clean })).id);
    }
    const shared = await makeFolder(other.id);
    const theirs = await makeFile(other.id, shared.id, { name: `${q} shared.txt`, ...clean });
    const hidden = await makeFile(other.id, shared.id, { name: `${q} pending.txt` });
    const unshared = await makeFile(other.id, null, { name: `${q} private.txt`, ...clean });
    await makeShare(shared.id, other.id, me.id);
    const ids = async (scope: string, offset: unknown, limit = 50) => {
      const answer = await get(
        as(me),
        searchPath({ q, scope, limit, cursor: forged(me.id, scope, q, offset) }),
      );
      expect(answer.status, `${scope} ${String(offset)}`).toBe(200);
      return SearchResponse.parse(answer.body);
    };

    // An offset the server never handed out: the rest of the caller's own list, in its order.
    const whole = SearchResponse.parse((await get(as(me), searchPath({ q, scope: "mine" }))).body);
    expect(whole.items.map((item) => item.id).sort()).toEqual([...mine].sort());
    expect((await ids("mine", 2)).items.map((item) => item.id)).toEqual(
      whole.items.slice(2).map((item) => item.id),
    );
    // In `all` the window is over the same visible set as an honest search: the shared clean
    // file is in it, the pending shared file and the unshared one never are.
    const honest = SearchResponse.parse((await get(as(me), searchPath({ q, scope: "all" }))).body);
    const visible = honest.items.map((item) => item.id);
    expect([...visible].sort()).toEqual([...mine, theirs.id].sort());
    for (const offset of [1, 3, 5]) {
      const window = (await ids("all", offset)).items.map((item) => item.id);
      expect(window, `all ${offset}`).toEqual(visible.slice(offset));
      expect(window).not.toContain(hidden.id);
      expect(window).not.toContain(unshared.id);
    }

    // The last offset there is, and everything past it: an empty page with no cursor.
    for (const offset of [1000, 1001, 5000, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      for (const scope of ["mine", "shared", "all"]) {
        expect(await ids(scope, offset), `${scope} ${offset}`).toEqual({ items: [], nextCursor: null });
      }
    }
  });

  it("is refused when its offset is not a whole positive number, or its tag is another scope's, query's or user's", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const q = "forgedoffset";
    for (const offset of [0, -1, 1.5, "2", null, [2], { n: 2 }]) {
      const cursor = forged(me.id, "mine", q, offset);
      expectRefused(await get(as(me), searchPath({ q, scope: "mine", cursor })), JSON.stringify(offset));
    }
    const cases: Array<[string, string, string]> = [
      [forged(me.id, "mine", q, 1), "shared", q], // a cursor of `mine` does not page `shared`
      [forged(me.id, "mine", q, 1), "all", q],
      [forged(me.id, "shared", q, 1), "all", q],
      [forged(me.id, "mine", "anotherquery", 1), "mine", q],
      [forged(other.id, "mine", q, 1), "mine", q], // another user's tag
      [forged(other.id, "all", q, 1), "all", q],
    ];
    for (const [cursor, scope, query] of cases) {
      expectRefused(await get(as(me), searchPath({ q: query, scope, cursor })), `${scope} ${query}`);
    }
  });
});
