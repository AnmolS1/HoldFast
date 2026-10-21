// Addendum 3 (review m8): the two indexes the report intake's counts use — the per-reporter cap
// (`reporter_ip_hash_stable`, `created_at`) and the per-link alert cap (`link_id`, `status`) —
// exist (migration 0009, expand-only), and the planner can use them for those counts.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "../services-core/helpers";

describe("the reports indexes (migration 0009)", () => {
  it("exist, on exactly these columns", async () => {
    const result = await testDb().execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'reports' AND indexname IN ('reports_reporter_created_idx', 'reports_link_status_idx')
      ORDER BY indexname`);
    expect(result.rows.map((row) => [row.indexname, row.indexdef.replace(/^.*USING btree /, "")])).toEqual([
      ["reports_link_status_idx", "(link_id, status)"],
      ["reports_reporter_created_idx", "(reporter_ip_hash_stable, created_at)"],
    ]);
  });
});
