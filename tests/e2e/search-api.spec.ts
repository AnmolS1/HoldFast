// Search, Recent and Starred against the running app: rows seeded straight into the database for
// two users, the first one signed in through the real sign-up.
import { randomBytes, randomUUID } from "node:crypto";
import { RecentResponse, SearchResponse, StarredResponse } from "../../src/shared/schemas/search";
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { expect, test } from "./fixtures";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** A user id in the auth library's shape. */
const userId = () => Array.from(randomBytes(32), (byte) => ALNUM[byte % ALNUM.length]).join("");

type Seed = { name: string; starred?: boolean; openedMinutesAgo?: number };

/** A clean top-level file of `ownerId`, written directly. */
async function seedFile(ownerId: string, seed: Seed): Promise<string> {
  const id = randomUUID();
  const dot = seed.name.lastIndexOf(".");
  await localDb((db) =>
    db.query(
      `INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, ext, size, scan_status,
                          starred, last_accessed_at)
       VALUES ($1, $2, $2, 'file', $3, lower($3), $4, 100, 'clean', $5,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(mins => $6::int) END)`,
      [
        id,
        ownerId,
        seed.name,
        dot > 0 ? seed.name.slice(dot + 1).toLowerCase() : "",
        seed.starred ?? false,
        seed.openedMinutesAgo ?? null,
      ],
    ),
  );
  return id;
}

test("search finds the caller's file through a typo and never another user's; recent and starred list the seeded rows", async ({
  request,
  clientIp,
}) => {
  const a = await signedInUser(request, { clientIp });
  const b = userId();
  await localDb((db) =>
    db.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Other User', $2, true)`, [
      b,
      `${b.toLowerCase()}@search-api.holdfast-e2e.example`,
    ]),
  );

  const report = await seedFile(a.id, { name: "report.pdf", openedMinutesAgo: 5 });
  const budget = await seedFile(a.id, { name: "budget.xlsx", starred: true, openedMinutesAgo: 1 });
  const notes = await seedFile(a.id, { name: "notes.txt", starred: true });
  const theirs = await seedFile(b, { name: "report.pdf", starred: true, openedMinutesAgo: 2 });

  const search = await request.get("/api/search?q=reprot");
  expect(search.status()).toBe(200);
  const found = SearchResponse.parse(await search.json());
  expect(found.items.map((item) => item.id)).toEqual([report]);
  expect(found.items[0]).toMatchObject({ name: "report.pdf", role: "owner", pathHint: "" });
  expect(found.items.map((item) => item.id)).not.toContain(theirs);

  const recent = await request.get("/api/recent");
  expect(recent.status()).toBe(200);
  expect(RecentResponse.parse(await recent.json()).items.map((item) => item.id)).toEqual([budget, report]);

  const starred = await request.get("/api/starred");
  expect(starred.status()).toBe(200);
  const page = StarredResponse.parse(await starred.json());
  expect(page.items.map((item) => item.id)).toEqual([budget, notes]);
  expect(page.nextCursor).toBeNull();
});

test("search, recent and starred refuse a request without a session", async ({ playwright, origins }) => {
  const anonymous = await playwright.request.newContext({ baseURL: origins.app });
  for (const path of ["/api/search?q=report", "/api/recent", "/api/starred"]) {
    expect((await anonymous.get(path)).status(), path).toBe(401);
  }
  await anonymous.dispose();
});
