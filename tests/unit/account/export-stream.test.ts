// T23 review M3 (brief Addendum 3): the export never holds the account's whole tree. Nodes are
// read a keyset page at a time AS THE BODY IS READ (backpressure), on a pool of the stream's own
// registered with `waitUntil` before the response returns; and an account exports one at a time,
// at most EXPORT_DAILY_LIMIT times a day (429 with Retry-After otherwise).
//
// HOW "MEMORY STAYS BOUNDED" IS SHOWN. Local workerd has no per-request memory accounting (and
// enforces no limit — brief caveat), so it is shown by what is read when: with 50,000 nodes (25
// pages) the client reads the first bytes and then PAUSES: while it does, the producer stops too
// (statements counted on every pool the request opened), and the rest of the pages are read only
// once the client reads on. At no time can more than one page and one encoded chunk be held.
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ExportManifest } from "../../../src/shared/schemas/account";
import { createApp } from "../../../src/worker/app";
import type { Auth, SessionInfo } from "../../../src/worker/auth/types";
import { statementsSent, type Db } from "../../../src/worker/db/client";
import {
  EXPORT_DAILY_LIMIT,
  EXPORT_LIMITS,
  EXPORT_MAX_RUNTIME_S,
  EXPORT_PAGE,
  EXPORT_RUNNING_MAX_S,
  exportSlotKeys,
  refundExportDay,
} from "../../../src/worker/db/queries/account";
import type { CoreDeps } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { BASE_SETTINGS, realCore, testDb } from "../auth/helpers";
import { person } from "../nodes/helpers";

const allow = { limit: async () => ({ success: true }) };

/** One GET /api/account/export as `who`, the body NOT read; every pool the request opens is counted. */
async function startExport(who: Awaited<ReturnType<typeof person>>) {
  const handles: Db[] = [];
  const auth: Auth = {
    handler: async () => new Response(null, { status: 501 }),
    api: {
      getSession: async () => ({
        session: {
          id: "s".repeat(32),
          userId: who.id,
          token: "made-up-session-token", // not a credential: the stand-in auth never checks it
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt: new Date(),
          updatedAt: new Date(),
          impersonatedBy: null,
          secondFactorAt: null,
        } satisfies SessionInfo,
        user: who.row,
      }),
    },
  };
  const core: CoreDeps = {
    ...realCore,
    createDb: (...args) => {
      const made = realCore.createDb(...args);
      handles.push(made.db);
      return made;
    },
    createAuth: () => auth,
    getSettings: async () => BASE_SETTINGS,
  };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const requestEnv = {
    ...env,
    RL_AUTH: allow,
    RL_API: allow,
    RL_FILES: allow,
    RL_LINKS: allow,
  } as unknown as Env;
  const response = await createApp(core).fetch(
    new Request(`${TEST_APP_ORIGIN}/api/account/export`),
    requestEnv,
    ctx,
  );
  return {
    response,
    statements: () => handles.reduce((sum, handle) => sum + statementsSent(handle), 0),
    settle: async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}

async function readAll(response: Response): Promise<string> {
  const text = await response.text();
  return text;
}

describe("the export streams the tree", () => {
  it("50,000 nodes: read a page at a time as the body is read, never the whole tree first", async () => {
    const who = await person();
    await testDb().execute(sql`
      INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
      SELECT gen_random_uuid(), ${who.id}, ${who.id}, NULL, 'file', 'f-' || g || '.txt', 'f-' || g || '.txt', 'txt', 1, 'clean'
      FROM generate_series(1, 50000) AS g`);
    const run = await startExport(who);
    expect(run.response.status).toBe(200);
    const reader = run.response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const first = await reader.read();
    text += decoder.decode(first.value, { stream: true });
    // The client stops reading for a while: with backpressure the producer stops too — at most
    // the page it was writing and the next are read meanwhile, however long the pause.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const whilePaused = run.statements();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await run.settle();
    const total = run.statements();
    const pages = Math.ceil(50_000 / EXPORT_PAGE);
    // Most node pages were read only once the client read on.
    expect(total - whilePaused).toBeGreaterThanOrEqual(pages - 3);
    const manifest = ExportManifest.parse(JSON.parse(text));
    expect(manifest.nodes).toHaveLength(50_000);
    expect(new Set(manifest.nodes.map((node) => node.id)).size).toBe(50_000);
  }, 120_000);
});

describe("the export limiter", () => {
  it("one at a time: while an export of the account runs, another is 429 with Retry-After; after it, the next is admitted", async () => {
    const who = await person();
    const running = await startExport(who);
    expect(running.response.status).toBe(200);
    const second = await startExport(who);
    expect(second.response.status).toBe(429);
    expect(Number(second.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await second.response.json()) as { error: string }).error).toBe("rate_limited");
    await readAll(running.response);
    await running.settle();
    const third = await startExport(who);
    expect(third.response.status).toBe(200);
    await readAll(third.response);
    await third.settle();
  });

  it(`at most ${EXPORT_DAILY_LIMIT} a day: the next one is 429 with a Retry-After of at most a day`, async () => {
    const who = await person();
    for (let i = 0; i < EXPORT_DAILY_LIMIT; i += 1) {
      const run = await startExport(who);
      expect(run.response.status, `export ${i + 1}`).toBe(200);
      await readAll(run.response);
      await run.settle();
    }
    const refused = await startExport(who);
    expect(refused.response.status).toBe(429);
    const wait = Number(refused.response.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400);
    // A refused export holds no slot: the running key is free again.
    const keys = exportSlotKeys(who.id);
    const rows = await testDb().execute(sql`SELECT count FROM rate_limit WHERE key = ${keys.running}`);
    expect(rows.rows).toEqual([]);
  });

  it("a late release frees only its own slot: an export that outlived the slot does not end its successor's", async () => {
    const who = await person();
    const keys = exportSlotKeys(who.id);
    const first = await startExport(who);
    expect(first.response.status).toBe(200);
    // The first export outlives its slot (a stream that has run past EXPORT_RUNNING_MAX_S).
    await testDb().execute(
      sql`UPDATE rate_limit SET last_request = last_request - ${(EXPORT_RUNNING_MAX_S + 1) * 1000} WHERE key = ${keys.running}`,
    );
    const second = await startExport(who);
    expect(second.response.status).toBe(200);
    const slot = async () =>
      (await testDb().execute<{ id: string }>(sql`SELECT id FROM rate_limit WHERE key = ${keys.running}`))
        .rows;
    const held = await slot();
    expect(held).toHaveLength(1);
    // The first export ends now — its release must leave the second's slot alone.
    await readAll(first.response);
    await first.settle();
    expect(await slot()).toEqual(held);
    expect((await startExport(who)).response.status).toBe(429);
    await readAll(second.response);
    await second.settle();
    expect(await slot()).toEqual([]);
  });

  it("an export that fails on our side does not spend one of the day's exports, nor hold the slot", async () => {
    const who = await person();
    const keys = exportSlotKeys(who.id);
    // The account row is gone by the time the export reads it: its reads fail before anything is
    // handed over.
    await testDb().execute(sql`DELETE FROM "user" WHERE id = ${who.id}`);
    const failed = await startExport(who);
    expect(failed.response.status).toBeGreaterThanOrEqual(400);
    await failed.settle();
    const day = await testDb().execute<{ count: number }>(
      sql`SELECT count FROM rate_limit WHERE key = ${keys.day}`,
    );
    expect(day.rows.map((row) => Number(row.count))).toEqual([0]);
    const running = await testDb().execute(sql`SELECT 1 FROM rate_limit WHERE key = ${keys.running}`);
    expect(running.rows).toEqual([]);
  });

  it("an export ends by its own maximum runtime before its slot could be taken over (two never overlap)", () => {
    expect(EXPORT_MAX_RUNTIME_S).toBeLessThan(EXPORT_RUNNING_MAX_S);
  });

  it("a reader that stops reading cannot hold the export past its maximum runtime: it ends, and its slot is free for the next", async () => {
    const who = await person();
    await testDb().execute(sql`
      INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
      SELECT gen_random_uuid(), ${who.id}, ${who.id}, NULL, 'file', 'f-' || g || '.txt', 'f-' || g || '.txt', 'txt', 1, 'clean'
      FROM generate_series(1, 10) AS g`);
    const keys = exportSlotKeys(who.id);
    const saved = EXPORT_LIMITS.maxRuntimeMs;
    EXPORT_LIMITS.maxRuntimeMs = 800;
    try {
      const stalled = await startExport(who);
      expect(stalled.response.status).toBe(200);
      const reader = stalled.response.body!.getReader();
      await reader.read();
      // The client stops reading here. The producer's next write waits on it — until the deadline.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const slot = await testDb().execute(sql`SELECT 1 FROM rate_limit WHERE key = ${keys.running}`);
      expect(slot.rows).toEqual([]);
      const next = await startExport(who);
      expect(next.response.status).toBe(200);
      await readAll(next.response);
      await next.settle();
      // The stalled body ends in an error, never in a complete file.
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return "complete";
        })(),
      ).rejects.toBeTruthy();
      await stalled.settle();
    } finally {
      EXPORT_LIMITS.maxRuntimeMs = saved;
    }
  });

  it("an export that failed AFTER bytes were handed over is not given back; one that failed before is (the account test above)", async () => {
    const who = await person();
    await testDb().execute(sql`
      INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
      SELECT gen_random_uuid(), ${who.id}, ${who.id}, NULL, 'file', 'f-' || g || '.txt', 'f-' || g || '.txt', 'txt', 1, 'clean'
      FROM generate_series(1, ${EXPORT_PAGE + 1}) AS g`);
    // A row the export's contract refuses, last in id order (the second page): our failure, mid-stream.
    await testDb().execute(sql`
      INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status, sha256)
      VALUES (${`ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`}::uuid, ${who.id}, ${who.id}, NULL, 'file', 'bad.txt', 'bad.txt', 'txt', 1, 'clean', 'not-a-digest')`);
    const keys = exportSlotKeys(who.id);
    const run = await startExport(who);
    expect(run.response.status).toBe(200);
    await expect(readAll(run.response)).rejects.toBeTruthy();
    await run.settle();
    const day = await testDb().execute<{ count: number }>(
      sql`SELECT count FROM rate_limit WHERE key = ${keys.day}`,
    );
    expect(day.rows.map((row) => Number(row.count))).toEqual([1]);
    expect((await testDb().execute(sql`SELECT 1 FROM rate_limit WHERE key = ${keys.running}`)).rows).toEqual(
      [],
    );
  });

  it("a refund credits only the window it was charged in, never a later one", async () => {
    const who = await person();
    const { day } = exportSlotKeys(who.id);
    await testDb().execute(
      sql`INSERT INTO rate_limit (id, key, count, last_request) VALUES (gen_random_uuid()::text, ${day}, 3, 2000)`,
    );
    await refundExportDay(testDb(), who.id, 1000);
    const count = async () =>
      Number(
        (await testDb().execute<{ count: number }>(sql`SELECT count FROM rate_limit WHERE key = ${day}`))
          .rows[0]!.count,
      );
    expect(await count()).toBe(3);
    await refundExportDay(testDb(), who.id, 2000);
    expect(await count()).toBe(2);
  });
});
