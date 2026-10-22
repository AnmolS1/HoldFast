// OPERATOR_CRITICAL `scanner_down` (T27B, authorised seam): a scan dead-lettered because the
// SCANNER failed (its job's last error `not_ready`, `engine` or `timeout`) mails the operators on
// the transition, then at most every 6 h while it lasts; the next real verdict records the
// recovery, so the next dead letter is a transition again. A dead letter for any other reason
// (PhotoDNA, the database, no job, a deploy's reset / busy re-sent once) mails nothing.
//
// Table-wide (serial step 3; by hand `HOLDFAST_TABLEWIDE=1 npx vitest run -c
// vitest.workers.config.ts tests/unit/observability/scanner-down.tablewide.test.ts`): the alert's
// state is ONE settings row (`scannerAlert`) for the whole estate. Each test starts with it gone.
// The operator address is made up and this file's own.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claim } from "../../../src/worker/db/queries/scan-jobs";
import { scanJobs } from "../../../src/worker/db/schema";
import { cleanBytes, deliver, explicit, mailTo, rand, testDb, uploadedFile } from "../scan/helpers";

/** The settings row the alert keeps (`db/queries/trash-jobs.ts`). */
const SCANNER_ALERT_KEY = "scannerAlert";
const OPS = `t27b-scanner-${rand()}@example.test`; // made up
const asOps = { ADMIN_EMAILS: OPS, E2E_ADMIN_EMAILS: "" };
const DLQ = "holdfast-scan-dev-dlq";
const HEADING = "The virus scanner is not answering";

const scannerMails = () =>
  mailTo(OPS, "operatorCritical").filter((mail) => JSON.stringify(mail).includes(HEADING));

const resetAlert = () => testDb().execute(sql`DELETE FROM settings WHERE key = ${SCANNER_ALERT_KEY}`);

/** A pending file whose scan job failed with this last error — what reaches the DLQ. */
async function deadLetter(lastError: string | null, env: Record<string, unknown> = asOps) {
  const { file } = await uploadedFile(cleanBytes());
  if (lastError !== null) {
    await claim(testDb(), { nodeId: file.id, r2Key: file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "failed", lastError, verdict: { requeuedFromDlq: true } })
      .where(eq(scanJobs.r2Key, file.r2Key!));
  }
  expect(await deliver([{ body: explicit(file) }], env, DLQ)).toEqual([{ outcome: "ack" }]);
  return file;
}

beforeEach(resetAlert);
afterAll(resetAlert);

describe("scanner_down", () => {
  it.each(["not_ready", "engine", "timeout"])(
    "a scan dead-lettered with %s mails the operators once; a second one within 6 h does not",
    async (lastError) => {
      const before = scannerMails().length;
      await deadLetter(lastError);
      expect(scannerMails().length - before).toBe(1);
      await deadLetter(lastError);
      await deadLetter("not_ready");
      expect(scannerMails().length - before).toBe(1);
    },
  );

  it("still down: 5 h 59 min after the last mail → not again; 6 h 1 min after → mailed again", async () => {
    const before = scannerMails().length;
    await deadLetter("not_ready");
    const mailedAgo = (ms: number) =>
      testDb().execute(sql`
        UPDATE settings SET value = jsonb_set(value, '{mailedAt}', to_jsonb(${new Date(Date.now() - ms).toISOString()}::text))
        WHERE key = ${SCANNER_ALERT_KEY}`);
    await mailedAgo(6 * 3_600_000 - 60_000);
    await deadLetter("timeout");
    expect(scannerMails().length - before).toBe(1);
    await mailedAgo(6 * 3_600_000 + 60_000);
    await deadLetter("timeout");
    expect(scannerMails().length - before).toBe(2);
  });

  it("a real verdict records the recovery: the next scanner dead letter is a transition and mails at once", async () => {
    const before = scannerMails().length;
    await deadLetter("engine");
    expect(scannerMails().length - before).toBe(1);
    const { file } = await uploadedFile(cleanBytes());
    expect(await deliver([{ body: explicit(file) }], asOps)).toEqual([{ outcome: "ack" }]);
    const row = await testDb().execute(sql`SELECT 1 FROM settings WHERE key = ${SCANNER_ALERT_KEY}`);
    expect(row.rows).toHaveLength(0);
    const audit = await testDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'system.scanner_recovered' AND at > now() - interval '1 minute'`);
    expect(audit.rows[0]!.n).toBeGreaterThan(0);
    await deadLetter("not_ready");
    expect(scannerMails().length - before).toBe(2);
  });

  it("CONTROL: dead-lettered for a non-scanner reason — PhotoDNA, the database, no job, reset/busy after their one re-send — mails nothing and writes no alert", async () => {
    const before = scannerMails().length;
    for (const lastError of ["photodna", "connection terminated unexpectedly", "reset", "busy", null]) {
      await deadLetter(lastError);
    }
    expect(scannerMails().length - before).toBe(0);
    const row = await testDb().execute(sql`SELECT 1 FROM settings WHERE key = ${SCANNER_ALERT_KEY}`);
    expect(row.rows).toHaveLength(0);
  });

  it("no operator address: nothing is claimed — the first dead letter after one is configured mails", async () => {
    const before = scannerMails().length;
    await deadLetter("not_ready", { ADMIN_EMAILS: "", E2E_ADMIN_EMAILS: "" });
    const row = await testDb().execute(sql`SELECT 1 FROM settings WHERE key = ${SCANNER_ALERT_KEY}`);
    expect(row.rows).toHaveLength(0);
    await deadLetter("not_ready");
    expect(scannerMails().length - before).toBe(1);
  });
});
