// The two IP-derived fields that had no retention period (GBPREP findings 1 and 2), run through
// the real retention job. TABLE-WIDE: the job acts on every `session` and `reports` row.
//
//   session.ip_address / user_agent  deleted with the row once the session expired more than a day ago
//   reports.reporter_ip_hash_stable  set NULL 90 days after the report was resolved
//
// Both are kept for whatever a hold keeps: a held user's session rows, and a report on a node the
// purge gate protects. Each case has an un-held twin that IS changed in the same run (the control).
//
// And `rate_limit` (R1 legal-1): Better Auth's per-address limiter writes no raw address (the key
// carries a keyed hash, auth/rate-limit-store.ts), and every row goes two days after its last use —
// longer than the longest window of any key family in the table (the 24 h export day).
import { env } from "cloudflare:workers";
import { eq, like, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { session } from "../../../src/worker/db/auth-schema";
import { setNodeLegalHold, setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import {
  REPORTER_HASH_RETENTION_DAYS,
  SESSION_EXPIRED_GRACE_DAYS,
} from "../../../src/worker/db/queries/trash-jobs";
import { authLimitClientPrefix } from "../../../src/worker/auth/rate-limit-store";
import { rateLimit, reports } from "../../../src/worker/db/schema";
import { job as retentionJob, RATE_LIMIT_RETENTION_MS, RETENTION_STEPS } from "../../../src/worker/jobs/retention";
import { createKeys } from "../../../src/worker/services/keys";
import { newClient, signIn } from "../auth/helpers";
import { cronEvent, generationInStep, jobContext, makeFile, member, rand, setNode, testDb } from "./helpers";

beforeAll(generationInStep);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const db = () => testDb();

async function run() {
  const ctx = jobContext();
  const result = await retentionJob.run(ctx.bg, env, cronEvent(retentionJob.cron), {
    softDeadlineMs: 120_000,
  });
  return { ctx, result };
}

async function sessionFor(userId: string, expiresAt: Date) {
  const id = `sess${rand(14)}`;
  await db()
    .insert(session)
    .values({
      id,
      // Made-up values: nothing here is a real token or address (192.0.2.0/24 is documentation space).
      token: `made-up-token-${rand(8)}`,
      userId,
      expiresAt,
      updatedAt: new Date(),
      ipAddress: "192.0.2.77",
      userAgent: "made-up-agent",
    });
  return id;
}
const sessionRow = async (id: string) =>
  (await db().select().from(session).where(eq(session.id, id)))[0] ?? null;

async function reportRow(values: Partial<typeof reports.$inferInsert>) {
  const [row] = await db()
    .insert(reports)
    .values({
      source: "user",
      category: "other",
      // A made-up hash, never a real keyed address hash.
      reporterIpHashStable: `made-up-hash-${rand(10)}`,
      reporterEmail: `reporter-${rand(6)}@example.test`,
      details: "made-up details",
      ...values,
    })
    .returning();
  return row!;
}
const reportById = async (id: string) => (await db().select().from(reports).where(eq(reports.id, id)))[0]!;

describe("session rows past their life", () => {
  it("are deleted a day after they expired, never earlier, never a live one, never a held user's", async () => {
    const user = await member();
    const held = await member({ legalHold: true });
    const old = await sessionFor(user.id, ago(DAY + HOUR));
    const justExpired = await sessionFor(user.id, ago(DAY - HOUR));
    const live = await sessionFor(user.id, new Date(Date.now() + DAY));
    const heldOld = await sessionFor(held.id, ago(30 * DAY));

    const { ctx, result } = await run();

    expect(result).toEqual({ done: true });
    expect(ctx.outcomes("retention")).not.toContain("error");
    // The control: the job ran and removed the session past the grace.
    expect(await sessionRow(old)).toBeNull();
    expect(await sessionRow(justExpired)).not.toBeNull();
    // A live session keeps its address: the account's sessions list and rate limiting read it.
    expect(await sessionRow(live)).toMatchObject({ ipAddress: "192.0.2.77", userAgent: "made-up-agent" });
    expect(await sessionRow(heldOld)).not.toBeNull();

    await setUserLegalHold(db(), held.id, false);
    await run();
    expect(await sessionRow(heldOld)).toBeNull();
    expect(await sessionRow(live)).not.toBeNull();
  });

  it("the grace is one day", () => {
    expect(SESSION_EXPIRED_GRACE_DAYS).toBe(1);
  });
});

describe("reports.reporter_ip_hash_stable", () => {
  it("is nulled 90 days after the report was resolved — and nothing else about the row changes", async () => {
    expect(REPORTER_HASH_RETENTION_DAYS).toBe(90);
    const resolvedAt = ago(91 * DAY);
    const due = await reportRow({
      status: "actioned",
      resolution: "removed",
      resolvedAt,
      createdAt: ago(120 * DAY),
    });
    const dismissed = await reportRow({ status: "dismissed", resolution: "no", resolvedAt });
    const recent = await reportRow({ status: "actioned", resolvedAt: ago(89 * DAY) });
    // Created long ago, never resolved: kept until resolved + 90 days.
    const open = await reportRow({ status: "open", createdAt: ago(400 * DAY) });
    const reviewing = await reportRow({ status: "reviewing", createdAt: ago(400 * DAY) });
    // A closed status with no resolved time cannot be dated: kept, never nulled early.
    // Resolved once, then reopened: the stale time does not count while it is open again.
    const reopened = await reportRow({ status: "open", resolvedAt, createdAt: ago(400 * DAY) });
    const undated = await reportRow({ status: "dismissed", createdAt: ago(400 * DAY) });
    const before = await reportById(due.id);

    const { ctx, result } = await run();

    expect(result).toEqual({ done: true });
    expect(ctx.outcomes("retention")).not.toContain("error");
    expect(await reportById(due.id)).toEqual({ ...before, reporterIpHashStable: null });
    expect((await reportById(dismissed.id)).reporterIpHashStable).toBeNull();
    for (const kept of [recent, open, reviewing, reopened, undated]) {
      expect((await reportById(kept.id)).reporterIpHashStable, kept.status).toBe(kept.reporterIpHashStable);
    }
  });

  it("is kept on a report about a node the purge gate protects, and nulled for its un-held twin", async () => {
    const owner = await member();
    const heldFile = await makeFile(owner.id, null, { scanStatus: "clean" });
    const csamFile = await makeFile(owner.id, null, { scanStatus: "suspected_csam" });
    const freeFile = await makeFile(owner.id, null, { scanStatus: "clean" });
    await setNodeLegalHold(db(), heldFile.id, true);
    const resolvedAt = ago(200 * DAY);
    const onHeld = await reportRow({ nodeId: heldFile.id, status: "actioned", resolvedAt });
    const onCsam = await reportRow({
      nodeId: csamFile.id,
      category: "csam",
      status: "dismissed",
      resolvedAt,
    });
    const onFree = await reportRow({ nodeId: freeFile.id, status: "actioned", resolvedAt });

    await run();

    expect((await reportById(onHeld.id)).reporterIpHashStable).toBe(onHeld.reporterIpHashStable);
    expect((await reportById(onCsam.id)).reporterIpHashStable).toBe(onCsam.reporterIpHashStable);
    expect((await reportById(onFree.id)).reporterIpHashStable).toBeNull();

    await setNodeLegalHold(db(), heldFile.id, false);
    await setNode(csamFile.id, { scanStatus: "clean" });
    await run();
    expect((await reportById(onHeld.id)).reporterIpHashStable).toBeNull();
    expect((await reportById(onCsam.id)).reporterIpHashStable).toBeNull();
  });
});

describe("rate_limit", () => {
  const rowsLike = (pattern: string) => db().select().from(rateLimit).where(like(rateLimit.key, pattern));

  it("a request Better Auth's limiter counts leaves no raw client address in the table — its row is keyed by a hash", async () => {
    const client = newClient();
    // An address with no account: the limiter counts the attempt before anything is looked up.
    const tried = await signIn(client, `nobody-${rand(8)}@example.test`, "made-up password 1!");
    expect(tried.status).toBe(401);

    expect(await rowsLike(`%${client.ip}%`)).toEqual([]);
    // The control: the attempt WAS counted — under the hashed key.
    const prefix = await authLimitClientPrefix(createKeys(env.FILES_TOKEN_SECRET), client.ip);
    expect(await rowsLike(`${prefix}%`)).toEqual([
      expect.objectContaining({ key: `${prefix}/sign-in/email`, count: 1 }),
    ]);
  });

  it("rows go two days after their last use, never earlier — a 23-hour-old export day stays", async () => {
    expect(RATE_LIMIT_RETENTION_MS).toBe(2 * DAY);
    const tag = rand(10);
    const at = (ms: number) => Date.now() - ms;
    const keys = {
      // Made-up keys of each family the table holds; none is a real address or account.
      old: `rl:made-up-${tag}|/sign-in/email`,
      oldDay: `account-export-day:made-up-${tag}`,
      day: `account-export-day:made-up-other-${tag}`,
      // (not `signin:` — the throttle's own test reads every row of that family)
      recent: `2fa:made-up-${tag}:new`,
    };
    for (const [key, lastRequest] of [
      [keys.old, at(2 * DAY + HOUR)],
      [keys.oldDay, at(3 * DAY)],
      [keys.day, at(23 * HOUR)],
      [keys.recent, at(2 * DAY - HOUR)],
    ] as const) {
      await db().execute(
        sql`INSERT INTO rate_limit (id, key, count, last_request) VALUES (gen_random_uuid()::text, ${key}, 3, ${lastRequest})`,
      );
    }

    const { ctx, result } = await run();

    expect(result).toEqual({ done: true });
    expect(ctx.outcomes("retention")).not.toContain("error");
    expect(await rowsLike(keys.old)).toEqual([]);
    expect(await rowsLike(keys.oldDay)).toEqual([]);
    expect(await rowsLike(keys.day)).toEqual([expect.objectContaining({ count: 3 })]);
    expect(await rowsLike(keys.recent)).toEqual([expect.objectContaining({ count: 3 })]);
    await db().execute(sql`DELETE FROM rate_limit WHERE key IN (${keys.day}, ${keys.recent})`);
  });
});

describe("the job", () => {
  it("lists the tables as steps", () => {
    const tables = RETENTION_STEPS.map((step) => step.table);
    expect(tables).toContain("session");
    expect(tables).toContain("reports");
    expect(tables).toContain("rate_limit");
  });
});
