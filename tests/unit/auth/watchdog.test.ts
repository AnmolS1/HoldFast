// The watchdog for Better Auth issue #10315 — detection, not cure (auth/watchdog.ts).
//
// On a deployed Worker a module-scope promise that an aborted request left pending never
// settles, and every later request in that isolate would wait on it for ever. The FIRST Better
// Auth call of every /api/* request is the session read in middleware/session.ts — before any
// route runs — so that call is raced against the timer too, not only `auth.handler()`. A hang
// is answered 503 with Retry-After, counted and reported.
//
// Nothing of Better Auth is stubbed for the session read: the real instance, the real database,
// and a REAL hang — the `session` table locked by another connection, so the session read's own
// query does not come back. (The lock is held for well under a second.)
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/worker/app";
import { createAuth } from "../../../src/worker/auth/create-auth";
import { AUTH_WATCHDOG_MS, setAuthWatchdogForTests } from "../../../src/worker/auth/watchdog";
import { createDb } from "../../../src/worker/db/client";
import { getSession, realCore, send, verifiedUser } from "./helpers";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** Holds `session` under an ACCESS EXCLUSIVE lock on a connection of its own until released. */
async function lockSessionTable() {
  const handle = createDb(env);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const held = handle.db
    .transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE`);
      locked();
      await gate;
    })
    .finally(() => handle.close());
  await isLocked;
  return async () => {
    release();
    await held;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("the #10315 watchdog", () => {
  it("is ten seconds", () => {
    expect(AUTH_WATCHDOG_MS).toBe(10_000);
  });

  it.each([
    ["an app route (the session read is its first Better Auth call)", "/api/account/deletion-status"],
    ["an auth route", "/api/auth/list-sessions"],
    ["a path no route has", "/api/no/such/route"],
  ])(
    "a session read that never answers — %s: 503 with Retry-After, counted, not a hung request",
    async (_what, path) => {
      const signedIn = await verifiedUser();
      expect((await getSession(signedIn.client))?.user.id).toBe(signedIn.user.id);
      const points: Array<{ blobs?: unknown[] }> = [];
      const METRICS = { writeDataPoint: (point: { blobs?: unknown[] }) => void points.push(point) };
      restore = setAuthWatchdogForTests(250);
      const unlock = await lockSessionTable();
      let answer: Awaited<ReturnType<typeof send>>;
      const started = Date.now();
      try {
        const pending = send(signedIn.client, path, { env: { METRICS } });
        // The request is answered by the watchdog while the lock is still held…
        await sleep(600);
        await unlock();
        answer = await pending;
      } finally {
        await unlock().catch(() => {});
      }
      expect(answer.status, answer.text).toBe(503);
      expect(answer.headers.get("retry-after")).toBe("30");
      expect(answer.body).toMatchObject({ error: "internal" });
      expect((answer.body as { requestId?: string }).requestId).toBeTruthy();
      expect(Date.now() - started).toBeLessThan(5_000);
      // …and the hang is a metric: `auth` / outcome `hang`.
      const hang = points.filter((point) => {
        const blobs = (point.blobs ?? []).filter((blob) => typeof blob === "string");
        return blobs[0] === "auth" && blobs.includes("hang");
      });
      expect(hang).toHaveLength(1);
      // Nothing was broken by it: the same session works on the next request.
      expect((await send(signedIn.client, "/api/account/deletion-status")).status).toBe(200);
    },
  );

  it("control: the same request with the lock released at once is answered normally", async () => {
    const signedIn = await verifiedUser();
    restore = setAuthWatchdogForTests(2_000);
    const unlock = await lockSessionTable();
    const pending = send(signedIn.client, "/api/account/deletion-status");
    await sleep(100);
    await unlock();
    expect((await pending).status).toBe(200);
  });

  it("a HANDLER that never answers (the session read is the real one): 503 with Retry-After", async () => {
    restore = setAuthWatchdogForTests(80);
    let handlerCalls = 0;
    const app = createApp({
      ...realCore,
      createAuth: (authEnv, db, ctx) => {
        const real = createAuth(authEnv, db, ctx);
        return {
          api: real.api,
          handler: () => {
            handlerCalls += 1;
            return new Promise<Response>(() => {});
          },
        };
      },
    });
    const response = await request(app, "/api/auth/get-session");
    expect(handlerCalls).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal");
    expect(body.requestId).toBeTruthy();
  });

  it("a handler that answers in time is passed through untouched", async () => {
    restore = setAuthWatchdogForTests(2_000);
    const app = createApp({
      ...realCore,
      createAuth: (authEnv, db, ctx) => ({
        api: createAuth(authEnv, db, ctx).api,
        handler: async () => new Response("answered", { status: 418, headers: { "x-from": "auth" } }),
      }),
    });
    const response = await request(app, "/api/auth/anything");
    expect(response.status).toBe(418);
    expect(response.headers.get("x-from")).toBe("auth");
    expect(await response.text()).toBe("answered");
  });
});

describe("every call into Better Auth is under the watchdog (source scan)", () => {
  it("the Worker calls `.api.*` and `.handler(` only inside `watched(`", () => {
    const sources = import.meta.glob("../../../src/worker/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(60);
    const calls: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const name = file.replace(/^(?:\.\.\/)+/, "");
      // The instance itself (it wraps Better Auth's handler) and the schema generator's input.
      if (name === "src/worker/auth/create-auth.ts" || name === "src/worker/auth/config.ts") continue;
      const code = text
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join("\n");
      for (const match of code.matchAll(
        /(?:auth\(c\)|instance|auth)\s*\.\s*(?:api\s*\.\s*\w+|handler)\b[^\n]*/g,
      )) {
        const before = code.slice(Math.max(0, match.index - 40), match.index);
        calls.push(`${name}: ${/watched\(\s*$/.test(before) ? "watched( " : ""}${match[0].trim()}`);
      }
    }
    expect(calls.sort()).toEqual([
      "src/worker/middleware/session.ts: watched( auth(c).api.getSession({",
      "src/worker/routes/auth.ts: watched( instance.handler(request));",
    ]);
  });
});

async function request(app: ReturnType<typeof createApp>, path: string) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
    props: {},
  };
  const response = await app.fetch(
    new Request(`${env.APP_ORIGIN}${path}`),
    env,
    ctx as unknown as ExecutionContext,
  );
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return response;
}
