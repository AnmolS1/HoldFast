// OPERATOR_CRITICAL `scanner_down` (T27B, authorised seam; security review of 354981f folded in).
// The alert is about the scanner's HEALTH, never one file:
//  - `not_ready` (the scanner itself) qualifies: a dead letter with it, or a delivery still
//    answered `not_ready` 10 min after its message was first sent;
//  - `engine` / `timeout` can be caused by ONE crafted file, so their dead letters qualify only
//    from ≥ 3 DISTINCT owners within 30 min;
//  - at most ONE mail per 6 h, across episodes: recovery never resets the throttle;
//  - recovery (audit `system.scanner_recovered`) only after a real verdict when the last scanner
//    error is ≥ 10 min old (hysteresis).
//
// Isolation: every test owns its own alert row (`scannerAlertScope.key`, this file's module
// instance only), so T21's dlq.test.ts — which writes the default row in the same parallel step —
// cannot change what these tests see. The operator address is made up and per test.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claim } from "../../../src/worker/db/queries/scan-jobs";
import { scanJobs } from "../../../src/worker/db/schema";
import {
  scanObject,
  ScannerBusyError,
  ScannerNotReadyError,
  ScannerTransportError,
} from "../../../src/worker/scan/container";
import { queue, scannerAlertScope } from "../../../src/worker/scan/consumer";
import { runBackground } from "../../../src/worker/services/request-context";
import { realCore } from "../auth/helpers";
import { cleanBytes, deliver, explicit, mailTo, makeUser, rand, testDb, uploadedFile } from "../scan/helpers";

vi.mock("../../../src/worker/scan/container", async (original) => {
  const real = await original<typeof import("../../../src/worker/scan/container")>();
  return { ...real, scanObject: vi.fn(real.scanObject) };
});

const DLQ = "holdfast-scan-dev-dlq";
const HEADING = "The virus scanner is not answering";
const MIN = 60_000;

let ops = "";
let asOps: Record<string, string> = {};
beforeEach(() => {
  scannerAlertScope.key = `scannerAlert:test:${rand(8)}`;
  ops = `t27b-scanner-${rand()}@example.test`; // made up
  asOps = { ADMIN_EMAILS: ops, E2E_ADMIN_EMAILS: "" };
});
afterEach(async () => {
  await testDb().execute(sql`DELETE FROM settings WHERE key = ${scannerAlertScope.key}`);
});

const mails = () =>
  mailTo(ops, "operatorCritical").filter((mail) => JSON.stringify(mail).includes(HEADING)).length;
const alertRow = async () =>
  (
    await testDb().execute<{ value: Record<string, unknown> }>(
      sql`SELECT value FROM settings WHERE key = ${scannerAlertScope.key}`,
    )
  ).rows[0]?.value ?? null;
/** Moves the alert row's times back, as if they happened `ms` ago. */
const ago = (field: string, ms: number) =>
  testDb().execute(sql`
    UPDATE settings SET value = jsonb_set(value, ${`{${field}}`}::text[], to_jsonb(${new Date(Date.now() - ms).toISOString()}::text))
    WHERE key = ${scannerAlertScope.key}`);

/** A pending file of `owner` whose scan job failed with this last error, delivered to the DLQ. */
async function deadLetter(
  lastError: string | null,
  owner?: Awaited<ReturnType<typeof makeUser>>,
  extra = {},
) {
  const { file } = await uploadedFile(cleanBytes(), owner ? { owner } : {});
  if (lastError !== null) {
    await claim(testDb(), { nodeId: file.id, r2Key: file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "failed", lastError, verdict: { requeuedFromDlq: true } })
      .where(eq(scanJobs.r2Key, file.r2Key!));
  }
  expect(await deliver([{ body: explicit(file) }], { ...asOps, ...extra }, DLQ)).toEqual([
    { outcome: "ack" },
  ]);
}

/** A clean file scanned to a real verdict (the stub scanner). */
async function cleanVerdict() {
  const { file } = await uploadedFile(cleanBytes());
  expect(await deliver([{ body: explicit(file) }], asOps)).toEqual([{ outcome: "ack" }]);
}

/** One main-queue delivery first sent `ageMs` ago, the real scanner path answering `error`. */
async function failingFor(ageMs: number, error: () => Error) {
  const { file } = await uploadedFile(cleanBytes());
  vi.mocked(scanObject).mockRejectedValueOnce(error());
  const runEnv = { ...env, ...asOps, SCAN_STUB: "0" } as unknown as Env;
  const batch = createMessageBatch("holdfast-scan-dev", [
    { id: `m-${rand()}`, timestamp: new Date(Date.now() - ageMs), body: explicit(file), attempts: 2 },
  ]);
  const ctx = createExecutionContext();
  await runBackground(runEnv, ctx, (bg) => queue(batch, runEnv, ctx, bg), realCore);
  expect((await getQueueResult(batch, ctx)).retryMessages).toHaveLength(1);
}

const recoveries = async (since: Date) =>
  (
    await testDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'system.scanner_recovered' AND at >= ${since.toISOString()}::timestamptz
        AND meta ->> 'key' = ${scannerAlertScope.key}`)
  ).rows[0]!.n;

describe("scanner_down: scanner health, not one file", () => {
  it("a not_ready dead letter → 1 mail; more not_ready dead letters within 6 h → still 1", async () => {
    await deadLetter("not_ready");
    expect(mails()).toBe(1);
    await deadLetter("not_ready");
    await deadLetter("not_ready");
    expect(mails()).toBe(1);
  });

  it("ONE owner's 10 timeouts, alternating with clean verdicts → 0 mails", async () => {
    const owner = await makeUser();
    for (let i = 0; i < 10; i++) {
      await deadLetter(i % 2 ? "timeout" : "engine", owner);
      await cleanVerdict();
    }
    expect(mails()).toBe(0);
  });

  it("3 DISTINCT owners' timeouts within 30 min → 1 mail (2 owners → none)", async () => {
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    await deadLetter("timeout", a);
    await deadLetter("engine", a);
    await deadLetter("timeout", b);
    expect(mails()).toBe(0);
    await deadLetter("timeout", c);
    expect(mails()).toBe(1);
  });

  it("the bounded suspect list keeps one entry per owner: one owner's flood takes one place", async () => {
    const [a, flooder] = [await makeUser(), await makeUser()];
    await deadLetter("timeout", a);
    for (let i = 0; i < 60; i++) await deadLetter(i % 2 ? "timeout" : "engine", flooder);
    const suspects = (await alertRow())?.suspects as { owner: string }[];
    expect(suspects.map((entry) => entry.owner).sort()).toEqual([a.id, flooder.id].sort());
    expect(mails()).toBe(0);
  });

  it("CONTROL: 3 owners, but the first more than 30 min ago → none", async () => {
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    await deadLetter("timeout", a);
    await testDb().execute(sql`
      UPDATE settings SET value = jsonb_set(value, '{suspects,0,at}', to_jsonb(${new Date(Date.now() - 31 * MIN).toISOString()}::text))
      WHERE key = ${scannerAlertScope.key}`);
    await deadLetter("timeout", b);
    await deadLetter("timeout", c);
    expect(mails()).toBe(0);
  });

  it("down → recovered → down within 6 h → still 1 mail; the recovery is audited once", async () => {
    const started = new Date();
    await deadLetter("not_ready");
    expect(mails()).toBe(1);
    await ago("lastErrorAt", 11 * MIN);
    await cleanVerdict();
    expect(await recoveries(started)).toBe(1);
    expect((await alertRow())!.mailedAt).toBeTruthy();
    await deadLetter("not_ready");
    expect(mails()).toBe(1);
    // 6 h after the one mail, a new episode mails again.
    await ago("mailedAt", 6 * 60 * MIN + MIN);
    await deadLetter("not_ready");
    expect(mails()).toBe(2);
  });

  it("hysteresis: a real verdict while the last scanner error is under 10 min old records no recovery", async () => {
    const started = new Date();
    await deadLetter("not_ready");
    await ago("lastErrorAt", 9 * MIN);
    await cleanVerdict();
    expect(await recoveries(started)).toBe(0);
    await ago("lastErrorAt", 10 * MIN + 1000);
    await cleanVerdict();
    expect(await recoveries(started)).toBe(1);
  });

  it("before the DLQ: not_ready for 9 min → no mail; 10 min → 1 mail; 30 min → still 1", async () => {
    const notReady = () => new ScannerNotReadyError("clamd_loading", null, 30);
    await failingFor(9 * MIN, notReady);
    expect(mails()).toBe(0);
    await failingFor(10 * MIN, notReady);
    expect(mails()).toBe(1);
    await failingFor(30 * MIN, notReady);
    expect(mails()).toBe(1);
  });

  it("CONTROL: before the DLQ, engine / timeout / busy for an hour (one file can cause them) → no mail", async () => {
    await failingFor(60 * MIN, () => new ScannerTransportError("timeout", "no answer"));
    await failingFor(60 * MIN, () => new ScannerTransportError("engine", "scanner answered 502"));
    await failingFor(60 * MIN, () => new ScannerBusyError(15));
    expect(mails()).toBe(0);
  });

  it("CONTROL: dead letters for non-scanner reasons (PhotoDNA, the database, reset, busy, no job) → no mail", async () => {
    for (const lastError of ["photodna", "connection terminated unexpectedly", "reset", "busy", null]) {
      await deadLetter(lastError);
    }
    expect(mails()).toBe(0);
  });

  it("no operator address: the mail is not spent — the next not_ready dead letter with one mails", async () => {
    await deadLetter("not_ready", undefined, { ADMIN_EMAILS: "" });
    expect(mails()).toBe(0);
    await deadLetter("not_ready");
    expect(mails()).toBe(1);
  });
});
