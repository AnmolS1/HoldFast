// Search over a tree of 50,000 nodes: the plan of the statements `searchNames` really sends, and
// how long the endpoint takes.
//
// The plan is asserted (the trigram index, no sequential scan of the caller's side). The latency
// is MEASURED and printed, not asserted: the target is a 95th percentile under 200 ms on a quiet
// machine, and this suite runs beside others — the same request that takes 40 ms alone took 350 ms
// with the machine's load average at 17. A bound that holds under any load would say nothing.
//
// The fixture is this file's own two users: 40,000 files of the caller's in 40 folders, and
// 10,000 files of another user's under 20 folders shared with the caller, each six folders deep.
// It is written with `generate_series` and deleted again when the file is done.
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SearchResponse } from "../../../src/shared/schemas/search";
import type { Executor } from "../../../src/worker/db/client";
import { OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import { searchNames } from "../../../src/worker/db/queries/search";
import { SIMILARITY_THRESHOLD } from "../../../src/worker/routes/search";
import { makeUser, testDb } from "../services-core/helpers";
import { get, searchPath, type Caller } from "./helpers";

const SETUP_TIMEOUT_MS = 180_000;
const OWN_FOLDERS = 40;
const OWN_FILES = 40_000;
const SHARED_ROOTS = 20;
const SHARED_DEPTH = 6;
const SHARED_FILES = 10_000;

// Two word lists make the names: 40 × 25 pairs, so a word is in 1 name of 40 and a pair in 1 of 1,000.
const FIRST =
  "report invoice budget holiday contract meeting summary proposal receipt schedule manual recipe " +
  "portrait landscape diagram sketch backup archive letter memo minutes agenda roadmap survey " +
  "estimate statement policy handbook checklist timeline inventory catalogue brochure newsletter " +
  "transcript certificate application reference itinerary presentation";
const SECOND =
  "final draft signed scanned copy original revised approved pending january february march april " +
  "may june july august september october november december yearly monthly weekly daily";

let me: Awaited<ReturnType<typeof makeUser>>;
let owner: Awaited<ReturnType<typeof makeUser>>;
const caller = (): Caller => ({ user: me });

/** `count` files spread over the folders of `ownerId` whose names start with `folderPrefix`. */
const insertFiles = (ownerId: string, folderPrefix: string, count: number) => sql`
  WITH folders AS (
    SELECT id, (row_number() OVER (ORDER BY id) - 1) AS n, count(*) OVER () AS total
    FROM nodes WHERE owner_id = ${ownerId} AND kind = 'folder' AND name LIKE ${folderPrefix + "%"}
  ), names AS (
    SELECT i,
           (string_to_array(${FIRST}, ' '))[1 + i % 40] || ' ' ||
           (string_to_array(${SECOND}, ' '))[1 + (i / 40) % 25] || ' ' || lpad(i::text, 6, '0') ||
           (ARRAY['.pdf', '.docx', '.jpg', '.txt', '.zip'])[1 + i % 5] AS name
    FROM generate_series(0, ${count - 1}) AS i
  )
  INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
  SELECT gen_random_uuid(), ${ownerId}, ${ownerId}, f.id, 'file', names.name, lower(names.name),
         split_part(names.name, '.', 2), 1000, 'clean'
  FROM names JOIN folders f ON f.n = names.i % f.total`;

beforeAll(async () => {
  const db = testDb();
  me = await makeUser();
  owner = await makeUser();

  await db.execute(sql`
    INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, scan_status)
    SELECT gen_random_uuid(), ${me.id}, ${me.id}, 'folder', 'own ' || i, 'own ' || i, 'clean'
    FROM generate_series(1, ${OWN_FOLDERS}) AS i`);
  await db.execute(insertFiles(me.id, "own ", OWN_FILES));

  // 20 shared roots, each a chain of folders six deep; the files hang off every level.
  await db.execute(sql`
    INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, scan_status)
    SELECT gen_random_uuid(), ${owner.id}, ${owner.id}, 'folder', 'level 1 root ' || i, 'level 1 root ' || i, 'clean'
    FROM generate_series(1, ${SHARED_ROOTS}) AS i`);
  for (let level = 2; level <= SHARED_DEPTH; level++) {
    await db.execute(sql`
      INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, scan_status)
      SELECT gen_random_uuid(), ${owner.id}, ${owner.id}, p.id, 'folder', ${`level ${level}`}, ${`level ${level}`}, 'clean'
      FROM nodes p WHERE p.owner_id = ${owner.id} AND p.kind = 'folder' AND p.name LIKE ${`level ${level - 1}%`}`);
  }
  await db.execute(insertFiles(owner.id, "level ", SHARED_FILES));
  await db.execute(sql`
    INSERT INTO shares (id, node_id, granted_by, grantee_email, grantee_user_id, activated_at, role)
    SELECT gen_random_uuid(), n.id, ${owner.id}, ${me.email}, ${me.id}, now(), 'viewer'
    FROM nodes n WHERE n.owner_id = ${owner.id} AND n.parent_id IS NULL`);
  // Fresh statistics: without them the planner still believes the table is as small as it was.
  await db.execute(sql`ANALYZE nodes`);
  await db.execute(sql`ANALYZE shares`);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  const db = testDb();
  await db.execute(sql`DELETE FROM shares WHERE granted_by = ${owner.id}`);
  await db.execute(sql`DELETE FROM nodes WHERE owner_id IN (${me.id}, ${owner.id})`);
}, SETUP_TIMEOUT_MS);

/** The statements one `searchNames` call sends through `execute`, in order. */
async function statementsOf(q: string, scope: "mine" | "shared"): Promise<SQL[]> {
  const sent: SQL[] = [];
  const recording = new Proxy(testDb(), {
    get(target, property, receiver) {
      if (property !== "execute") return Reflect.get(target, property, receiver) as unknown;
      return (query: SQL) => {
        sent.push(query);
        return target.execute(query);
      };
    },
  }) as Executor;
  await searchNames(recording, me.id, q, {
    scope,
    visibleStatuses: scope === "mine" ? OWNER_VISIBLE_STATUSES : ["clean"],
    limit: 20,
    threshold: SIMILARITY_THRESHOLD,
  });
  return sent;
}

async function explain(statement: SQL): Promise<string> {
  const result = await testDb().execute<{ "QUERY PLAN": string }>(
    sql`EXPLAIN (ANALYZE, BUFFERS) ${statement}`,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

async function timed(path: string, runs: number): Promise<{ p50: number; p95: number; max: number }> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const answer = await get(caller(), path);
    times.push(performance.now() - started);
    expect(answer.status).toBe(200);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: times[times.length - 1]! };
}

describe("search over 50,000 nodes", () => {
  it("the fixture is the size it says", async () => {
    const counted = await testDb().execute<{ owner_id: string; files: number }>(sql`
      SELECT owner_id, count(*)::int AS files FROM nodes
      WHERE owner_id IN (${me.id}, ${owner.id}) AND kind = 'file' GROUP BY owner_id`);
    const files = new Map(counted.rows.map((row) => [row.owner_id, row.files]));
    expect(files.get(me.id)).toBe(OWN_FILES);
    expect(files.get(owner.id)).toBe(SHARED_FILES);
  });

  it("the caller's own side is answered from the trigram index", async () => {
    for (const q of ["itinerary september", "itinerery", "catalogue 0123"]) {
      const [statement] = await statementsOf(q, "mine");
      const plan = await explain(statement!);
      console.log(`EXPLAIN (ANALYZE, BUFFERS) — scope mine, q = "${q}"\n${plan}\n`);
      expect(plan, q).toContain("nodes_name_trgm_idx");
      expect(plan, q).not.toMatch(/Seq Scan on nodes n\b/);
    }
  });

  it("the shared side walks the 20 shared roots — the plan, for the record", async () => {
    const [statement] = await statementsOf("itinerary september", "shared");
    const plan = await explain(statement!);
    console.log(`EXPLAIN (ANALYZE, BUFFERS) — scope shared, q = "itinerary september"\n${plan}\n`);
    expect(plan).toContain("Recursive Union");
  });

  it("ranks a name that starts with the query above one that only contains it", async () => {
    const found = SearchResponse.parse((await get(caller(), searchPath({ q: "final", scope: "mine" }))).body);
    expect(found.items).toHaveLength(20);
    expect(found.nextCursor).not.toBeNull();
    // No name here starts with "final": every hit has it as the second word.
    expect(found.items.every((item) => / final /.test(item.name))).toBe(true);
    const prefix = SearchResponse.parse(
      (await get(caller(), searchPath({ q: "report fi", scope: "mine" }))).body,
    );
    expect(prefix.items.every((item) => item.name.startsWith("report final"))).toBe(true);
  });

  it("measures the endpoint in every scope (target: p95 under 200 ms on a quiet machine)", async () => {
    // One request first: the first statement of a file pays for the connection.
    await get(caller(), searchPath({ q: "warm up", scope: "all" }));
    const lines: string[] = [];
    for (const scope of ["mine", "shared", "all"] as const) {
      for (const q of ["itinerary september", "itinerery", "report"]) {
        const t = await timed(searchPath({ q, scope }), 20);
        lines.push(
          `scope ${scope.padEnd(6)} q "${q}": p50 ${t.p50.toFixed(1)} ms, p95 ${t.p95.toFixed(1)} ms, max ${t.max.toFixed(1)} ms`,
        );
        expect(t.p50).toBeGreaterThan(0);
      }
    }
    console.log(`search latency over the 50,000-node fixture (20 requests each)\n${lines.join("\n")}\n`);
  }, 120_000);
});
