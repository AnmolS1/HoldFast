// "Run now" (task §11): `POST /api/admin/jobs/:name/run` runs exactly the registry's jobs, one
// bounded pass inside the request, for a 2FA admin only, one audit row per call. No real guarded
// job runs in this file (the parallel step): a registry entry's `run` is replaced by a fake for
// the length of one test — the registry is this file's own module instance.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/worker/app";
import type { Auth } from "../../../src/worker/auth/types";
import { jobs, type Job } from "../../../src/worker/jobs/index";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { BASE_SETTINGS, realCore } from "../auth/helpers";
import { adminCall, admin, auditOf, baId, member, type Who } from "./helpers";

const PLAIN = "operator-digests";
const STREAMED = "backup";

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

/** Replaces the registry job's `run` until the end of the test. */
function fake(name: string, run: Job["run"]): Job {
  const job = jobs.find((candidate) => candidate.name === name)!;
  const real = job.run;
  job.run = run;
  restore.push(() => {
    job.run = real;
  });
  return job;
}

const run = (who: Who, name: string) => adminCall(who, "POST", `/jobs/${name}/run`);
const today = () => new Date().toISOString().slice(0, 10);
const lines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("who may run a job", () => {
  it("non-admin 403, no 2FA admin_requires_2fa, impersonated 403 — and the job is not run", async () => {
    let calls = 0;
    fake(PLAIN, async () => {
      calls += 1;
    });
    const someone = await member();
    const no2fa = await admin({ twoFactorEnabled: false });
    const target = await admin();
    expect([(await run(someone.as, PLAIN)).status, (await run(someone.as, PLAIN)).body.error]).toEqual([
      403,
      "forbidden",
    ]);
    expect((await run(no2fa.as, PLAIN)).body.error).toBe("admin_requires_2fa");
    const impersonated = await run({ ...target.as, impersonatedBy: baId() }, PLAIN);
    expect([impersonated.status, impersonated.body.details?.reason]).toEqual([
      403,
      "impersonation_read_only",
    ]);
    expect(calls).toBe(0);
  });

  it("only registry names: an unknown name and one outside [a-z-]+ are 404", async () => {
    const who = await admin();
    expect((await run(who.as, "nope")).status).toBe(404);
    expect((await run(who.as, "Purge")).status).toBe(404);
    expect((await run(who.as, "purge_1")).status).toBe(404);
    expect(await auditOf("admin.job_run", "nope")).toEqual([]);
  });
});

describe("the plain pass", () => {
  it("done inside the deadline → 200 {name, done:true}; not done → 202 {name, done:false}; one call = one run with a full BackgroundContext", async () => {
    const seen: Array<{ settings: boolean; keys: boolean; metric: boolean }> = [];
    let answer: { done: boolean } = { done: true };
    fake(PLAIN, async (bg) => {
      bg.metric("job", { kind: PLAIN, outcome: "test" });
      seen.push({
        settings: typeof (await bg.settings()).readOnly === "boolean",
        keys: typeof bg.keys.get === "function",
        metric: typeof bg.metric === "function",
      });
      return answer;
    });
    const who = await admin();
    const before = (await auditOf("admin.job_run", PLAIN)).length;
    const done = await run(who.as, PLAIN);
    expect([done.status, done.body]).toEqual([200, { name: PLAIN, done: true }]);
    answer = { done: false };
    const more = await run(who.as, PLAIN);
    expect([more.status, more.body]).toEqual([202, { name: PLAIN, done: false }]);
    expect(seen).toEqual([
      { settings: true, keys: true, metric: true },
      { settings: true, keys: true, metric: true },
    ]);
    const rows = (await auditOf("admin.job_run", PLAIN)).slice(before);
    expect(rows.filter((row) => row.actorUserId === who.id)).toHaveLength(2);
    for (const row of rows.filter((r) => r.actorUserId === who.id)) {
      expect(row).toMatchObject({ actorType: "admin", targetType: "job", meta: { name: PLAIN } });
    }
  });

  it("nothing the job defers outlives the response: its follow-up has settled when the response exists", async () => {
    // The answer is read straight from the app here (not through helpers.call, which drains the
    // waitUntil promises before it returns): `settledAtResponse` is the job's follow-up as it
    // stood the moment `fetch` resolved. `runBackground` awaits the job's deferred work.
    const who = await admin();
    let settled = false;
    fake(PLAIN, async (bg) => {
      bg.defer(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 50),
        ),
      );
    });
    const auth: Auth = {
      handler: async () => new Response(null, { status: 501 }),
      api: {
        getSession: async () => ({
          session: {
            id: "s".repeat(32),
            userId: who.id,
            token: "made-up-session-token", // not a credential: the stand-in auth never checks it
            expiresAt: new Date(Date.now() + 3_600_000),
            createdAt: new Date(),
            updatedAt: new Date(),
            impersonatedBy: null,
            secondFactorAt: new Date(),
          },
          user: who.as.user,
        }),
      },
    };
    const app = createApp({ ...realCore, createAuth: () => auth, getSettings: async () => BASE_SETTINGS });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const allow = { limit: async () => ({ success: true }) };
    const response = await app.fetch(
      new Request(`${TEST_APP_ORIGIN}/api/admin/jobs/${PLAIN}/run`, {
        method: "POST",
        headers: { origin: TEST_APP_ORIGIN },
      }),
      { ...env, RL_AUTH: allow, RL_API: allow, RL_FILES: allow, RL_LINKS: allow } as unknown as Env,
      ctx,
    );
    const settledAtResponse = settled;
    expect(response.status).toBe(200);
    await response.text();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    expect(settledAtResponse).toBe(true);
  });
});

describe("the streamed pass (backup)", () => {
  it("one progress line per new _progress/ record OF THE CURRENT ATTEMPT (`_attempt.json`), the last line {name, done:true}, as application/x-ndjson", async () => {
    const who = await admin();
    const prefix = `b/db/${today()}/_progress/`;
    const attempt = `b/db/${today()}/_attempt.json`;
    // A record left by the attempt before this one (Addendum 1, 19:05): never shown as progress.
    await env.FILES.put(`${prefix}old.json`, JSON.stringify({ attempt: "attempt-1" }));
    fake(STREAMED, async () => {
      await env.FILES.put(
        attempt,
        JSON.stringify({ attempt: "attempt-2", startedAt: new Date().toISOString() }),
      );
      await env.FILES.put(`${prefix}users.json`, JSON.stringify({ attempt: "attempt-2" }));
      await env.FILES.put(`${prefix}nodes.json`, JSON.stringify({ attempt: "attempt-2" }));
      return { done: true };
    });
    const answer = await run(who.as, STREAMED);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/x-ndjson");
    const body = lines(answer.text);
    expect(body.at(-1)).toEqual({ name: STREAMED, done: true });
    expect(
      body
        .slice(0, -1)
        .map((line) => line.progress)
        .sort(),
    ).toEqual(["nodes.json", "users.json"]);
    await env.FILES.delete([`${prefix}users.json`, `${prefix}nodes.json`, `${prefix}old.json`, attempt]);
  });

  it("a pass that runs out of time ends {done:false}; a second call finishes it", async () => {
    const who = await admin();
    let passes = 0;
    fake(STREAMED, async () => {
      passes += 1;
      return { done: passes > 1 };
    });
    expect(lines((await run(who.as, STREAMED)).text).at(-1)).toEqual({ name: STREAMED, done: false });
    expect(lines((await run(who.as, STREAMED)).text).at(-1)).toEqual({ name: STREAMED, done: true });
    expect(passes).toBe(2);
  });

  it("a job that throws ends the stream with {done:false, error:'internal'} — and no detail", async () => {
    const who = await admin();
    fake(STREAMED, async () => {
      throw new Error("made-up failure with a secret-looking detail");
    });
    const answer = await run(who.as, STREAMED);
    expect(answer.status).toBe(200);
    expect(lines(answer.text)).toEqual([{ name: STREAMED, done: false, error: "internal" }]);
    expect(answer.text).not.toContain("made-up failure");
  });
});
