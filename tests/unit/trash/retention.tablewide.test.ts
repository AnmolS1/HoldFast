// The retention job. TABLE-WIDE: every delete acts on every row past its period, so this file
// runs alone; a row is put on either side of a cutoff by its own timestamp, never by the clock.
//
// The rule under test: nothing that concerns a held account or a protected node is deleted. The
// predicates are queries/holds.ts's; what is tested here is that every delete of the job applies
// them — one case per table, each beside an un-held twin that IS deleted in the same run.
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { setNodeLegalHold, setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import { expired } from "../../../src/worker/db/queries/upload-ips";
import {
  auditLog,
  downloadLedger,
  emailLedger,
  type LedgerSubject,
  linkAccessLog,
  linkPasswordAttempts,
  uploadIps,
} from "../../../src/worker/db/schema";
import { job as retentionJob, RETENTION_STEPS } from "../../../src/worker/jobs/retention";
import { makeLink } from "../auth/helpers";
import {
  cronEvent,
  jobContext,
  makeFile,
  makeFolder,
  makeUpload,
  member,
  nodeById,
  rand,
  setNode,
  testDb,
  uploadRow,
  type JobContext,
} from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
/** A UTC calendar day, `days` before today. */
const dayAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
const db = () => testDb();

async function run(ctx: JobContext = jobContext()) {
  const result = await retentionJob.run(ctx.bg, env, cronEvent(retentionJob.cron), {
    softDeadlineMs: 120_000,
  });
  return { ctx, result };
}

// ── one row of each table, and whether it is still there ───────────────────────────────────

type Planted = { table: string; what: string; left(): Promise<boolean> };

async function accessRow(linkId: string, nodeId: string | null, at: Date, what: string): Promise<Planted> {
  const [row] = await db()
    .insert(linkAccessLog)
    .values({ linkId, nodeId, at, outcome: "ok" })
    .returning({ id: linkAccessLog.id });
  return {
    table: "link_access_log",
    what,
    left: async () =>
      (await db().select().from(linkAccessLog).where(eq(linkAccessLog.id, row!.id))).length === 1,
  };
}

async function auditRow(values: Partial<typeof auditLog.$inferInsert>, what: string): Promise<Planted> {
  const [row] = await db()
    .insert(auditLog)
    .values({ actorType: "system", action: `test.retention.${rand()}`, ...values })
    .returning({ id: auditLog.id });
  return {
    table: "audit_log",
    what,
    left: async () => (await db().select().from(auditLog).where(eq(auditLog.id, row!.id))).length === 1,
  };
}

async function ledgerRow(
  subjectType: LedgerSubject,
  subjectId: string,
  day: string,
  what: string,
): Promise<Planted> {
  await db().insert(downloadLedger).values({ day, subjectType, subjectId, bytes: 1, count: 1 });
  return {
    table: "download_ledger",
    what,
    left: async () =>
      (
        await db()
          .select()
          .from(downloadLedger)
          .where(
            and(
              eq(downloadLedger.day, day),
              eq(downloadLedger.subjectType, subjectType),
              eq(downloadLedger.subjectId, subjectId),
            ),
          )
      ).length === 1,
  };
}

async function ipRow(
  values: { nodeId: string; uploaderId: string; at: Date; legalHold?: boolean },
  what: string,
): Promise<Planted & { id: string }> {
  const [row] = await db()
    .insert(uploadIps)
    .values({
      versionId: uuidv7(),
      ipEncrypted: Buffer.from("made-up-ciphertext"),
      iv: Buffer.from("made-up-iv12"),
      keyVersion: 1,
      ...values,
    })
    .returning({ id: uploadIps.id });
  return {
    id: row!.id,
    table: "upload_ips",
    what,
    left: async () => (await db().select().from(uploadIps).where(eq(uploadIps.id, row!.id))).length === 1,
  };
}

async function attemptRow(
  linkId: string,
  lastFailureAt: Date,
  what: string,
  lockedUntil: Date | null = null,
): Promise<Planted> {
  const ipHashStable = `hash-${rand(8)}`;
  await db()
    .insert(linkPasswordAttempts)
    .values({ linkId, ipHashStable, failures: 4, lastFailureAt, lockedUntil });
  return {
    table: "link_password_attempts",
    what,
    left: async () =>
      (
        await db()
          .select()
          .from(linkPasswordAttempts)
          .where(
            and(eq(linkPasswordAttempts.linkId, linkId), eq(linkPasswordAttempts.ipHashStable, ipHashStable)),
          )
      ).length === 1,
  };
}

async function mailWindow(windowStart: Date, what: string): Promise<Planted> {
  const recipientHash = `recipient-${rand(8)}`;
  await db().insert(emailLedger).values({ windowKind: "hour", windowStart, recipientHash, count: 1 });
  return {
    table: "email_ledger",
    what,
    left: async () =>
      (await db().select().from(emailLedger).where(eq(emailLedger.recipientHash, recipientHash))).length ===
      1,
  };
}

async function finishedUpload(
  ownerId: string,
  uploaderId: string,
  completedAt: Date,
  what: string,
  nodeId?: string,
): Promise<Planted> {
  const row = await makeUpload(ownerId, uploaderId, {
    status: "done",
    completedAt,
    ...(nodeId ? { nodeId } : {}),
  });
  return { table: "uploads", what, left: async () => (await uploadRow(row.id)) !== null };
}

const USER_SUBJECTS: LedgerSubject[] = [
  "user",
  "upload_user",
  "upload_editor",
  "transform_user",
  "share_user",
  "link_user",
  "link_owner",
];

/** Every record the job has a period for, about one account — all past their period. */
async function recordsOf(person: { id: string }) {
  const host = await member();
  const own = await makeFile(person.id, null, { scanStatus: "clean" });
  const link = await makeLink(own.id, person.id);
  // Uploaded by this person into someone else's folder.
  const guest = await makeFile(host.id, await makeFolder(host.id).then((f) => f.id), {
    createdBy: person.id,
  });
  const rows: Planted[] = [
    await accessRow(link.id, own.id, ago(181 * DAY), "an access row of a link they created"),
    await auditRow(
      { at: ago(181 * DAY), actorUserId: person.id, actorType: "user" },
      "an audit row they made",
    ),
    await auditRow(
      { at: ago(181 * DAY), targetType: "user", targetId: person.id },
      "an audit row about them",
    ),
    await auditRow(
      { at: ago(181 * DAY), targetType: "node", targetId: guest.id },
      "an audit row about a node they uploaded into someone else's folder",
    ),
    await ipRow(
      { nodeId: uuidv7(), uploaderId: person.id, at: ago(91 * DAY) },
      "the address of another upload of theirs",
    ),
    await ledgerRow("link", link.id, dayAgo(91), "a ledger row of a link they created"),
    await finishedUpload(person.id, person.id, ago(8 * DAY), "a finished upload session of theirs"),
    await finishedUpload(
      host.id,
      person.id,
      ago(8 * DAY),
      "a finished session they ran in someone else's folder",
    ),
    await attemptRow(link.id, ago(25 * HOUR), "a password-attempt counter on their link"),
  ];
  // A link they created on a node that is NOT theirs (and that nothing protects): only the
  // creator's hold can keep its records.
  const foreign = await makeLink((await makeFile(host.id, null, { scanStatus: "clean" })).id, person.id);
  rows.push(
    await accessRow(
      foreign.id,
      null,
      ago(181 * DAY),
      "an access row of a link they created on someone else's file",
    ),
    await ledgerRow("link", foreign.id, dayAgo(91), "a ledger row of that link"),
    await attemptRow(foreign.id, ago(25 * HOUR), "a password-attempt counter on that link"),
  );
  for (const subject of USER_SUBJECTS) {
    rows.push(await ledgerRow(subject, person.id, dayAgo(91), `a ledger row with them as ${subject}`));
  }
  return rows;
}

/** Every record the job has a period for, about one file — all past their period. */
async function recordsAbout(file: { id: string; ownerId: string }) {
  const link = await makeLink(file.id, file.ownerId);
  // A link on something else, through which this file was served.
  const elsewhere = await makeLink((await makeFolder(file.ownerId)).id, file.ownerId);
  return [
    await accessRow(link.id, null, ago(181 * DAY), "an access row of a link on it"),
    await accessRow(
      elsewhere.id,
      file.id,
      ago(181 * DAY),
      "an access row that served it through another link",
    ),
    await auditRow({ at: ago(181 * DAY), targetType: "node", targetId: file.id }, "an audit row about it"),
    await ipRow(
      { nodeId: file.id, uploaderId: file.ownerId, at: ago(91 * DAY) },
      "the address it was uploaded from",
    ),
    await ledgerRow("link", link.id, dayAgo(91), "a ledger row of a link on it"),
    await finishedUpload(file.ownerId, file.ownerId, ago(8 * DAY), "the session that uploaded it", file.id),
    await attemptRow(link.id, ago(25 * HOUR), "a password-attempt counter on a link on it"),
  ];
}

const still = async (rows: Planted[]) => {
  const out: string[] = [];
  for (const row of rows) if (await row.left()) out.push(`${row.table}: ${row.what}`);
  return out;
};
const names = (rows: Planted[]) => rows.map((row) => `${row.table}: ${row.what}`);

describe("the retention job", () => {
  it("every table: the row past its period goes, the row inside it stays", async () => {
    const someone = await member();
    const file = await makeFile(someone.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, someone.id);
    const node = uuidv7();
    const past: Planted[] = [
      await ledgerRow("user", someone.id, dayAgo(91), "91 days"),
      await accessRow(link.id, null, ago(181 * DAY), "181 days"),
      await auditRow({ at: ago(181 * DAY) }, "181 days"),
      await ipRow({ nodeId: node, uploaderId: someone.id, at: ago(91 * DAY) }, "91 days"),
      await attemptRow(link.id, ago(25 * HOUR), "idle for 25 hours"),
      await mailWindow(ago(49 * HOUR), "49 hours"),
      await finishedUpload(someone.id, someone.id, ago(8 * DAY), "finished 8 days ago"),
      // Rows that cannot be tied to an account go with their age, whoever is held.
      await ledgerRow("ip", `iphash-${rand(8)}`, dayAgo(91), "an IP-keyed row, 91 days"),
      await ledgerRow("signup_ip", `iphash-${rand(8)}`, dayAgo(91), "a sign-up counter, 91 days"),
      await ledgerRow("notice", `csam_alert:${rand(8)}`, dayAgo(91), "a once-a-day marker, 91 days"),
      // A target that is not an id at all must not stop the delete (a bare ::uuid cast would).
      await auditRow(
        { at: ago(181 * DAY), targetType: "node", targetId: "not-a-uuid" },
        "a malformed node target",
      ),
      await auditRow({ at: ago(181 * DAY), targetType: "node", targetId: uuidv7() }, "a node that is gone"),
    ];
    const inside: Planted[] = [
      await ledgerRow("user", someone.id, dayAgo(89), "89 days"),
      await accessRow(link.id, null, ago(179 * DAY), "179 days"),
      await auditRow({ at: ago(179 * DAY) }, "179 days"),
      await ipRow({ nodeId: node, uploaderId: someone.id, at: ago(89 * DAY) }, "89 days"),
      await attemptRow(link.id, ago(23 * HOUR), "idle for 23 hours"),
      await mailWindow(ago(47 * HOUR), "47 hours"),
      await finishedUpload(someone.id, someone.id, ago(6 * DAY), "finished 6 days ago"),
      // Past their age, and kept by their own flag or state.
      await auditRow({ at: ago(400 * DAY), meta: { legalHold: true } }, "marked meta.legalHold"),
      await ipRow(
        { nodeId: node, uploaderId: someone.id, at: ago(400 * DAY), legalHold: true },
        "its own legalHold flag",
      ),
      await attemptRow(link.id, ago(25 * HOUR), "still locking", new Date(Date.now() + HOUR)),
    ];
    const open = await makeUpload(someone.id, someone.id, { createdAt: ago(30 * DAY) });

    const { ctx, result } = await run();
    expect(result).toEqual({ done: true });
    expect(await still(past)).toEqual([]);
    expect(await still(inside)).toEqual(names(inside));
    // An unfinished session is never trimmed, however old.
    expect(await uploadRow(open.id)).not.toBeNull();
    expect(ctx.outcomes("retention")).not.toContain("error");
    // One count per table.
    const tables = ctx.metric.mock.calls
      .filter(([name, tags]) => name === "job" && (tags as { outcome?: string }).outcome === "deleted")
      .map(([, tags]) => (tags as { reason?: string }).reason);
    expect(tables).toEqual(RETENTION_STEPS.map((step) => step.table));
  });

  it("a held account: nothing about them goes — and everything does once the hold is cleared", async () => {
    const held = await member({ legalHold: true });
    const free = await member();
    const kept = await recordsOf(held);
    const doomed = await recordsOf(free);

    const { ctx } = await run();
    expect(ctx.outcomes("retention")).not.toContain("error");
    // Control, same run: the same rows about an account that is not held are deleted.
    expect(await still(doomed)).toEqual([]);
    expect(await still(kept)).toEqual(names(kept));

    // There is no backlog flag: the age test simply applies at the next run.
    await setUserLegalHold(testDb(), held.id, false);
    await run();
    expect(await still(kept)).toEqual([]);
  });

  it.each([
    ["inside a folder on legal hold (its own flag false)", "folder"],
    ["under review", "review"],
    ["under an open-ended legal hold of its own", "own"],
  ] as const)("a file %s: nothing about it goes — until the protection ends", async (_name, how) => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const plainFolder = await makeFolder(owner.id);
    const plain = await makeFile(owner.id, plainFolder.id, { scanStatus: "clean" });
    if (how === "folder") await setNodeLegalHold(testDb(), folder.id, true);
    if (how === "review") await setNode(file.id, { scanStatus: "under_review" });
    if (how === "own") await setNodeLegalHold(testDb(), file.id, true);
    expect((await nodeById(file.id))!.legalHold).toBe(how === "own");
    const kept = await recordsAbout(file);
    const doomed = await recordsAbout(plain);

    const { ctx } = await run();
    expect(ctx.outcomes("retention")).not.toContain("error");
    // Control, same run: the same rows about a file in a folder nothing protects.
    expect(await still(doomed)).toEqual([]);
    expect(await still(kept)).toEqual(names(kept));

    if (how === "folder") await setNodeLegalHold(testDb(), folder.id, false);
    if (how === "review") await setNode(file.id, { scanStatus: "clean" });
    if (how === "own") await setNodeLegalHold(testDb(), file.id, false);
    await run();
    expect(await still(kept)).toEqual([]);
  });

  it("uploader addresses are never deleted from a list: a hold placed after the listing still protects", async () => {
    const uploaders = [await member(), await member(), await member()];
    const rows = [];
    for (const uploader of uploaders) {
      rows.push(await ipRow({ nodeId: uuidv7(), uploaderId: uploader.id, at: ago(91 * DAY) }, uploader.id));
    }
    const mine = rows.map((row) => row.id);
    // What a list-based job would act on — read BEFORE the hold exists.
    const listedIds = (await expired(testDb(), 100_000)).filter((id) => mine.includes(id));
    expect(listedIds.sort()).toEqual([...mine].sort());
    await setUserLegalHold(testDb(), uploaders[1]!.id, true);

    // Control: deleting the ids that were listed takes the held row with it (rolled back).
    const ROLLBACK = new Error("rollback");
    let byList = -1;
    await testDb()
      .transaction(async (tx) => {
        const gone = await tx
          .delete(uploadIps)
          .where(inArray(uploadIps.id, listedIds))
          .returning({ id: uploadIps.id });
        byList = gone.length;
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
    expect(byList).toBe(3);

    await run();
    expect([await rows[0]!.left(), await rows[1]!.left(), await rows[2]!.left()]).toEqual([
      false,
      true,
      false,
    ]);
  });
});
