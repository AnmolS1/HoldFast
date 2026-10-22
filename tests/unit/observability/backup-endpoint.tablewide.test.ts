// T27 Part B: the on-demand backup through T25's endpoint, with the REAL job (T25's own tests
// replace the job with a fake). `POST /api/admin/jobs/backup/run` is the only way to run a backup
// on a deployed Worker; the operator repeats the streamed call until its last line says
// `done: true` (task :118-123, :253), so what this file pins is the contract that repetition
// relies on: `done: true` only when today's set is complete — a manifest whose attempt is the one
// `_attempt.json` names — and the progress lines are that attempt's tables.
//
// Table-wide (serial step 3; by hand `HOLDFAST_TABLEWIDE=1 npx vitest run -c
// vitest.workers.config.ts tests/unit/observability/backup-endpoint.tablewide.test.ts`): the pass
// reads every table. The endpoint cannot be given a date, so it writes TODAY's set — into this
// file's own bucket (R2 is isolated per test file). Credentials here are made up.
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { schemaTableNames } from "../../../src/worker/db/queries/backup";
import { withJobLock } from "../../../src/worker/db/queries/trash-jobs";
import { attemptKey, manifestKey, type Manifest } from "../../../src/worker/jobs/backup";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { admin, adminCall, testDb, type Who } from "../admin/helpers";

const today = () => new Date().toISOString().slice(0, 10);
const runBackup = (who: Who) => adminCall(who, "POST", "/jobs/backup/run");
const lines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function listAll(prefix: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const listed = await env.FILES.list({ prefix, cursor });
    for (const object of listed.objects) out.set(object.key, object.etag);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out;
}

const json = async <T>(key: string) => (await (await env.FILES.get(key))!.json()) as T;

afterAll(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
  const keys = [...(await listAll("b/db/")).keys()];
  if (keys.length) await env.FILES.delete(keys);
});

describe("the streamed on-demand backup, the real job behind T25's endpoint", () => {
  it("while another pass holds the job lock (the cron slot), a call ends {done:false} and writes no set", async () => {
    const who = await admin();
    const answer = await withJobLock(testDb(), "backup", 60_000, async () => runBackup(who.as));
    expect(answer.held).toBe(true);
    if (!answer.held) return;
    expect(answer.value.status).toBe(200);
    expect(lines(answer.value.text).at(-1)).toEqual({ name: "backup", done: false });
    expect(await env.FILES.head(manifestKey(today()))).toBeNull();
    expect(await listAll(`b/db/${today()}/`)).toEqual(new Map());
  }, 120_000);

  it("a call ends {done:true} only with today's set complete: the manifest of the attempt _attempt.json names, one progress line per table of it", async () => {
    const who = await admin();
    const answer = await runBackup(who.as);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/x-ndjson");
    const body = lines(answer.text);
    expect(body.at(-1)).toEqual({ name: "backup", done: true });

    const manifest = await json<Manifest>(manifestKey(today()));
    const { attempt } = await json<{ attempt: string }>(attemptKey(today()));
    expect(manifest.attempt).toBe(attempt);
    expect(manifest.tables.map((table) => table.name).sort()).toEqual(schemaTableNames());
    expect(manifest.detection).toBe("ok");
    const progress = body.slice(0, -1).map((line) => line.progress as string);
    expect([...progress].sort()).toEqual(
      schemaTableNames()
        .map((name) => `${name}.json`)
        .sort(),
    );
    for (const name of progress) {
      const record = await json<{ attempt: string }>(`b/db/${today()}/_progress/${name}`);
      expect(record.attempt, name).toBe(attempt);
    }
  }, 600_000);

  it("a repeated call once the set is complete answers {done:true} and rewrites nothing", async () => {
    const who = await admin();
    const before = await listAll(`b/db/${today()}/`);
    const answer = await runBackup(who.as);
    expect(lines(answer.text).at(-1)).toEqual({ name: "backup", done: true });
    expect(await listAll(`b/db/${today()}/`)).toEqual(before);
  }, 120_000);

  it('R-10: backup is not guarded — with the pause switch on the call still runs (no 409) and the set records "paused"', async () => {
    const who = await admin();
    const keys = [...(await listAll(`b/db/${today()}/`)).keys()];
    if (keys.length) await env.FILES.delete(keys);
    await env.FILES.put(DESTROY_PAUSED_KEY, "made-up reason: restore drill");
    let answer;
    try {
      answer = await runBackup(who.as);
    } finally {
      await env.FILES.delete(DESTROY_PAUSED_KEY);
    }
    expect(answer.status).toBe(200);
    expect(lines(answer.text).at(-1)).toEqual({ name: "backup", done: true });
    expect((await json<Manifest>(manifestKey(today()))).detection).toBe("paused");
  }, 600_000);
});
