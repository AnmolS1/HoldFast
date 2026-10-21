// PERFFIX: the kept deleted-for-good bytes (`quota.ts` — `reserve` on every upload, the usage
// figure, the backstop) cost what the OWNER keeps, not what the table holds. The statement is
// planned with no sequential scan of `nodes` or `node_versions`, and the pages it reads for one
// owner do not change when other owners' rows (their deleted-for-good roots and old versions
// included) are added to the table.
//
// TABLE-WIDE: it bulk-inserts other owners' rows and runs ANALYZE so the planner sees a large
// table. Its own rows are deleted again in `afterAll`.
import { inArray, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { deletedKeptBytes, keptBackstopReached } from "../../../src/worker/db/queries/quota";
import { nodes, nodeVersions, user } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeUser, testDb } from "../services-core/helpers";

const OTHER_OWNERS = 10;
/** Per other owner and per batch: 10 folders, then files under them. */
const NODES_PER_OWNER = 1_000;

const users: string[] = [];
let owner = "";

/** The statement `run` sends through its executor, without running it. */
async function statementOf(run: (db: Executor) => Promise<unknown>): Promise<SQL> {
  let captured: SQL | undefined;
  const capture = {
    execute: async (query: SQL) => {
      captured = query;
      return { rows: [] };
    },
  } as unknown as Executor;
  await run(capture);
  return captured!;
}

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
};

async function explain(query: SQL): Promise<PlanNode> {
  const result = await testDb().execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
  );
  return result.rows[0]!["QUERY PLAN"][0].Plan;
}

/** Every node of the plan, children included. */
function planNodes(plan: PlanNode): PlanNode[] {
  return [plan].concat(...(plan.Plans ?? []).map(planNodes));
}

const pagesRead = (plan: PlanNode) => (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);

/** Other owners' trees: every one with a deleted-for-good folder and old versions. */
async function addOtherOwners(batch: number) {
  for (let i = 0; i < OTHER_OWNERS; i++) {
    const other = await makeUser({ quotaBytes: 1_000_000_000_000 });
    users.push(other.id);
    await testDb().execute(sql`
      WITH folders AS (
        INSERT INTO nodes (id, owner_id, kind, name, name_key, deleted_at, trashed_root, purge_requested_at)
        SELECT gen_random_uuid(), ${other.id}, 'folder', 'perffix-' || ${batch} || '-' || g, 'perffix-' || ${batch} || '-' || g,
               CASE WHEN g = 0 THEN now() END, g = 0, CASE WHEN g = 0 THEN now() END
        FROM generate_series(0, 9) g
        RETURNING id, name
      ), files AS (
        INSERT INTO nodes (id, owner_id, parent_id, kind, name, name_key, size)
        SELECT gen_random_uuid(), ${other.id}, f.id, 'file', 'f' || g || '.bin', 'f' || g || '.bin', 1000
        FROM folders f, generate_series(1, ${NODES_PER_OWNER / 10 - 1}) g
        RETURNING id
      )
      INSERT INTO node_versions (node_id, version_id, r2_key, size, purge_after)
      SELECT id, 'v1', 'perffix/' || id, 10, now() + interval '30 days' FROM files`);
  }
  await testDb().execute(sql`ANALYZE nodes`);
  await testDb().execute(sql`ANALYZE node_versions`);
}

beforeAll(async () => {
  // The owner measured: a deleted-for-good folder with a subfolder (itself requested: counted
  // once), files and old versions; and a live folder that does not count.
  const subject = await makeUser({ quotaBytes: 1_000_000 });
  owner = subject.id;
  users.push(owner);
  const asked = await makeFolder(owner);
  const nested = await makeFolder(owner, asked.id);
  const live = await makeFolder(owner);
  const files = [
    await makeFile(owner, asked.id, { size: 100 }),
    await makeFile(owner, nested.id, { size: 20 }),
    await makeFile(owner, live.id, { size: 5_000 }),
  ];
  await testDb()
    .insert(nodeVersions)
    .values(
      files.map((file, i) => ({
        nodeId: file.id,
        versionId: uuidv7(),
        r2Key: `perffix/${file.id}`,
        size: [7, 3, 900][i]!,
        purgeAfter: new Date(Date.now() + 30 * 86_400_000),
      })),
    );
  await testDb()
    .update(nodes)
    .set({ deletedAt: new Date(), purgeRequestedAt: new Date() })
    .where(inArray(nodes.id, [asked.id, nested.id]));
  await addOtherOwners(0);
});

afterAll(async () => {
  if (users.length === 0) return;
  // One statement (the parent key is checked at its end); versions go with their nodes.
  await testDb().delete(nodes).where(inArray(nodes.ownerId, users));
  await testDb().delete(user).where(inArray(user.id, users));
  await testDb().execute(sql`ANALYZE nodes`);
  await testDb().execute(sql`ANALYZE node_versions`);
});

describe("the kept deleted-for-good bytes: one owner's cost", () => {
  it("counts the owner's kept tree once (the nested requested root included once)", async () => {
    expect(await deletedKeptBytes(testDb(), owner)).toEqual({ files: 120, versions: 10 });
  });

  it("is planned with no sequential scan of nodes or node_versions, from the owner's requested roots", async () => {
    for (const query of [
      await statementOf((db) => deletedKeptBytes(db, owner)),
      await statementOf((db) => keptBackstopReached(db, owner)),
    ]) {
      const plan = planNodes(await explain(query));
      const seqScans = plan
        .filter((node) => node["Node Type"] === "Seq Scan")
        .map((node) => node["Relation Name"]);
      expect(seqScans.filter((name) => name === "nodes" || name === "node_versions")).toEqual([]);
      expect(plan.map((node) => node["Index Name"])).toContain("nodes_owner_purge_requested_idx");
    }
  });

  it("reads the same pages for the owner when the table doubles with other owners' rows", async () => {
    const query = await statementOf((db) => deletedKeptBytes(db, owner));
    await explain(query); // warm
    const before = pagesRead(await explain(query));
    await addOtherOwners(1);
    const after = pagesRead(await explain(query));
    // 10,000 more nodes are hundreds of pages; a few index descents may cost one more page each
    // if a btree gains a level between the two reads.
    expect(after - before).toBeLessThanOrEqual(16);
    expect(await deletedKeptBytes(testDb(), owner)).toEqual({ files: 120, versions: 10 });
  });
});
