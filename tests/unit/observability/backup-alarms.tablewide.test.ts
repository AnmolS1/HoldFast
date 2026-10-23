// The two alarms in the backup job's tail (brief R-6), on this file's own rows: the Images budget
// (the month's `transform_user` ledger units against 4,000) and the kept-bytes backstop (accounts
// past it now). Each is called with its own instant — a far-future month drawn per run, so other
// files' ledger rows and earlier runs' markers are never in it — and mails an operator address
// of its own (no other test's hourly mail count is shared with it).
//
// TABLE-WIDE (PLAN §6 rule 16): both alarms read a whole table's state — the month's ledger rows,
// every account past the backstop — and the kept alarm writes a daily marker for EVERY such
// account, other files' included. So this runs in the serial step (`HOLDFAST_TABLEWIDE=1`), and
// still asserts only on this file's own rows and mails.
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { downloadLedger, nodes } from "../../../src/worker/db/schema";
import { KEPT_MAX_QUOTAS } from "../../../src/worker/db/queries/quota";
import {
  backupMissingAlarm,
  IMAGES_ALARM_UNITS,
  imagesAlarm,
  keptBackstopAlarm,
  manifestKey,
} from "../../../src/worker/jobs/backup";
import { env } from "cloudflare:workers";
import { list as outbox } from "../../../src/worker/services/outbox";
import { jobContext } from "../trash/helpers";
import { makeFile, makeFolder, makeUser, rand, testDb } from "../services-core/helpers";

const OPERATOR = `t27-alarm-${rand()}@example.test`; // made up, reserved domain
const ctx = () => jobContext({ env: { ADMIN_EMAILS: OPERATOR } });

const owned: Array<{ from: string; to: string }> = [];
const isoDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The 15th of a far-future month (year 2200–2999) that THIS test owns: no ledger row is in it or
 * in the month after (a test writes the next month's 1st), and no other test of this run has it.
 * Drawn at random alone, a month could be one an earlier run left claimed in the shared database
 * — "claimed" where "mailed" was expected (the no_recipient test, dev gate 2026-10-22) — so the
 * months are checked, and afterAll deletes every ledger row in them.
 */
async function farMonth(): Promise<Date> {
  for (;;) {
    const year = 2200 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 800);
    const month = crypto.getRandomValues(new Uint8Array(1))[0]! % 12;
    const from = isoDay(new Date(Date.UTC(year, month, 1)));
    const to = isoDay(new Date(Date.UTC(year, month + 2, 0)));
    if (owned.some((range) => range.from <= to && from <= range.to)) continue;
    const [taken] = await testDb()
      .select({ day: downloadLedger.day })
      .from(downloadLedger)
      .where(and(gte(downloadLedger.day, from), lte(downloadLedger.day, to)))
      .limit(1);
    if (taken) continue;
    owned.push({ from, to });
    return new Date(Date.UTC(year, month, 15, 2, 0, 0));
  }
}

const seeded: Array<{ day: string; subjectId: string }> = [];
async function transforms(day: string, count: number) {
  const subjectId = `t27-${rand(8)}`;
  seeded.push({ day, subjectId });
  await testDb()
    .insert(downloadLedger)
    .values({ day, subjectType: "transform_user", subjectId, bytes: 0, count });
}

const keptFolders: string[] = [];

afterAll(async () => {
  // This run's months, claims included: a later run never finds one of them taken.
  for (const { from, to } of owned) {
    await testDb()
      .delete(downloadLedger)
      .where(and(gte(downloadLedger.day, from), lte(downloadLedger.day, to)));
  }
  for (const row of seeded) {
    await testDb()
      .delete(downloadLedger)
      .where(and(eq(downloadLedger.day, row.day), eq(downloadLedger.subjectId, row.subjectId)));
  }
  // Out of the backstop again, so later runs' listings stay short.
  if (keptFolders.length) {
    await testDb().update(nodes).set({ purgeRequestedAt: null }).where(inArray(nodes.id, keptFolders));
  }
});

const quota = 1_000;
/** An account keeping `bytes` of deleted-for-good files (quota 1,000). `id` sets its id. */
async function keeping(bytes: number, id?: string) {
  const owner = await makeUser({ quotaBytes: quota, ...(id ? { id } : {}) });
  const folder = await makeFolder(owner.id);
  await makeFile(owner.id, folder.id, { size: bytes });
  await testDb()
    .update(nodes)
    .set({ deletedAt: sql`now()`, purgeRequestedAt: sql`now()` })
    .where(eq(nodes.id, folder.id));
  keptFolders.push(folder.id);
  return owner.id;
}

const nextDay = (at: Date) => new Date(at.getTime() + 86_400_000);
const noOperator = () => jobContext({ env: { ADMIN_EMAILS: "" } });

const mailsFor = (heading: string) =>
  outbox({ to: OPERATOR }).filter(
    (mail) => mail.template === "adminAlert" && (mail.text ?? "").includes(heading),
  );

describe("the Images budget alarm", () => {
  it("quiet below 4,000; at 4,000 one mail per UTC day — a second pass that day mails nothing", async () => {
    const at = await farMonth();
    const day = at.toISOString().slice(0, 10);
    const firstOfMonth = `${day.slice(0, 8)}01`;
    const { bg, metric } = ctx();
    await transforms(firstOfMonth, IMAGES_ALARM_UNITS - 1000);
    await transforms(day, 999);
    expect(await imagesAlarm(bg, at)).toBe("quiet");
    // The next month's units do not count for this one.
    const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    await transforms(next.toISOString().slice(0, 10), 5_000);
    expect(await imagesAlarm(bg, at)).toBe("quiet");
    await transforms(day, 1);
    const before = mailsFor("image-transform budget").length;
    expect(await imagesAlarm(bg, at)).toBe("mailed");
    const mails = mailsFor("image-transform budget");
    expect(mails.length).toBe(before + 1);
    expect(mails[mails.length - 1]!.text ?? "").toContain(day);
    expect(metric).toHaveBeenCalledWith(
      "job",
      { kind: "backup", outcome: "images_budget" },
      IMAGES_ALARM_UNITS,
    );
    // The same day again (an on-demand pass): claimed, no second mail.
    expect(await imagesAlarm(bg, at)).toBe("claimed");
    expect(mailsFor("image-transform budget").length).toBe(before + 1);
  });
});

describe("the kept-bytes backstop alarm", () => {
  it("names an account past the backstop once per UTC day; not one exactly at it", async () => {
    const past = await keeping(KEPT_MAX_QUOTAS * quota + 1);
    const at = await keeping(KEPT_MAX_QUOTAS * quota);
    const when = await farMonth();
    const { bg } = ctx();
    const mailed = await keptBackstopAlarm(bg, when, 1000);
    expect(mailed).toContain(past);
    expect(mailed).not.toContain(at);
    const mails = mailsFor("deleted files that are still kept");
    expect(mails.some((mail) => (mail.text ?? "").includes(past))).toBe(true);
    expect(mails.some((mail) => (mail.text ?? "").includes(at))).toBe(false);
    const count = mails.length;
    // Again the same day: nothing more about it.
    expect(await keptBackstopAlarm(bg, when, 1000)).not.toContain(past);
    expect(mailsFor("deleted files that are still kept").length).toBe(count);
  });
});

describe("an alarm with nobody to tell does not spend its day (review minor 1)", () => {
  it("Images: no operator address → no_recipient, counted; the claim is still there for the next pass", async () => {
    const at = await farMonth();
    const day = at.toISOString().slice(0, 10);
    await transforms(day, IMAGES_ALARM_UNITS);
    const silent = noOperator();
    expect(await imagesAlarm(silent.bg, at)).toBe("no_recipient");
    expect(silent.metric).toHaveBeenCalledWith("error", { kind: "admin_alert", reason: "no_recipient" });
    expect(await imagesAlarm(ctx().bg, at)).toBe("mailed");
  });

  it("kept bytes: no operator address → nobody named, nothing claimed", async () => {
    const owner = await keeping(KEPT_MAX_QUOTAS * quota + 1);
    const when = await farMonth();
    expect(await keptBackstopAlarm(noOperator().bg, when, 1000)).toEqual([]);
    expect(await keptBackstopAlarm(ctx().bg, when, 1000)).toContain(owner);
  });
});

describe("the kept-bytes alarm takes turns (review minor 2)", () => {
  it("at 1 a day, the account never named goes before the first by id", async () => {
    const day1 = await farMonth();
    await keeping(KEPT_MAX_QUOTAS * quota + 1);
    // Every account past the backstop is named on day 1.
    await keptBackstopAlarm(ctx().bg, day1, 1000);
    // A newcomer whose id sorts LAST: by id alone it would wait behind all the others.
    const late = await keeping(KEPT_MAX_QUOTAS * quota + 1, `zzzz${rand(14)}`);
    expect(await keptBackstopAlarm(ctx().bg, nextDay(day1), 1)).toEqual([late]);
  });
});

describe("no complete backup for yesterday (Addendum 3, M3)", () => {
  const criticals = () =>
    outbox({ to: OPERATOR }).filter(
      (mail) => mail.template === "operatorCritical" && (mail.text ?? "").includes("backup did not complete"),
    );

  it("yesterday's manifest missing → one critical mail per UTC day; present → quiet", async () => {
    const at = await farMonth();
    const before = criticals().length;
    expect(await backupMissingAlarm(ctx().bg, at)).toBe("mailed");
    expect(criticals().length).toBe(before + 1);
    expect(await backupMissingAlarm(ctx().bg, at)).toBe("claimed");
    expect(criticals().length).toBe(before + 1);
    // Another day whose yesterday HAS a manifest: quiet, nothing sent.
    const present = await farMonth();
    await env.FILES.put(
      manifestKey(new Date(present.getTime() - 86_400_000).toISOString().slice(0, 10)),
      "{}",
    );
    expect(await backupMissingAlarm(ctx().bg, present)).toBe("quiet");
  });

  it("no operator address → no_recipient, counted, the day not spent", async () => {
    const at = await farMonth();
    const silent = noOperator();
    expect(await backupMissingAlarm(silent.bg, at)).toBe("no_recipient");
    expect(silent.metric).toHaveBeenCalledWith("error", { kind: "admin_alert", reason: "no_recipient" });
    expect(await backupMissingAlarm(ctx().bg, at)).toBe("mailed");
  });
});
