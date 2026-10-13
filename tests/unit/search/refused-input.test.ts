// What the three routes do with text Postgres would refuse, or that is shorter than it looks:
// `400 validation` at the door — never a 500, a Sentry event or an `error` metric — and nothing
// of it reaches a query.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchResponse } from "../../../src/shared/schemas/search";
import { encodeCursor } from "../../../src/worker/db/cursor";
import { auditRows } from "../auth/helpers";
import { makeFile, makeUser } from "../services-core/helpers";
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
