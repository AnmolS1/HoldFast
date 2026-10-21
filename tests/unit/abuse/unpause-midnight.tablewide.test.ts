// The midnight job (T22 step 6). TABLE-WIDE: it lifts `anomaly` from every link in the database,
// so this file runs alone (serial step); it asserts on its own rows only.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { utcDay } from "../../../src/worker/db/queries/ledger";
import { downloadLedger, shareLinks, type PauseReason } from "../../../src/worker/db/schema";
import { availableAgainMarker, job } from "../../../src/worker/jobs/unpause-midnight";
import { mailTo, makeLink } from "../auth/helpers";
import { cronEvent, jobContext, makeFile, member, testDb } from "../trash/helpers";

async function run() {
  const ctx = jobContext();
  await job.run(ctx.bg, env, cronEvent(job.cron));
  await ctx.settle();
  return ctx;
}

async function reasonsOf(linkId: string) {
  const [row] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, linkId));
  return { reasons: [...row!.pauseReasons].sort(), pausedAt: row!.pausedAt };
}

async function linkWith(ownerId: string, reasons: PauseReason[], lockedByAdmin = false) {
  const file = await makeFile(ownerId, null, { scanStatus: "clean" });
  const link = await makeLink(file.id, ownerId, reasons);
  if (lockedByAdmin)
    await testDb().update(shareLinks).set({ lockedByAdmin: true }).where(eq(shareLinks.id, link.id));
  return { file, link };
}

const availableMails = (address: string) => mailTo(address).filter((m) => /available again/i.test(m.subject));

describe("unpause-midnight", () => {
  it("keeps its registry name and cron", () => {
    expect(job).toMatchObject({ name: "unpause-midnight", cron: "5 0 * * *" });
    expect((job as { guarded?: boolean }).guarded).toBeUndefined();
  });

  it("lifts `anomaly` and only that: {anomaly} → live; {anomaly, report} → {report}; report, moderation, owner_deletion, owner and a stored ceiling stay; an admin-locked link keeps its anomaly", async () => {
    const owner = await member();
    const anomaly = await linkWith(owner.id, ["anomaly"]);
    const both = await linkWith(owner.id, ["anomaly", "report"]);
    const report = await linkWith(owner.id, ["report"]);
    const moderation = await linkWith(owner.id, ["moderation"]);
    const deletion = await linkWith(owner.id, ["owner_deletion"]);
    const own = await linkWith(owner.id, ["owner"]);
    const ceiling = await linkWith(owner.id, ["ceiling"]);
    const locked = await linkWith(owner.id, ["anomaly"], true);

    const ctx = await run();

    expect(await reasonsOf(anomaly.link.id)).toEqual({ reasons: [], pausedAt: null });
    expect((await reasonsOf(both.link.id)).reasons).toEqual(["report"]);
    expect((await reasonsOf(both.link.id)).pausedAt).toBeInstanceOf(Date);
    expect((await reasonsOf(report.link.id)).reasons).toEqual(["report"]);
    expect((await reasonsOf(moderation.link.id)).reasons).toEqual(["moderation"]);
    expect((await reasonsOf(deletion.link.id)).reasons).toEqual(["owner_deletion"]);
    expect((await reasonsOf(own.link.id)).reasons).toEqual(["owner"]);
    expect((await reasonsOf(ceiling.link.id)).reasons).toEqual(["ceiling"]);
    expect((await reasonsOf(locked.link.id)).reasons).toEqual(["anomaly"]);
    expect(ctx.outcomes("unpause-midnight")).toContain("ok");
  });

  it("one 'link available again' mail per owner whose link is live again — however many links — and none the second run that day; none for a link still paused", async () => {
    const owner = await member();
    await linkWith(owner.id, ["anomaly"]);
    await linkWith(owner.id, ["anomaly"]);
    const stillPaused = await member();
    await linkWith(stillPaused.id, ["anomaly", "report"]);

    await run();
    expect(availableMails(owner.email)).toHaveLength(1);
    expect(availableMails(stillPaused.email)).toHaveLength(0);
    // The marker of the day is claimed once.
    const [marker] = await testDb()
      .select()
      .from(downloadLedger)
      .where(
        and(
          eq(downloadLedger.day, utcDay(new Date())),
          eq(downloadLedger.subjectType, "notice"),
          eq(downloadLedger.subjectId, availableAgainMarker(owner.id)),
        ),
      );
    expect(marker).toMatchObject({ count: 1, bytes: 0 });

    // Another anomaly lifted the same day: no second mail.
    await linkWith(owner.id, ["anomaly"]);
    await run();
    expect(availableMails(owner.email)).toHaveLength(1);
  });

  it("the mail names an item and nothing about why it was paused", async () => {
    const owner = await member();
    const { file } = await linkWith(owner.id, ["anomaly"]);
    await run();
    const [mail] = availableMails(owner.email);
    // (The mailer neutralises the dot of a name: "a.bin" is written "a·bin".)
    expect(JSON.stringify(mail)).toContain(file.name.replace(/\.[^.]*$/, ""));
    expect(JSON.stringify(mail)).not.toMatch(/anomaly|traffic|report/i);
  });
});
