// "Accept the database's generation" (task §11; T14 report F3 + S11; T14-review-2 (b); S14): one
// audited, two-step action that levels the two copies of the generation — the database's
// `generation` FIELD moved by compare-and-set (never the whole `reconcileCursor`), or the object
// rewritten — under the generation lock, from a reading made under that lock.
//
// TABLE-WIDE: it writes `settings.reconcileCursor`. The row is snapshotted raw in `beforeAll` and
// put back exactly in `afterAll`; the generation object lives in this file's own bucket.
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearSettingsCache, setSetting } from "../../../src/worker/db/queries/settings";
import { withJobLock } from "../../../src/worker/db/queries/trash-jobs";
import { DESTROY_PAUSED_KEY, GENERATION_KEY, GENERATION_LOCK } from "../../../src/worker/jobs/reconcile";
import { gate } from "../services-core/helpers";
import { adminCall, admin, auditOf, baId, member, rand, testDb, type Who } from "./helpers";

let saved: string | null = null;
beforeAll(async () => {
  const result = await testDb().execute<{ value: string }>(
    sql`SELECT value::text AS value FROM settings WHERE key = 'reconcileCursor'`,
  );
  saved = result.rows[0]?.value ?? null;
});
afterAll(async () => {
  if (saved === null) await testDb().execute(sql`DELETE FROM settings WHERE key = 'reconcileCursor'`);
  else {
    await testDb().execute(sql`
      INSERT INTO settings (key, value, updated_by) VALUES ('reconcileCursor', ${saved}::jsonb, NULL)
      ON CONFLICT (key) DO UPDATE SET value = ${saved}::jsonb`);
  }
  clearSettingsCache();
  await env.FILES.delete(GENERATION_KEY);
});

/** The cursor with everything a reconcile run and the detector keep in it, at `generation`. */
const CURSOR = (generation: number) => ({
  user: "made-up-user-cursor",
  area: 1,
  object: "u/made-up/object-cursor",
  generation,
  rollbackMailedAt: "2099-01-01T00:00:00.000Z",
  unknownMailedAt: "2099-01-02T00:00:00.000Z",
});
async function state(object: string | null, database: number) {
  await setSetting(testDb(), "reconcileCursor", CURSOR(database), null);
  if (object === null) await env.FILES.delete(GENERATION_KEY);
  else await env.FILES.put(GENERATION_KEY, object);
}
const raw = async () =>
  (
    await testDb().execute<{ value: string; rest: string; generation: string | null }>(sql`
      SELECT value::text AS value, (value - 'generation')::text AS rest, (value -> 'generation')::text AS generation
      FROM settings WHERE key = 'reconcileCursor'`)
  ).rows[0]!;
const objectText = async () => (await (await env.FILES.get(GENERATION_KEY))?.text()) ?? null;
const rowsFor = async (reason: string) =>
  (await auditOf("admin.generation_accepted", "generation")).filter(
    (row) => (row.meta as { reason?: string } | null)?.reason === reason,
  );

const CHECKLIST = { pausedAndOrphansOff: true, reapplied: true, reconciled: true };
const accept = (who: Who, body: Record<string, unknown>, env?: Record<string, unknown>) =>
  adminCall(who, "POST", "/system/generation", { body, ...(env ? { env } : {}) });

let reason = "";
// Levelling is done only with the pause switch ON (review m7, server-side): this file's bucket
// has it on for every case (fix-pass.test.ts proves the refusal with it off).
beforeEach(async () => {
  reason = `restored ${rand()}`;
  await env.FILES.put(DESTROY_PAUSED_KEY, "paused for the generation tests");
});
afterAll(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});

describe("object ahead → the database's generation FIELD moves, nothing else", () => {
  it("preview writes nothing and audits nothing; the confirm moves `generation` only — the rest of reconcileCursor byte-identical", async () => {
    const who = await admin();
    await state("7", 5);
    const before = await raw();
    const preview = await accept(who.as, { reason });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      confirmed: false,
      action: "advance_database",
      before: { object: "7", database: "5" },
      after: null,
      detector: { reading: "object_ahead" },
    });
    expect((await raw()).value).toBe(before.value);
    expect(await rowsFor(reason)).toEqual([]);

    const done = await accept(who.as, { reason, confirm: true, checklist: CHECKLIST });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      confirmed: true,
      action: "advance_database",
      after: { object: "7", database: "7" },
      detector: { reading: "level" },
    });
    const after = await raw();
    expect(after.generation).toBe("7");
    expect(after.rest).toBe(before.rest);
    expect(await objectText()).toBe("7");
    const [row] = await rowsFor(reason);
    expect(row).toMatchObject({
      actorUserId: who.id,
      actorType: "admin",
      meta: {
        reason,
        action: "advance_database",
        before: { object: "7", database: "5" },
        after: { database: "7" },
      },
    });
  });

  it("decided again at the confirm, under the lock: levelled meanwhile → 409 level, nothing written; moved on meanwhile → levelled from the fresh reading", async () => {
    const who = await admin();
    await state("7", 5);
    expect((await accept(who.as, { reason })).body.action).toBe("advance_database");
    // A count lands between the preview and the confirm: the two are level now.
    await setSetting(testDb(), "reconcileCursor", CURSOR(7), null);
    const level = await raw();
    const refused = await accept(who.as, { reason, confirm: true, checklist: CHECKLIST });
    expect([refused.status, refused.body.details]).toEqual([409, { reason: "level" }]);
    expect((await raw()).value).toBe(level.value);
    expect(await rowsFor(reason)).toEqual([]);

    // Or the database moved, but not all the way: the confirm compares from what it reads NOW.
    await state("9", 5);
    expect((await accept(who.as, { reason })).body.before).toEqual({ object: "9", database: "5" });
    await setSetting(testDb(), "reconcileCursor", CURSOR(6), null);
    const moved = await accept(who.as, { reason, confirm: true, checklist: CHECKLIST });
    expect(moved.status).toBe(200);
    expect(moved.body.before).toEqual({ object: "9", database: "6" });
    expect((await raw()).generation).toBe("9");
  });
});

describe("object missing or not a number → the object is rewritten with the database's number", () => {
  it('object "8.0" (an anomaly) → rewritten as "5"; the database untouched', async () => {
    const who = await admin();
    await state("8.0", 5);
    const before = await raw();
    const done = await accept(who.as, { reason, confirm: true, checklist: CHECKLIST });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ action: "rewrite_object", after: { object: "5", database: "5" } });
    expect(await objectText()).toBe("5");
    expect((await raw()).value).toBe(before.value);
  });

  it("object missing while the database counted → written back with the database's number", async () => {
    const who = await admin();
    await state(null, 4);
    const done = await accept(who.as, { reason, confirm: true, checklist: CHECKLIST });
    expect(done.body).toMatchObject({ action: "rewrite_object" });
    expect(await objectText()).toBe("4");
  });
});

describe("refusals: nothing is written", () => {
  it("a copy that cannot be read → 409 unreadable (preview and confirm)", async () => {
    const who = await admin();
    await state("7", 5);
    const before = await raw();
    const broken = new Proxy(env.FILES, {
      get: (target, name) =>
        name === "get"
          ? async (key: string, options?: R2GetOptions) => {
              if (key === GENERATION_KEY) throw new Error("R2 is unavailable");
              return target.get(key, options);
            }
          : (Reflect.get(target, name, target) as () => unknown).bind(target),
    });
    for (const body of [{ reason }, { reason, confirm: true, checklist: CHECKLIST }]) {
      const answer = await accept(who.as, body, { FILES: broken });
      expect([answer.status, answer.body.details]).toEqual([409, { reason: "unreadable" }]);
    }
    expect((await raw()).value).toBe(before.value);
    expect(await objectText()).toBe("7");
  });

  it("the generation lock held elsewhere (a reconcile run, the heartbeat) → 409 lock_held", async () => {
    const who = await admin();
    await state("7", 5);
    const before = await raw();
    const entered = gate();
    const release = gate();
    const holder = withJobLock(testDb(), GENERATION_LOCK, 60_000, async () => {
      entered.open();
      await release.opened;
    });
    await entered.opened;
    try {
      const answer = await accept(who.as, { reason, confirm: true, checklist: CHECKLIST });
      expect([answer.status, answer.body.details]).toEqual([409, { reason: "lock_held" }]);
    } finally {
      release.open();
      await holder;
    }
    expect((await raw()).value).toBe(before.value);
    expect(await rowsFor(reason)).toEqual([]);
  });

  it("non-admin, no fresh second factor, impersonated, no reason, no confirm, a confirm without the checklist → nothing changes", async () => {
    const who = await admin();
    const someone = await member();
    await state("7", 5);
    const before = await raw();
    const full = { reason, confirm: true, checklist: CHECKLIST };
    expect((await accept(someone.as, full)).status).toBe(403);
    expect((await accept({ ...who.as, secondFactorAt: null }, full)).body.error).toBe("admin_requires_2fa");
    expect((await accept({ ...who.as, impersonatedBy: baId() }, full)).status).toBe(403);
    expect((await accept(who.as, { confirm: true, checklist: CHECKLIST })).status).toBe(400);
    expect((await accept(who.as, { reason: "", confirm: true, checklist: CHECKLIST })).status).toBe(400);
    expect((await accept(who.as, { reason })).body.confirmed).toBe(false);
    const noList = await accept(who.as, { reason, confirm: true });
    expect([noList.status, noList.body.details?.reason]).toEqual([400, "checklist"]);
    const partial = await accept(who.as, {
      reason,
      confirm: true,
      checklist: { pausedAndOrphansOff: true, reapplied: true },
    });
    expect(partial.status).toBe(400);
    expect((await raw()).value).toBe(before.value);
    expect(await objectText()).toBe("7");
    expect(await rowsFor(reason)).toEqual([]);
  });
});
