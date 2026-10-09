// A failure INSIDE Better Auth's handler that is not one of its own errors — a database error,
// say — and where it ends up. The router underneath Better Auth prints such an error whole
// (better-call: `console.error("# SERVER_ERROR: ", error)`), and a database error carries the
// row it was about. Neither the Worker's log nor Sentry may get that.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/worker/app";
import { createAuth, scopeOf } from "../../../src/worker/auth/create-auth";
import type { Db } from "../../../src/worker/db/client";
import * as sentry from "../../../src/worker/sentry";
import { CAPTCHA, freshEmail, freshIp, ORIGIN, PASSWORD, realCore, testDb } from "./helpers";

vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn() };
});

const ADDRESS = "victim.person@mail-example.org";
const LINK = "https://holdfast.example/reset-password/Rz4Kq8Wm2Xv6Bn0Lp3Tj7Yc?callbackURL=%2Flogin";
const NAME = "Zebediah Quillfeather";

/** What a failed insert looks like: the driver's error, wrapped, with the row in its fields. */
function databaseError(): Error {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "user_email_unique"'), {
    code: "23505",
    detail: `Key (email)=(${ADDRESS}) already exists.`,
    parameters: [ADDRESS, NAME],
  });
  return new Error(`Failed query: insert into "user" … params: ${ADDRESS},${NAME} (see ${LINK})`, {
    cause: pg,
  });
}

/** A database whose every use fails that way. */
function brokenDb(): Db {
  const fail = (): never => {
    throw databaseError();
  };
  return new Proxy(function () {}, { get: fail, apply: fail, has: fail }) as unknown as Db;
}

function captureConsole(): string[] {
  const written: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      written.push(
        parts
          .map((part) => {
            if (typeof part === "string") return part;
            if (part instanceof Error) {
              const cause = part.cause instanceof Error ? ` ${part.cause.message}` : "";
              return `${part.name}: ${part.message}${cause} ${JSON.stringify({ ...part, ...(part.cause as object) })}`;
            }
            return JSON.stringify(part);
          })
          .join(" "),
      );
    });
  }
  return written;
}

const leaks = (text: string) =>
  // (The reset link's site is kept by the URL reducer; its token is what must not appear.)
  [ADDRESS, "victim.person", NAME, "Zebediah", "Rz4Kq8Wm2Xv6Bn0Lp3Tj7Yc", "callbackURL"].filter((secret) =>
    text.includes(secret),
  );

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe("an error inside Better Auth's handler that is not its own", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sentry.captureError).mockClear();
  });

  it("thrown before an endpoint runs (the rate limiter's storage): it leaves the handler, nothing is printed", async () => {
    const written = captureConsole();
    const auth = createAuth(env, brokenDb(), ctx);
    await expect(
      auth.handler(new Request(`${ORIGIN}/api/auth/ok`, { headers: { "cf-connecting-ip": "198.51.100.9" } })),
    ).rejects.toThrow(/Failed query/);
    expect(leaks(written.join("\n"))).toEqual([]);
  });

  it("thrown INSIDE an endpoint: it leaves the handler too — the router underneath does not get to print it", async () => {
    // Without `onAPIError.throw`, better-call answers this case itself: a bare 500, after
    // `console.error("# SERVER_ERROR: ", error)` — the error object, whole.
    const written = captureConsole();
    const auth = createAuth(env, testDb(), ctx);
    // A failure in the middle of a sign-up: the settings read of the sign-up policy.
    scopeOf(auth)!.settings = async () => {
      throw databaseError();
    };
    const request = new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "cf-connecting-ip": freshIp(),
        ...CAPTCHA,
      },
      body: JSON.stringify({
        email: freshEmail(),
        password: PASSWORD,
        name: NAME,
        birthYear: 1990,
        birthMonth: 5,
        acceptTerms: true,
      }),
    });
    await expect(auth.handler(request)).rejects.toThrow(/Failed query/);
    expect(written.join("\n")).not.toContain("SERVER_ERROR");
    expect(leaks(written.join("\n"))).toEqual([]);
  });

  it("the route answers 500 with the envelope and reports a sanitised copy: its class, code and scanned message", async () => {
    const written = captureConsole();
    const app = createApp({
      ...realCore,
      // The session read works (the real instance); only the handler fails.
      createAuth: (authEnv, db, authCtx) => {
        const real = createAuth(authEnv, db, authCtx);
        return {
          api: real.api,
          handler: async () => {
            throw databaseError();
          },
        };
      },
    });
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/auth/ok`, { headers: { "cf-connecting-ip": "198.51.100.10" } }),
      { ...env, APP_ORIGIN: ORIGIN } as unknown as Env,
      {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException() {},
        props: {},
      } as never,
    );
    while (pending.length) await Promise.allSettled(pending.splice(0));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("internal");
    expect(leaks(JSON.stringify(body))).toEqual([]);
    expect(leaks(written.join("\n"))).toEqual([]);

    const reported = vi.mocked(sentry.captureError).mock.calls.map(([error]) => error as Error);
    expect(reported).toHaveLength(1);
    const error = reported[0]!;
    // The parameter list — the row — is cut off whole: a name in it has no shape a scan could find.
    expect(error.message).toBe('Failed query: insert into "user" … params: [dropped]');
    expect(Object.keys(error)).toEqual([]);
    expect(error.cause).toBeUndefined();
    expect(leaks(`${error.name} ${error.message} ${error.stack}`)).toEqual([]);
  });
});
