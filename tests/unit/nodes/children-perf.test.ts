// A folder with 5,000 children: each of the four sorts has an index of its own that serves the
// page in order — the plans of the very statements the listing sends are checked, with the
// planner not allowed to sort — and the route's p95 stays under 150 ms.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listChildren, OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import * as schema from "../../../src/worker/db/schema";
import { api, makeFolder, manyFiles, person } from "./helpers";

const CHILDREN = 5_000;
const SORTS = ["name", "size", "updated", "kind"] as const;
const INDEX = {
  name: "nodes_children_name_idx",
  size: "nodes_children_size_idx",
  updated: "nodes_children_updated_idx",
  kind: "nodes_children_ext_idx",
} as const;
const P95_LIMIT_MS = 150;

type Plan = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  Plans?: Plan[];
};
const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];

let owner: Awaited<ReturnType<typeof person>>;
let folderId: string;
// A second handle on the same database whose only difference is that it records what it sends.
const sent: { text: string; params: unknown[] }[] = [];
const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
const recording = drizzle(pool, {
  schema,
  casing: "snake_case",
  logger: { logQuery: (text, params) => void sent.push({ text, params }) },
});

beforeAll(async () => {
  owner = await person();
  const folder = await makeFolder(owner.id);
  folderId = folder.id;
  await manyFiles(owner.id, folder.id, CHILDREN);
  for (let i = 0; i < 20; i++) await makeFolder(owner.id, folder.id);
  // No ANALYZE: the table is shared with every test file of the run, and nothing below depends
  // on what the planner happens to know about it.
}, 60_000);

/**
 * The plan of a statement when the planner is NOT ALLOWED to sort (this transaction only — the
 * two settings end with it): the answer to "can an index hand these rows over already in order",
 * whatever the table's statistics would make the planner prefer today.
 */
async function planWithoutSorting(statement: { text: string; params: unknown[] }): Promise<Plan[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_sort = off");
    await client.query("SET LOCAL enable_incremental_sort = off");
    const explained = await client.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
      statement.params,
    );
    return flatten((explained.rows[0] as { "QUERY PLAN": { Plan: Plan }[] })["QUERY PLAN"][0]!.Plan);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

afterAll(() => pool.end());

describe(`children of a folder with ${CHILDREN} files`, () => {
  it.each(SORTS.flatMap((sort) => (["asc", "desc"] as const).map((dir) => ({ sort, dir }))))(
    "sort=$sort dir=$dir: the sort's own index serves the page in order, reading one page of rows",
    async ({ sort, dir }) => {
      const list = (cursor?: string | null) =>
        listChildren(recording, {
          scope: { ownerId: owner.id },
          parentId: folderId,
          sort,
          dir,
          cursor,
          limit: 100,
          visibleStatuses: OWNER_VISIBLE_STATUSES,
        });
      sent.length = 0;
      // The first page (the folders, then the first files) and a page from the middle.
      const first = await list();
      const second = await list(first.nextCursor);
      expect(second.items).toHaveLength(100);
      const statements = sent.splice(0);
      expect(statements.length).toBeGreaterThanOrEqual(3);

      // The 5,000 files are what must come from the index, in order. Only what holds whatever the
      // table's statistics is asked: which plan the planner picks when free to choose moves with
      // them (on a database autoanalyze has not reached yet it may read the files through
      // another index), so that plan is not checked.
      const ofFiles = statements.filter((statement) => statement.params.includes("file"));
      expect(ofFiles).toHaveLength(2);
      for (const statement of ofFiles) {
        const label = `${sort} ${dir}`;
        // What keyset paging rests on: the sort HAS an index that serves the page in order.
        // Forbidden to sort, the plan is that index and a LIMIT — nothing else — and it read a
        // page's worth of rows, not the folder.
        const ordered = await planWithoutSorting(statement);
        expect(
          ordered.map((node) => node["Node Type"]),
          label,
        ).toEqual(["Limit", "Index Scan"]);
        expect(ordered[1]!["Index Name"], label).toBe(INDEX[sort]);
        expect(ordered[1]!["Actual Rows"], label).toBeLessThanOrEqual(101);
      }
    },
  );

  it.each(SORTS)(`sort=%s: p95 of GET /nodes/:id/children under ${P95_LIMIT_MS} ms`, async (sort) => {
    const path = `/nodes/${folderId}/children?sort=${sort}&limit=100`;
    const first = await api(owner.as, "GET", path);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(100);
    // From the middle of the listing as well: a keyset page costs the same wherever it starts.
    const cursor = encodeURIComponent(first.body.nextCursor);
    const times: number[] = [];
    for (let run = 0; run < 40; run++) {
      const started = performance.now();
      const answer = await api(owner.as, "GET", run % 2 ? `${path}&cursor=${cursor}` : path);
      times.push(performance.now() - started);
      expect(answer.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95, `median ${times[20]!.toFixed(1)} ms, max ${times[39]!.toFixed(1)} ms`).toBeLessThan(
      P95_LIMIT_MS,
    );
  });
});
