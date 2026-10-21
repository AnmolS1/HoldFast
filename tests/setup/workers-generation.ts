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
// object that is already there — the file wrote one, or a test put it there — is left alone.
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import { createDb } from "../../src/worker/db/client";
import { readDetectorFields } from "../../src/worker/db/queries/trash-jobs";
import { GENERATION_KEY, parseGeneration } from "../../src/worker/jobs/reconcile";

beforeAll(async () => {
  if ((await env.FILES.head(GENERATION_KEY)) !== null) return;
  const handle = createDb(env);
  try {
    const raw = (await readDetectorFields(handle.db)).generation;
    const database = raw === null ? 0 : parseGeneration(raw);
    // 0 (nothing counted) with no object is "first", already fine; an unreadable number is left
    // for the file's own tests to meet.
    if (database === null || database === 0) return;
    await env.FILES.put(GENERATION_KEY, String(database));
  } finally {
    await handle.close();
  }
});
