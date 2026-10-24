// "Run now" on a GUARDED job that the rollback detector or the pause switch stopped (task §11,
// T14 report fix pass 2): the answer is a STOP — `409 conflict`, `details.reason` `rolled_back` /
// `destroy_paused` — never `202 { done: false }`, so the console and the scripts do not loop on
// it. And R-a: Run now `reconcile` with the switch on deletes no orphan.
//
// TABLE-WIDE: real guarded jobs run over everything other files left behind. The rollback is
// made in this file's OWN bucket (the generation object two ahead of the database's number);
// the detector's bookkeeping (its mail time) and the control's counts write
// `settings.reconcileCursor`, which is put back in `afterAll`. The operators mailed on a rollback
// are a made-up address of this file.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { settings as settingsTable } from "../../../src/worker/db/schema";
import {
  DESTROY_PAUSED_KEY,
  GENERATION_KEY,
  reconcileStopReason,
  runReconcile,
  sweepOrphans,
  type OrphanSweep,
} from "../../../src/worker/jobs/reconcile";
import { keyFor } from "../../../src/worker/services/storage";
import { generationInStep, jobContext, objectExists, putObject, testDb } from "../trash/helpers";
import { adminCall, admin, member, operators } from "./helpers";

const HOUR = 3_600_000;
const REAL_RUN_MS = 300_000;

let found: unknown;
let hadCursor = false;
beforeAll(async () => {
  const stored = await getSettings(testDb(), { fresh: true });
  hadCursor = "reconcileCursor" in stored;
  found = stored.reconcileCursor;
});
afterEach(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});
afterAll(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
  if (hadCursor) await setSetting(testDb(), "reconcileCursor", found, null);
  else await testDb().delete(settingsTable).where(eq(settingsTable.key, "reconcileCursor"));
});

const ops = operators();
const run = async (name: string) =>
  adminCall((await admin()).as, "POST", `/jobs/${name}/run`, { env: ops.env });

describe("Run now never loops on a stopped guarded job", () => {
  it(
    "rolled back → exactly 409 rolled_back on the first call; the pause switch → 409 destroy_paused; control in step → 200/202",
    async () => {
      const database = await generationInStep();
      await env.FILES.put(GENERATION_KEY, String(database + 2));
      const rolled = await run("purge");
      expect([rolled.status, rolled.body.error, rolled.body.details]).toEqual([
        409,
        "conflict",
        { reason: "rolled_back" },
      ]);

      await env.FILES.put(GENERATION_KEY, String(database));
      await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");
      const paused = await run("purge");
      expect([paused.status, paused.body.details]).toEqual([409, { reason: "destroy_paused" }]);
      await env.FILES.delete(DESTROY_PAUSED_KEY);

      // Control: in step and unpaused, the same call is a pass (done or not yet), never a stop.
      const live = await run("purge");
      expect([200, 202]).toContain(live.status);
      expect(live.body).toMatchObject({ name: "purge" });
    },
    REAL_RUN_MS,
  );
});

describe("R-a: Run now reconcile with the switch on deletes no orphan", () => {
  // The route runs the job with the real clock, and the sweep takes only objects older than 48 h
  // by the store's OWN upload time, which a test cannot set. So the deletion itself is proven on
  // `runReconcile` with a moved sweep clock (`now`, as tests/unit/trash/reconcile.tablewide.test.ts
  // does), under the same switch; the route's part is its answer: a stop, not "not done yet".
  it(
    "switch on: the route answers 409 destroy_paused, the run sweeps nothing and the orphan stays; control: switch off, it is swept",
    async () => {
      await generationInStep();
      const owner = await member();
      const orphan = keyFor(owner.id, uuidv7(), uuidv7());
      await putObject(orphan, "nobody's");
      await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");

      const answer = await run("reconcile");
      expect([answer.status, answer.body.details]).toEqual([409, { reason: "destroy_paused" }]);
      const paused = jobContext({ env: ops.env });
      const stopped = await runReconcile(paused.bg, {
        softDeadlineMs: 120_000,
        now: new Date(Date.now() + 72 * HOUR),
      });
      await paused.settle();
      expect(stopped).toMatchObject({ generation: "paused", sweep: null });
      expect(await objectExists(orphan)).toBe(true);

      await env.FILES.delete(DESTROY_PAUSED_KEY);
      const live = jobContext({ env: ops.env });
      const swept = await runReconcile(live.bg, {
        softDeadlineMs: 120_000,
        now: new Date(Date.now() + 72 * HOUR),
      });
      await live.settle();
      expect(swept.sweep?.outcome).toBe("swept");
      expect(await objectExists(orphan)).toBe(false);
    },
    REAL_RUN_MS,
  );
});

describe("func-3: Run now reconcile ends on a stop another pass cannot change", () => {
  it(
    "orphan deletion off: once the quota half is done the answer is 409 orphans_disabled — never 202 for ever",
    async () => {
      await generationInStep();
      const who = await admin();
      const statuses: number[] = [];
      let last: Awaited<ReturnType<typeof adminCall>> | null = null;
      for (let pass = 0; pass < 12; pass++) {
        last = await adminCall(who.as, "POST", "/jobs/reconcile/run", {
          env: ops.env,
          settings: { orphanDeleteEnabled: false },
        });
        statuses.push(last.status);
        if (last.status !== 202) break;
      }
      expect([last!.status, last!.body.details], statuses.join(",")).toEqual([
        409,
        { reason: "orphans_disabled" },
      ]);
    },
    REAL_RUN_MS,
  );

  it("the stop reasons, from a run: the threshold at once; disabled once the quota half is done; otherwise none", () => {
    const sweep = (outcome: OrphanSweep["outcome"]): OrphanSweep => ({
      outcome,
      listed: 0,
      candidates: 0,
      deleted: 0,
      area: 0,
      object: null,
      done: false,
    });
    expect(reconcileStopReason(false, sweep("orphan_threshold"))).toBe("orphan_threshold");
    expect(reconcileStopReason(true, sweep("disabled"))).toBe("orphans_disabled");
    expect(reconcileStopReason(false, sweep("disabled"))).toBeNull();
    expect(reconcileStopReason(true, sweep("swept"))).toBeNull();
    expect(reconcileStopReason(true, null)).toBeNull();
  });
});

describe("func-n3: the orphan sweep asks the pause switch again right before it deletes", () => {
  it(
    "switch on when the sweep runs (after the slot's reading): nothing deleted, `destroy_paused`; control: off → swept",
    async () => {
      await generationInStep();
      const owner = await member();
      const orphan = keyFor(owner.id, uuidv7(), uuidv7());
      await putObject(orphan, "nobody's");
      await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");
      const later = new Date(Date.now() + 72 * HOUR);
      const paused = jobContext({ env: ops.env });
      const stopped = await sweepOrphans(paused.bg, {
        from: { area: 0, object: null },
        stopAt: Date.now() + 60_000,
        now: later,
      });
      await paused.settle();
      expect(stopped.outcome).toBe("destroy_paused");
      expect(await objectExists(orphan)).toBe(true);

      await env.FILES.delete(DESTROY_PAUSED_KEY);
      const live = jobContext({ env: ops.env });
      const swept = await sweepOrphans(live.bg, {
        from: { area: 0, object: null },
        stopAt: Date.now() + 60_000,
        now: later,
      });
      await live.settle();
      expect(swept.outcome).toBe("swept");
      expect(await objectExists(orphan)).toBe(false);
    },
    REAL_RUN_MS,
  );
});
