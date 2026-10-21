// T22 step 8 — the ceilings (T10's `services/ceilings.ts`, enforced by T10, T12, T13, T24) at
// their boundaries, each kind THROUGH ITS ENFORCING CALL: `consumeCeiling` / `tryConsumeCeiling`
// for the ledger-only kinds, `consumeCeiling(…, { tx })` for `link_user`, `enforceUploadCeilings(…,
// { tx })` for the two upload kinds — never `checkCeiling` + `recordUsage`. This file re-runs no
// concurrency proof (T10's, T12's, T13's and T24's); it asserts the numbers. Limits are passed in
// as `settings.ceilings` (never written); every subject is fresh.
import { describe, expect, it } from "vitest";
import { todayTotals } from "../../../src/worker/db/queries/ledger";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { retryOnDeadlock } from "../../../src/worker/db/retry";
import {
  CEILING_KINDS,
  consumeCeiling,
  effectiveLimits,
  enforceUploadCeilings,
  tryConsumeCeiling,
  type CeilingSubject,
  type LedgerOnlyKind,
} from "../../../src/worker/services/ceilings";
import { AppError } from "../../../src/worker/services/errors";
import { db as dbOf } from "../../../src/worker/services/request-context";
import { env } from "cloudflare:workers";
import { makeUpload, makeUser, rand, testDb } from "../services-core/helpers";
import { invoke } from "../services-core/request";

const OLD = { quotaBytes: 0, createdAt: new Date("2020-01-01T00:00:00.000Z") };
const subjectId = () => `t22-${rand(8)}`;

/** Settings whose ceilings are `over` and whose accounts are never "new" unless a test says so. */
const limits = (over: Record<string, number>): Settings => ({
  signupMode: "invite",
  termsVersion: "2026-10",
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: { NEW_ACCOUNT_DAYS: 7, NEW_ACCOUNT_FACTOR: 0.5, ...over },
});

type Case = {
  kind: LedgerOnlyKind;
  ledger: "user" | "link" | "ip" | "link_owner" | "transform_user" | "share_user";
  key: string;
  dimension: "bytes" | "count";
  account: boolean;
};
const LEDGER_ONLY: Case[] = [
  { kind: "download_user", ledger: "user", key: "CEIL_USER_BYTES_DAY", dimension: "bytes", account: true },
  { kind: "download_link", ledger: "link", key: "CEIL_LINK_BYTES_DAY", dimension: "bytes", account: true },
  {
    kind: "download_link",
    ledger: "link",
    key: "CEIL_LINK_DOWNLOADS_DAY",
    dimension: "count",
    account: true,
  },
  { kind: "download_ip", ledger: "ip", key: "CEIL_IP_BYTES_DAY", dimension: "bytes", account: false },
  {
    kind: "download_owner",
    ledger: "link_owner",
    key: "CEIL_OWNER_LINK_BYTES_DAY",
    dimension: "bytes",
    account: true,
  },
  {
    kind: "transform_user",
    ledger: "transform_user",
    key: "CEIL_TRANSFORMS_DAY",
    dimension: "count",
    account: true,
  },
  { kind: "share_user", ledger: "share_user", key: "CEIL_SHARES_DAY", dimension: "count", account: true },
];

describe("every CeilingKind is covered here", () => {
  it("the nine kinds: seven ledger-only cases, link_user, upload_user and upload_editor", () => {
    expect(new Set([...LEDGER_ONLY.map((c) => c.kind), "link_user", "upload_user", "upload_editor"])).toEqual(
      new Set(CEILING_KINDS),
    );
  });
});

describe("ledger-only kinds through consumeCeiling / tryConsumeCeiling", () => {
  it.each(LEDGER_ONLY)(
    "$kind ($dimension): the consume that reaches the limit succeeds; the next throws 429 ceiling_exceeded with Retry-After and writes nothing; tryConsumeCeiling answers ok: false and writes nothing",
    async ({ kind, ledger, key, dimension }) => {
      const id = subjectId();
      const subject: CeilingSubject = { id, account: OLD };
      const settings = limits({ [key]: 3 });
      const amount = (n: number) => ({ [dimension]: n }) as never;
      const run = await invoke(
        null,
        async (c) => {
          await consumeCeiling(c, kind, subject, amount(2));
          await consumeCeiling(c, kind, subject, amount(1)); // reaches 3 exactly
          let refused: AppError | null = null;
          try {
            await consumeCeiling(c, kind, subject, amount(1));
          } catch (error) {
            refused = error as AppError;
          }
          const tried = await tryConsumeCeiling(c, kind, subject, amount(1));
          return { refused, tried, totals: await todayTotals(dbOf(c), ledger, id) };
        },
        { settings },
      );
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const { refused, tried, totals } = run.value;
      expect(refused).toBeInstanceOf(AppError);
      expect(refused!.code).toBe("ceiling_exceeded");
      expect(Number(refused!.headers?.["Retry-After"])).toBeGreaterThan(0);
      expect(Number(refused!.headers?.["Retry-After"])).toBeLessThanOrEqual(86_400);
      expect(tried).toMatchObject({ ok: false, kind, dimension, limit: 3, used: 3 });
      expect(totals[dimension]).toBe(3);
    },
  );

  it("download_user scales with the quota (max(base, quota)); download_link and download_ip do not", () => {
    const big = { quotaBytes: 9_000_000_000_000, createdAt: OLD.createdAt };
    const s = limits({});
    expect(effectiveLimits(env, s, "download_user", big).bytes).toBe(9_000_000_000_000);
    expect(effectiveLimits(env, s, "download_link", big)).toEqual({ bytes: 20_000_000_000, count: 1000 });
    expect(effectiveLimits(env, s, "download_ip", undefined)).toEqual({ bytes: 50_000_000_000 });
  });

  it("the new-account factor: a young account's limit is the base × factor, an old one's the base", () => {
    const s = limits({ CEIL_SHARES_DAY: 10 });
    expect(effectiveLimits(env, s, "share_user", { quotaBytes: 0, createdAt: new Date() }).count).toBe(5);
    expect(effectiveLimits(env, s, "share_user", OLD).count).toBe(10);
  });

  it("upload_user scaling is decimal: a 5,000,000,000-byte quota gives 500 a day — the base of 2,000 applies; with a base of 100 the 500 does", () => {
    const quota = { quotaBytes: 5_000_000_000, createdAt: OLD.createdAt };
    expect(effectiveLimits(env, limits({}), "upload_user", quota)).toEqual({
      bytes: 10_000_000_000,
      count: 2000,
    });
    expect(effectiveLimits(env, limits({ CEIL_UPLOAD_COUNT_DAY: 100 }), "upload_user", quota).count).toBe(
      500,
    );
    const huge = { quotaBytes: 30_000_000_000, createdAt: OLD.createdAt };
    expect(effectiveLimits(env, limits({}), "upload_user", huge).bytes).toBe(30_000_000_000);
  });
});

describe("link_user through consumeCeiling(…, { tx })", () => {
  it("the consume that reaches the limit succeeds; the next throws 429 and writes nothing", async () => {
    const owner = await makeUser({ createdAt: OLD.createdAt });
    const subject: CeilingSubject = { id: owner.id, account: { quotaBytes: 0, createdAt: OLD.createdAt } };
    const run = await invoke(
      null,
      async (c) => {
        const once = () =>
          retryOnDeadlock(dbOf(c), (tx) => consumeCeiling(c, "link_user", subject, { count: 1 }, { tx }));
        await once();
        await once();
        let refused: AppError | null = null;
        try {
          await once();
        } catch (error) {
          refused = error as AppError;
        }
        return { refused, totals: await todayTotals(dbOf(c), "link_user", owner.id) };
      },
      { settings: limits({ CEIL_LINKS_DAY: 2 }) },
    );
    if (!run.ok) throw new Error(run.error);
    expect(run.value.refused?.code).toBe("ceiling_exceeded");
    expect(run.value.totals.count).toBe(2);
  });
});

describe("upload_user and upload_editor through enforceUploadCeilings(…, { tx })", () => {
  it("open upload sessions count: ledger + open sessions at the limit → the next admission is 429; an editor's own bytes limit too", async () => {
    const owner = await makeUser({ createdAt: OLD.createdAt });
    const editor = await makeUser({ createdAt: OLD.createdAt });
    // One open session of 400 bytes on the owner.
    await makeUpload(owner.id, owner.id, { size: 400 });
    const account = { quotaBytes: 0, createdAt: OLD.createdAt };
    const admit = (bytes: number, withEditor = false) =>
      invoke(
        null,
        (c) =>
          retryOnDeadlock(dbOf(c), (tx) =>
            enforceUploadCeilings(
              c,
              {
                owner: { id: owner.id, account },
                ...(withEditor ? { editor: { id: editor.id, account } } : {}),
              },
              { bytes, count: 1 },
              { tx },
            ),
          ),
        { settings: limits({ CEIL_UPLOAD_BYTES_DAY: 1000, CEIL_EDITOR_UPLOAD_BYTES_DAY: 300 }) },
      );
    expect((await admit(600)).ok).toBe(true); // 400 open + 600 = 1000: at the limit, admitted
    const over = await admit(601);
    expect(over).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "upload_user" },
    });
    expect(over.headers.get("retry-after")).not.toBeNull();
    const editorOver = await admit(301, true);
    expect(editorOver).toMatchObject({ ok: false, status: 429, details: { kind: "upload_editor" } });
    expect((await admit(300, true)).ok).toBe(true);
    // Nothing was written by a refusal (the ledger of the day is untouched).
    expect((await todayTotals(testDb(), "upload_user", owner.id)).bytes).toBe(0);
  });
});
