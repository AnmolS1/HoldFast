// Every Workers test file starts with the rollback detector IN STEP for its own bucket.
//
// Each test file has a bucket of its own but ONE database is shared by all of them. A file whose
// bucket holds no generation object while the database has counted (another file's reconcile or
// heartbeat test moved it) reads as "rolled back" (reconcile.ts `classify`: a missing object
// while the database is past 0), and every object delete that asks `readsRolledBack` — uploads,
// avatars, thumbnails, purge — keeps its object. Which file ran first decided whether a delete
// test passed (avatar.test.ts, 2026-10-21; thumbs.test.ts, 2026-10-20).
//
// So before a file's tests, an absent object is written at the database's current number. An
// object at or behind the database reads "ok", so later counts by other files cannot flip it; a
// file that tests a rollback sets its own object (ahead of the database) and is unaffected. An
// object that is already there is left alone.
//
// This file imports NO application module: a setup file is evaluated before a test file's
// `vi.mock` calls take effect, so importing app code here would bind those modules to the real
// implementations (admin-emails.test.ts's mocked reporter, 2026-10-21). The key and the parse rule
// are restated here and pinned to reconcile.ts by tests/unit/trash/generation-setup.test.ts.
import { env } from "cloudflare:workers";
import { Client } from "pg";
import { beforeAll } from "vitest";

export const SETUP_GENERATION_KEY = "sys/reconcile-generation";

/** reconcile.ts `parseGeneration`, restated: canonical digits only, a safe integer. */
export function setupParseGeneration(text: string): number | null {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

beforeAll(async () => {
  if ((await env.FILES.head(SETUP_GENERATION_KEY)) !== null) return;
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    const result = await client.query<{ generation: string | null }>(
      `SELECT (value -> 'generation')::text AS generation FROM settings
        WHERE key = 'reconcileCursor' AND jsonb_typeof(value) = 'object'`,
    );
    const raw = result.rows[0]?.generation ?? null;
    const database = raw === null ? 0 : setupParseGeneration(raw);
    // 0 (nothing counted) with no object is "first", already fine; an unreadable number is left
    // for the file's own tests to meet.
    if (database === null || database === 0) return;
    await env.FILES.put(SETUP_GENERATION_KEY, String(database));
  } finally {
    await client.end();
  }
});
