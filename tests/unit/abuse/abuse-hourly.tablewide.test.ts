// abuse-hourly (T22 step 7): parts (0), (0b), (a), (b), the digest, and that a failing part stops
// nothing after it. TABLE-WIDE: the job reads whole tables, so this file runs alone (serial step).
//
// Every run here happens INSIDE ONE TRANSACTION THAT IS ROLLED BACK (`rolledBack`): fixtures are
// written through it and dated before every other row, so a part's limit reaches them first
// whatever earlier runs left behind, and nothing of a run is left in the shared database. The
// operators are a made-up mailbox of the test's own; every address and amount is made up.
import { env } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { utcDay } from "../../../src/worker/db/queries/ledger";
import {
  auditLog,
  downloadLedger,
  linkAccessLog,
  linkPasswordAttempts,
  nodes,
  reports,
  shareLinks,
  strikes,
  uploads,
  user as userTable,
} from "../../../src/worker/db/schema";
import { session as authSession } from "../../../src/worker/db/auth-schema";
import { ANOMALY, findingMarker, job, parts } from "../../../src/worker/jobs/abuse-hourly";
import { csamAlertMarker, lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { nameKeyOf } from "../../../src/worker/services/filename";
import { keyFor } from "../../../src/worker/services/storage";
import { mailTo, makeLink } from "../auth/helpers";
import { cronEvent, jobContext, makeFile, member, rand, TERMS, testDb } from "../trash/helpers";
import { baId } from "../services-core/helpers";
import { operators, sessionReport } from "./helpers";
import { makeFolder, makeShare } from "../sharing/helpers";

const ROLLBACK = Symbol("rollback");
const LONG_AGO = new Date(Date.UTC(1971, 0, 1));
const DAY = 86_400_000;

const original = { ...parts };
afterEach(() => {
  Object.assign(parts, original);
  vi.useRealTimers();
});

async function rolledBack(body: (db: Db) => Promise<void>): Promise<void> {
  await testDb()
    .transaction(async (tx) => {
      await body(tx as unknown as Db);
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
}

/** One run of the job on `db`, its deferred work drained. */
async function runJob(db: Db, envOverride: Record<string, unknown>, settings?: Settings) {
  const ctx = jobContext({ db, env: envOverride, ...(settings ? { settings } : {}) });
  await job.run(ctx.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
  await ctx.settle();
  return ctx;
}

/** Every part a no-op but the ones a test names. */
function only(...keep: Array<keyof typeof parts>) {
  const noop = {
    sweepCsamAlerts: async () => ({ checked: 0, alerted: 0, recorded: 0 }),
    sweepUnrecordedCsamLocks: async () => ({ checked: 0, completed: 0, repeated: 0, skipped: 0, failed: 0 }),
    sweepOwedNodes: async () => ({ checked: 0, locked: 0, refused: 0, stale: 0, skipped: 0, failed: 0 }),
    sweepStrikeThresholds: async () => ({ checked: 0, suspended: 0, failed: 0 }),
    sweepPendingScans: async () => ({ checked: 0, requeued: 0 }),
    reportAnomalies: async () => [],
  };
  for (const name of Object.keys(noop) as Array<keyof typeof parts>) {
    if (!keep.includes(name)) (parts as Record<string, unknown>)[name] = noop[name];
  }
}

const critical = (address: string, id?: string) =>
  mailTo(address).filter((m) => /CRITICAL/.test(m.subject) && (!id || String(m.text).includes(id)));
const digests = (address: string) => mailTo(address).filter((m) => /admin digest/i.test(m.subject));
const errorReasons = (ctx: ReturnType<typeof jobContext>) =>
  ctx.metric.mock.calls
    .filter(([name, tags]) => name === "job" && (tags as { outcome?: string }).outcome === "error")
    .map(([, tags]) => (tags as { reason: string }).reason);

async function auditsOf(db: Db, action: string, targetId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));
}

let agedDays = 0;
/**
 * "Tomorrow" for one day marker: today's row is moved back to a day of its own (the row is the
 * test's own) — as if it had been claimed on an earlier day.
 */
async function ageMarker(db: Db, subjectId: string) {
  agedDays += 1;
  await db
    .update(downloadLedger)
    .set({ day: utcDay(new Date(Date.now() - agedDays * DAY)) })
    .where(
      and(
        eq(downloadLedger.day, utcDay(new Date())),
        eq(downloadLedger.subjectType, "notice"),
        eq(downloadLedger.subjectId, subjectId),
      ),
    );
}

async function markerCount(db: Db, subjectId: string) {
  const [row] = await db
    .select({ count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, utcDay(new Date())),
        eq(downloadLedger.subjectType, "notice"),
        eq(downloadLedger.subjectId, subjectId),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * A file locked through the one handler (its lock recorded, its operators told TODAY), its report
 * dated first in the queue. `ops`: who was told.
 */
async function lockedFile(db: Db, opsEnv: Record<string, unknown>) {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
  const ctx = jobContext({ db, env: opsEnv });
  const { reportId } = await lockSuspectedCsam(ctx.bg, file.id, { source: "photodna" });
  await ctx.settle();
  await db.update(reports).set({ createdAt: LONG_AGO }).where(eq(reports.id, reportId));
  return { owner, file, reportId };
}

// ── (0) the CSAM-alert sweep ────────────────────────────────────────────────────────────────

describe("(0) the CSAM-alert sweep in abuse-hourly", () => {
  it("an open csam report on a locked file, unclaimed today → one run: exactly one critical mail, the marker claimed, one scan.csam_alert_sent (via sweep) and NO new scan.suspected_csam row; a second run the same day: none; the next day: one more; a report no longer open: none", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepCsamAlerts");
      const { file, reportId } = await lockedFile(db, ops.env);
      expect(critical(ops.address, reportId)).toHaveLength(1); // the lock's own alert
      const lockRows0 = (await auditsOf(db, "scan.suspected_csam", file.id)).length;
      await ageMarker(db, csamAlertMarker(reportId)); // a new day: nobody told yet today

      await runJob(db, ops.env);
      expect(critical(ops.address, reportId)).toHaveLength(2);
      expect(await markerCount(db, csamAlertMarker(reportId))).toBe(1);
      const sent = await auditsOf(db, "scan.csam_alert_sent", file.id);
      expect(sent.filter((row) => (row.meta as { via: string }).via === "sweep")).toHaveLength(1);
      expect(await auditsOf(db, "scan.suspected_csam", file.id)).toHaveLength(lockRows0);

      await runJob(db, ops.env);
      expect(critical(ops.address, reportId)).toHaveLength(2);

      await ageMarker(db, csamAlertMarker(reportId));
      await runJob(db, ops.env);
      expect(critical(ops.address, reportId)).toHaveLength(3);

      await db.update(reports).set({ status: "reviewing" }).where(eq(reports.id, reportId));
      await ageMarker(db, csamAlertMarker(reportId));
      await runJob(db, ops.env);
      expect(critical(ops.address, reportId)).toHaveLength(3);
    });
  });

  it("an empty operator list: no mail, the error metric, the marker unclaimed — and the next run (operators back) tells them", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepCsamAlerts");
      const { reportId } = await lockedFile(db, ops.env);
      await ageMarker(db, csamAlertMarker(reportId));
      const points: { blobs: string[] }[] = [];
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runJob(db, {
          ADMIN_EMAILS: "",
          E2E_ADMIN_EMAILS: "",
          METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) },
        });
      } finally {
        logged.mockRestore();
      }
      expect(points.filter((p) => p.blobs[0] === "error").map((p) => p.blobs.slice(2, 4))).toContainEqual([
        "csam_alert",
        "no_recipient",
      ]);
      expect(await markerCount(db, csamAlertMarker(reportId))).toBe(0);
      expect(critical(ops.address, reportId)).toHaveLength(1);
      await runJob(db, ops.env);
      expect(critical(ops.address, reportId)).toHaveLength(2);
      expect(await markerCount(db, csamAlertMarker(reportId))).toBe(1);
    });
  });

  it("a run in which every operator mail comes back `retrying` claims no marker; the next run tries again", async () => {
    const { testOutbound } = await import("../../../src/worker/auth/test-outbound");
    const { CRITICAL_RETRY_WAITS_MS } = await import("../../../src/worker/services/email");
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepCsamAlerts");
      const { reportId } = await lockedFile(db, ops.env);
      await ageMarker(db, csamAlertMarker(reportId));
      const outbound = testOutbound()!;
      outbound.answer("api.resend.com", () =>
        Response.json({ name: "internal_server_error", message: "down", statusCode: 500 }, { status: 500 }),
      );
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const ctx = jobContext({
          db,
          // A made-up key: the stand-in above answers, nothing leaves the test.
          env: { ...ops.env, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_test_key" },
        });
        await job.run(ctx.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
        // The mail's retries wait on their timers: run them out, then drain what was deferred.
        await vi.advanceTimersByTimeAsync(CRITICAL_RETRY_WAITS_MS[0] + CRITICAL_RETRY_WAITS_MS[1] + 100);
        vi.useRealTimers();
        await ctx.settle();
      } finally {
        vi.useRealTimers();
        outbound.answer("api.resend.com", null);
      }
      expect(await markerCount(db, csamAlertMarker(reportId))).toBe(0);
      await runJob(db, ops.env);
      expect(await markerCount(db, csamAlertMarker(reportId))).toBe(1);
      expect(critical(ops.address, reportId).length).toBeGreaterThanOrEqual(2);
    });
  });

  it("a csam-category report filed through POST /api/reports: the routine alert once, the node under_review — and two runs send NO csam_lock mail and write no scan.suspected_csam row for it; control: a locked file's open report in the same runs IS alerted", async () => {
    const ops = operators();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const sharee = await member();
    await makeShare(folder.id, owner.id, sharee.id, { role: "viewer" });
    expect(
      (await sessionReport(sharee, { nodeId: file.id, category: "csam" }, { env: ops.env })).status,
    ).toBe(202);
    const [userReport] = await testDb().select().from(reports).where(eq(reports.nodeId, file.id));
    expect(mailTo(ops.address).filter((m) => String(m.text).includes(userReport!.id))).toHaveLength(1);
    expect((await testDb().select().from(nodes).where(eq(nodes.id, file.id)))[0]!.scanStatus).toBe(
      "under_review",
    );

    await rolledBack(async (db) => {
      only("sweepCsamAlerts");
      await db
        .update(reports)
        .set({ createdAt: new Date(LONG_AGO.getTime() - DAY) })
        .where(eq(reports.id, userReport!.id));
      const control = await lockedFile(db, ops.env);
      await ageMarker(db, csamAlertMarker(control.reportId));
      await runJob(db, ops.env);
      await runJob(db, ops.env);
      expect(critical(ops.address, userReport!.id)).toEqual([]);
      expect(await auditsOf(db, "scan.suspected_csam", file.id)).toEqual([]);
      expect(critical(ops.address, control.reportId)).toHaveLength(2);
    });
    // Still under review, never locked by any of it.
    expect((await testDb().select().from(nodes).where(eq(nodes.id, file.id)))[0]!.scanStatus).toBe(
      "under_review",
    );
  });
});

// ── (0b) the unrecorded-lock sweep ─────────────────────────────────────────────────────────

/** A file as the upload route writes it locked, whose handler never ran: locked, held, no case. */
async function writtenLocked(db: Db) {
  const owner = await member();
  const sha256 = rand(32);
  const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256 });
  const link = await makeLink(file.id, owner.id);
  await db
    .update(nodes)
    .set({ scanStatus: "suspected_csam", legalHold: true, createdAt: LONG_AGO })
    .where(eq(nodes.id, file.id));
  return { owner, file, link };
}

describe("(0b) the unrecorded-lock sweep in abuse-hourly", () => {
  it("one run completes an unrecorded lock: report filed, owner held, links paused, one scan.suspected_csam row (recoveredBy: sweep), one csam_lock mail; a second run changes nothing", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepUnrecordedCsamLocks");
      const made = await writtenLocked(db);
      await runJob(db, ops.env);
      const [report] = await db.select().from(reports).where(eq(reports.nodeId, made.file.id));
      expect(report).toMatchObject({ category: "csam", status: "open", ownerId: made.owner.id });
      const [ownerRow] = await db.select().from(userTable).where(eq(userTable.id, made.owner.id));
      expect(ownerRow).toMatchObject({ legalHold: true });
      const [linkRow] = await db.select().from(shareLinks).where(eq(shareLinks.id, made.link.id));
      expect(linkRow!.pauseReasons).toEqual(["moderation"]);
      expect(await auditsOf(db, "scan.suspected_csam", made.file.id)).toMatchObject([
        { meta: { recoveredBy: "sweep", reportId: report!.id } },
      ]);
      expect(critical(ops.address, report!.id)).toHaveLength(1);

      await runJob(db, ops.env);
      expect(await db.select().from(reports).where(eq(reports.nodeId, made.file.id))).toHaveLength(1);
      expect(await auditsOf(db, "scan.suspected_csam", made.file.id)).toHaveLength(1);
      expect(critical(ops.address, report!.id)).toHaveLength(1);
    });
  });

  it("a file cleared between the listing and the lock is skipped and not re-locked", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepUnrecordedCsamLocks");
      const made = await writtenLocked(db);
      // The clear lands right before the lock's own transaction.
      let cleared = false;
      const racing = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return async (...args: unknown[]) => {
              if (!cleared) {
                cleared = true;
                await target
                  .update(nodes)
                  .set({ scanStatus: "clean", legalHold: false })
                  .where(eq(nodes.id, made.file.id));
              }
              return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      await runJob(racing as Db, ops.env);
      expect(await db.select().from(reports).where(eq(reports.nodeId, made.file.id))).toEqual([]);
      expect((await db.select().from(nodes).where(eq(nodes.id, made.file.id)))[0]).toMatchObject({
        scanStatus: "clean",
      });
    });
  });
});

// ── (a) the strike sweep ────────────────────────────────────────────────────────────────────

/** `n` unlifted strikes `daysAgo` days old (inside the 365-day window), `lifted` of them lifted. */
async function strikesFor(
  db: Db,
  userId: string,
  n: number,
  opts: { daysAgo?: number; lifted?: number } = {},
) {
  const at = new Date(Date.now() - (opts.daysAgo ?? 364.5) * DAY);
  for (let i = 0; i < n; i++) {
    await db.insert(strikes).values({
      userId,
      kind: "abuse",
      nodeId: uuidv7(),
      at,
      liftedAt: i < (opts.lifted ?? 0) ? new Date() : null,
    });
  }
}

/** `strikesFor` for many users in ONE statement. */
async function strikesForMany(db: Db, userIds: string[], n: number, opts: { daysAgo?: number } = {}) {
  const at = new Date(Date.now() - (opts.daysAgo ?? 364.5) * DAY);
  await db
    .insert(strikes)
    .values(
      userIds.flatMap((userId) =>
        Array.from({ length: n }, () => ({
          userId,
          kind: "abuse" as const,
          nodeId: uuidv7(),
          at,
          liftedAt: null,
        })),
      ),
    );
}

async function withSession(db: Db, userId: string) {
  await db.insert(authSession).values({
    id: rand(16),
    token: `made-up-${rand(16)}`,
    userId,
    expiresAt: new Date(Date.now() + DAY),
    updatedAt: new Date(),
  });
}

describe("(a) the strike sweep in abuse-hourly", () => {
  it("three unlifted strikes in the window, not suspended → suspended by one run (sessions gone, links paused owner_suspended, one suspension mail, listed in the digest by id); idempotent; two strikes, three with one lifted, and an already suspended user are untouched", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepStrikeThresholds");
      const target = await member();
      await strikesFor(db, target.id, 3);
      await withSession(db, target.id);
      const file = await makeFile(target.id, null, { scanStatus: "clean" });
      const link = await makeLink(file.id, target.id);
      const two = await member();
      await strikesFor(db, two.id, 2);
      const liftedOne = await member();
      await strikesFor(db, liftedOne.id, 3, { lifted: 1 });
      const already = await member({ suspendedAt: new Date(), suspendedReason: "admin" });
      await strikesFor(db, already.id, 3);

      await runJob(db, ops.env);
      const rowOf = async (id: string) => (await db.select().from(userTable).where(eq(userTable.id, id)))[0]!;
      expect((await rowOf(target.id)).suspendedAt).toBeInstanceOf(Date);
      expect(await db.select().from(authSession).where(eq(authSession.userId, target.id))).toEqual([]);
      expect((await db.select().from(shareLinks).where(eq(shareLinks.id, link.id)))[0]!.pauseReasons).toEqual(
        ["owner_suspended"],
      );
      const suspendedMails = () => mailTo(target.email).filter((m) => /suspend/i.test(m.subject));
      expect(suspendedMails()).toHaveLength(1);
      expect(JSON.stringify(digests(ops.address))).toContain(target.id);
      for (const untouched of [two, liftedOne]) expect((await rowOf(untouched.id)).suspendedAt).toBeNull();
      expect((await rowOf(already.id)).suspendedReason).toBe("admin");

      await runJob(db, ops.env);
      expect(suspendedMails()).toHaveLength(1);
    });
  });

  it("decided again at the act (standing check a): a user suspended by someone else between the listing and the sweep's suspension is not suspended again, mailed again or counted", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepStrikeThresholds");
      const target = await member();
      await strikesFor(db, target.id, 3, { daysAgo: 364.95 });
      // Right before the sweep's suspension transaction: an admin suspends the account.
      let raced = false;
      const racing = new Proxy(db, {
        get(target_, property, receiver) {
          if (property === "transaction") {
            return async (...args: unknown[]) => {
              if (!raced) {
                raced = true;
                await target_
                  .update(userTable)
                  .set({ suspendedAt: new Date(), suspendedReason: "admin" })
                  .where(eq(userTable.id, target.id));
              }
              return (target_.transaction as (...a: unknown[]) => unknown).apply(target_, args);
            };
          }
          const value: unknown = Reflect.get(target_, property, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target_) : value;
        },
      });
      await runJob(racing as Db, ops.env);
      expect(raced).toBe(true);
      const [row] = await db.select().from(userTable).where(eq(userTable.id, target.id));
      expect(row!.suspendedReason).toBe("admin");
      expect(mailTo(target.email).filter((m) => /suspend/i.test(m.subject))).toEqual([]);
      // Not suspended by the sweep a second time: no `account.suspended` row of its own. (Its count
      // is not asserted: in a whole run other files leave users at the threshold that it suspends.)
      expect(await auditsOf(db, "account.suspended", target.id)).toEqual([]);
    });
  });

  it("no starvation through the job: more users whose suspension FAILS than the job's limit, then one ordinary user → suspended in one run", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepStrikeThresholds");
      const failing = 201; // > the job's limit of 200
      const stuck: string[] = [];
      // The 201 users and their strikes are two statements, not 804 round trips: a database busy with
      // other suites made the serial version run past the test's 5 s budget while it only built fixtures.
      const stuckUsers = Array.from({ length: failing }, () => {
        const id = baId();
        return {
          id,
          name: `Test ${id.slice(0, 6)}`,
          email: `${id.toLowerCase()}@services-core.example.test`,
          emailVerified: true,
          termsVersion: TERMS,
          termsAcceptedAt: new Date(),
        };
      });
      await db.insert(userTable).values(stuckUsers);
      stuck.push(...stuckUsers.map((u) => u.id));
      await strikesForMany(db, stuck, 3, { daysAgo: 364.9 });
      const ordinary = await member();
      await strikesFor(db, ordinary.id, 3, { daysAgo: 364.8 });
      // Every suspension of one of the `stuck` users fails (its transaction is refused).
      const refusing = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return async (...args: unknown[]) => {
              const run = args[0] as (tx: Db) => Promise<unknown>;
              return (target.transaction as (...a: unknown[]) => Promise<unknown>).call(
                target,
                async (tx: Db) => {
                  const result = await run(tx);
                  const [still] = await tx
                    .select({ id: userTable.id })
                    .from(userTable)
                    .where(and(inArray(userTable.id, stuck), sql`${userTable.suspendedAt} IS NOT NULL`))
                    .limit(1);
                  if (still) throw new Error("test: this account cannot be suspended");
                  return result;
                },
                ...args.slice(1),
              );
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      // What the sweep itself reported: the stuck users were really looked at (and failed) first.
      const real = original.sweepStrikeThresholds;
      let swept: Awaited<ReturnType<typeof real>> | null = null;
      parts.sweepStrikeThresholds = async (...args: Parameters<typeof real>) => (swept = await real(...args));
      await runJob(refusing as Db, ops.env);
      const [row] = await db.select().from(userTable).where(eq(userTable.id, ordinary.id));
      expect(row!.suspendedAt).toBeInstanceOf(Date);
      expect(swept!.failed).toBeGreaterThanOrEqual(failing);
      expect(swept!.suspended).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── (b) anomaly reporting ───────────────────────────────────────────────────────────────────

const EGRESS_CAP = 1_000_000_000_000_000; // made up: far above anything another test serves
const settingsFor: Settings = {
  signupMode: "invite",
  termsVersion: "2026-10",
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: { CEIL_OWNER_LINK_BYTES_DAY: EGRESS_CAP, NEW_ACCOUNT_DAYS: 7, NEW_ACCOUNT_FACTOR: 0.5 },
};

async function egress(db: Db, ownerId: string, bytes: number) {
  await db.insert(downloadLedger).values({
    day: utcDay(new Date()),
    subjectType: "link_owner",
    subjectId: ownerId,
    bytes,
    count: 1,
  });
}

const systemReportsOf = (db: Db, ownerId: string) =>
  db
    .select()
    .from(reports)
    .where(and(eq(reports.ownerId, ownerId), eq(reports.source, "system")));

describe("(b) anomaly reporting in abuse-hourly — reports, never pauses", () => {
  it("an owner at 50% of the effective cap → one system report (no node) and one digest line, no pause, no suspension; at 49% → nothing; a second run the same day → nothing more; the next day, still ≥ 50% → one new row; a young owner is measured against the factored cap", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("reportAnomalies");
      const at50 = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      const at49 = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      const young50 = await member({ createdAt: new Date() }); // cap × 0.5
      const young49 = await member({ createdAt: new Date() });
      await egress(db, at50.id, EGRESS_CAP / 2);
      await egress(db, at49.id, EGRESS_CAP / 2 - 1);
      await egress(db, young50.id, EGRESS_CAP / 4);
      await egress(db, young49.id, EGRESS_CAP / 4 - 1);
      const file = await makeFile(at50.id, null, { scanStatus: "clean" });
      const link = await makeLink(file.id, at50.id);

      await runJob(db, ops.env, settingsFor);
      const reported = await systemReportsOf(db, at50.id);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        nodeId: null,
        source: "system",
        category: "other",
        status: "open",
      });
      expect(await systemReportsOf(db, at49.id)).toEqual([]);
      expect(await systemReportsOf(db, young50.id)).toHaveLength(1);
      expect(await systemReportsOf(db, young49.id)).toEqual([]);
      const [mail] = digests(ops.address);
      expect(JSON.stringify(mail)).toContain(at50.id);
      expect(JSON.stringify(mail)).not.toContain(at49.id);
      expect(digests(ops.address)).toHaveLength(1);
      // Nothing paused, nobody suspended.
      expect((await db.select().from(shareLinks).where(eq(shareLinks.id, link.id)))[0]!.pauseReasons).toEqual(
        [],
      );
      expect((await db.select().from(userTable).where(eq(userTable.id, at50.id)))[0]!.suspendedAt).toBeNull();

      await runJob(db, ops.env, settingsFor);
      expect(await systemReportsOf(db, at50.id)).toHaveLength(1);
      expect(
        digests(ops.address)
          .map((m) => JSON.stringify(m))
          .filter((t) => t.includes(at50.id)),
      ).toHaveLength(1);

      await ageMarker(db, findingMarker("download_owner", at50.id));
      await runJob(db, ops.env, settingsFor);
      expect(await systemReportsOf(db, at50.id)).toHaveLength(2);
    });
  });

  it("review m7: a subject already reported today does not take a place in the query's LIMIT — the next one is found (owners and busy links)", async () => {
    const { ownersNearEgressCap, busyLinksLastHour } = await import("../../../src/worker/db/queries/abuse");
    await rolledBack(async (db) => {
      const day = utcDay(new Date());
      const first = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      const second = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      // Larger than anything another test serves: these two are the head of the list.
      await egress(db, first.id, 9_000_000_000_000_000);
      await egress(db, second.id, 8_000_000_000_000_000);
      expect((await ownersNearEgressCap(db, day, 1, 1)).map((o) => o.ownerId)).toEqual([first.id]);
      await db.insert(downloadLedger).values({
        day,
        subjectType: "notice",
        subjectId: findingMarker("download_owner", first.id),
        bytes: 0,
        count: 1,
      });
      expect((await ownersNearEgressCap(db, day, 1, 1)).map((o) => o.ownerId)).toEqual([second.id]);

      const file = await makeFile(first.id, null, { scanStatus: "clean" });
      const a = await makeLink(file.id, first.id);
      const b = await makeLink(file.id, first.id);
      for (const [link, n] of [
        [a, 5000],
        [b, 4000],
      ] as const) {
        await db.insert(linkAccessLog).values(
          Array.from({ length: n }, () => ({
            linkId: link.id,
            nodeId: file.id,
            at: new Date(),
            outcome: "ok" as const,
          })),
        );
      }
      expect((await busyLinksLastHour(db, day, 500, 50, 1)).map((l) => l.linkId)).toEqual([a.id]);
      await db.insert(downloadLedger).values({
        day,
        subjectType: "notice",
        subjectId: findingMarker("link_traffic", a.id),
        bytes: 0,
        count: 1,
      });
      expect((await busyLinksLastHour(db, day, 500, 50, 1)).map((l) => l.linkId)).toEqual([b.id]);
    });
  });

  it("notice markers are never read as an owner total: an owner with only marker rows (T13's download_owner:<id>, this job's digest:download_owner:<id>) huge in bytes is not reported", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("reportAnomalies");
      const owner = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      for (const subjectId of [`download_owner:${owner.id}`, `digest:download_owner:${owner.id}`, owner.id]) {
        await db.insert(downloadLedger).values({
          day: utcDay(new Date()),
          subjectType: "notice",
          subjectId,
          bytes: EGRESS_CAP,
          count: 0,
        });
      }
      await runJob(db, ops.env, settingsFor);
      expect(await systemReportsOf(db, owner.id)).toEqual([]);
    });
  });

  it("links with > 500 downloads or > 50 distinct addresses in the hour, accounts with > 50 links today, new accounts with > 200 uploads in the hour, links guessed from > 20 addresses: each one report row and one digest line — and nothing paused", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("reportAnomalies");
      const owner = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      const file = await makeFile(owner.id, null, { scanStatus: "clean" });
      const busy = await makeLink(file.id, owner.id);
      const spread = await makeLink(file.id, owner.id);
      const guessed = await makeLink(file.id, owner.id);
      const quietLink = await makeLink(file.id, owner.id);
      const now = new Date();
      await db.insert(linkAccessLog).values(
        Array.from({ length: ANOMALY.linkDownloadsPerHour + 1 }, () => ({
          linkId: busy.id,
          nodeId: file.id,
          at: now,
          ipHashDaily: "made-up-hash",
          outcome: "ok" as const,
        })),
      );
      await db.insert(linkAccessLog).values(
        Array.from({ length: ANOMALY.linkAddressesPerHour + 1 }, (_, i) => ({
          linkId: spread.id,
          nodeId: file.id,
          at: now,
          ipHashDaily: `made-up-${i}-${rand()}`,
          outcome: "denied_password" as const,
        })),
      );
      await db.insert(linkAccessLog).values(
        Array.from({ length: ANOMALY.linkDownloadsPerHour }, () => ({
          linkId: quietLink.id,
          nodeId: file.id,
          at: now,
          ipHashDaily: "made-up-hash",
          outcome: "ok" as const,
        })),
      );
      await db.insert(linkPasswordAttempts).values(
        Array.from({ length: ANOMALY.passwordAddressesPerHour + 1 }, (_, i) => ({
          linkId: guessed.id,
          ipHashStable: `made-up-stable-${i}-${rand()}`,
          failures: 1,
          lastFailureAt: now,
        })),
      );
      const creator = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      await db.insert(downloadLedger).values({
        day: utcDay(now),
        subjectType: "link_user",
        subjectId: creator.id,
        bytes: 0,
        count: ANOMALY.linksPerDay + 1,
      });
      const newcomer = await member({ createdAt: new Date() });
      const values = Array.from({ length: ANOMALY.newAccountUploadsPerHour + 1 }, () => {
        const nodeId = uuidv7();
        const versionId = uuidv7();
        const name = `u-${rand()}.bin`;
        return {
          ownerId: newcomer.id,
          uploaderId: newcomer.id,
          parentId: null,
          nodeId,
          versionId,
          name,
          nameKey: nameKeyOf(name),
          size: 10,
          r2Key: keyFor(newcomer.id, nodeId, versionId),
          expiresAt: new Date(Date.now() + DAY),
          status: "aborted" as const,
        };
      });
      await db.insert(uploads).values(values);

      await runJob(db, ops.env, settingsFor);
      const findings = await db
        .select()
        .from(reports)
        .where(
          and(eq(reports.source, "system"), inArray(reports.ownerId, [owner.id, creator.id, newcomer.id])),
        );
      const byLink = (id: string) => findings.filter((r) => r.linkId === id);
      expect(byLink(busy.id)).toHaveLength(1);
      expect(byLink(spread.id)).toHaveLength(1);
      expect(byLink(guessed.id)).toHaveLength(1);
      expect(byLink(quietLink.id)).toEqual([]);
      expect(findings.filter((r) => r.ownerId === creator.id)).toHaveLength(1);
      expect(findings.filter((r) => r.ownerId === newcomer.id)).toHaveLength(1);
      expect(findings.every((r) => r.nodeId === null)).toBe(true);
      const text = JSON.stringify(digests(ops.address));
      for (const id of [busy.id, spread.id, guessed.id, creator.id, newcomer.id]) expect(text).toContain(id);
      expect(text).not.toContain(quietLink.id);
      expect(digests(ops.address)).toHaveLength(1);
      const links = await db
        .select()
        .from(shareLinks)
        .where(inArray(shareLinks.id, [busy.id, spread.id, guessed.id]));
      expect(links.map((l) => l.pauseReasons)).toEqual([[], [], []]);
    });
  });
});

// ── a failing part stops nothing after it ──────────────────────────────────────────────────

describe("each part in its own try", () => {
  it("(0) and (0b) and (0c) throwing: the strike sweep still suspends and the digest is still sent; each failure counted with its reason", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const boom = async () => {
        throw new Error("test: this part fails");
      };
      parts.sweepCsamAlerts = boom;
      parts.sweepUnrecordedCsamLocks = boom;
      parts.sweepOwedNodes = boom;
      parts.reportAnomalies = async () => [];
      const target = await member();
      await strikesFor(db, target.id, 3);
      const ctx = await runJob(db, ops.env);
      expect(
        (await db.select().from(userTable).where(eq(userTable.id, target.id)))[0]!.suspendedAt,
      ).toBeInstanceOf(Date);
      expect(JSON.stringify(digests(ops.address))).toContain(target.id);
      expect(errorReasons(ctx)).toEqual(
        expect.arrayContaining(["csam_alert_sweep", "unrecorded_lock_sweep", "owed_node_sweep"]),
      );
    });
  });

  it("the strike sweep throwing does not prevent the anomaly digest; a throwing anomaly part does not undo the strike sweep before it", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      only("reportAnomalies", "sweepStrikeThresholds");
      parts.sweepStrikeThresholds = async () => {
        throw new Error("test: the strike sweep fails");
      };
      const owner = await member({ createdAt: new Date(Date.now() - 400 * DAY) });
      await egress(db, owner.id, EGRESS_CAP);
      const ctx = await runJob(db, ops.env, settingsFor);
      expect(JSON.stringify(digests(ops.address))).toContain(owner.id);
      expect(errorReasons(ctx)).toContain("strike_sweep");
    });
    Object.assign(parts, original);
    await rolledBack(async (db) => {
      const ops = operators();
      only("sweepStrikeThresholds");
      parts.reportAnomalies = async () => {
        throw new Error("test: an anomaly query fails");
      };
      const target = await member();
      await strikesFor(db, target.id, 3);
      const ctx = await runJob(db, ops.env);
      expect(
        (await db.select().from(userTable).where(eq(userTable.id, target.id)))[0]!.suspendedAt,
      ).toBeInstanceOf(Date);
      expect(errorReasons(ctx)).toContain("anomaly_report");
    });
  });

  it("keeps its registry name and cron, and is not guarded (T22-a)", () => {
    expect(job).toMatchObject({ name: "abuse-hourly", cron: "3 * * * *" });
    expect((job as { guarded?: boolean }).guarded).toBeUndefined();
  });
});
