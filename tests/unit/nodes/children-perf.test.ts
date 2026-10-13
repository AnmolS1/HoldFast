// A folder with 5,000 children: each of the four sorts finds its page through an index — the plan
// of the very statement the listing sends is checked — and the route's p95 stays under 150 ms.
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listChildren, OWNER_VISIBLE_STATUSES } from "../../../src/worker/db/queries/nodes";
import * as schema from "../../../src/worker/db/schema";
import { api, makeFolder, manyFiles, person, testDb } from "./helpers";

const CHILDREN = 5_000;
const SORTS = ["name", "size", "updated", "kind"] as const;
const INDEX = {
  name: "nodes_children_name_idx",
  size: "nodes_children_size_idx",
  updated: "nodes_children_updated_idx",
  kind: "nodes_children_ext_idx",
} as const;
/** Every index of `nodes` that finds a folder's children (`parent_id` among its leading columns). */
const BY_FOLDER: string[] = [...Object.values(INDEX), "nodes_live_name_child_uq", "nodes_owner_parent_idx"];
const P95_LIMIT_MS = 150;

type Plan = { "Node Type": string; "Index Name"?: string; "Relation Name"?: string; Plans?: Plan[] };
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
  // Fresh statistics for the rows just written; changes no data.
  await testDb().execute(sql`ANALYZE nodes`);
}, 60_000);

afterAll(() => pool.end());

describe(`children of a folder with ${CHILDREN} files`, () => {
  it.each(SORTS.flatMap((sort) => (["asc", "desc"] as const).map((dir) => ({ sort, dir }))))(
    "sort=$sort dir=$dir: the page is read through an index on the folder — never a table scan",
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

      // The 5,000 files are what must come from the index, in order. (The folder segment is 20
      // rows: however the planner reads those, it must not read the table.)
      const ofFiles = statements.filter((statement) => statement.params.includes("file"));
      expect(ofFiles).toHaveLength(2);
      for (const statement of statements) {
        const explained = await pool.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.params);
        const nodes = flatten(
          (explained.rows[0] as { "QUERY PLAN": { Plan: Plan }[] })["QUERY PLAN"][0]!.Plan,
        );
        const types = nodes.map((node) => node["Node Type"]);
        const label = `${sort} ${dir} ${statement.params.includes("file") ? "files" : "folders"}`;
        expect(types, label).not.toContain("Seq Scan");
        if (!ofFiles.includes(statement)) continue;
        // The folder's rows are found through an index that leads with the folder — never by
        // reading the table. WHICH index is the planner's choice and moves with the table's
        // statistics (one row estimate per parent for the whole table): the sort's own index read
        // in order and cut by the LIMIT, the unique live-name index with an incremental sort, or
        // the folder's rows through another of its indexes and a top-N sort of those rows alone.
        // All three are seen on this database; what must not appear is anything else.
        expect(types[0], label).toBe("Limit");
        expect(types[types.length - 1], label).toBe("Index Scan");
        expect(
          types.filter((type) => !["Limit", "Sort", "Incremental Sort", "Index Scan"].includes(type)),
          label,
        ).toEqual([]);
        expect(BY_FOLDER, label).toContain(nodes[nodes.length - 1]!["Index Name"]);
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
