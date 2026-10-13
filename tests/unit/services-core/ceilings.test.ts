// Daily ceilings: the limit arithmetic as a table, then each kind at its boundary inside real
// requests against the real ledger.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CEILING_KEYS } from "../../../src/shared/constants";
import { todayTotals } from "../../../src/worker/db/queries/ledger";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { shareLinks } from "../../../src/worker/db/schema";
import {
  CEILING_KINDS,
  checkCeiling,
  consumeCeiling,
  effectiveLimits,
  recordUsage,
  type CeilingKind,
  type CeilingSubject,
} from "../../../src/worker/services/ceilings";
import { makeLink } from "../auth/helpers";
import { makeFolder, makeUpload, makeUser, rand, testDb } from "./helpers";
import { invoke, value, type InvokeOptions } from "./request";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const OLD = { quotaBytes: 5_000_000_000, createdAt: new Date("2025-01-01T00:00:00.000Z") };
const NEW = { quotaBytes: 5_000_000_000, createdAt: new Date("2026-10-10T00:00:00.000Z") };
const none: Pick<Settings, "ceilings"> = {};
/** A fresh ledger subject: no other test or run has counted against it. */
const subjectId = () => `ceil-${rand(8)}`;

describe("effectiveLimits", () => {
  it("reads the vars (decimal byte limits), never a literal of its own", () => {
    const limits = (kind: CeilingKind) => effectiveLimits(env, none, kind, { ...OLD, quotaBytes: 0 }, NOW);
    expect(limits("download_user")).toEqual({ bytes: 20_000_000_000 });
    expect(limits("download_link")).toEqual({ bytes: 20_000_000_000, count: 1000 });
    expect(effectiveLimits(env, none, "download_ip", undefined, NOW)).toEqual({ bytes: 50_000_000_000 });
    expect(limits("download_owner")).toEqual({ bytes: 100_000_000_000 });
    expect(env.CEIL_OWNER_LINK_BYTES_DAY).toBe("100000000000");
    expect(limits("upload_user")).toEqual({ bytes: 10_000_000_000, count: 2000 });
    expect(limits("upload_editor")).toEqual({ bytes: 2_000_000_000 });
    expect(limits("transform_user")).toEqual({ count: 2000 });
    expect(limits("share_user")).toEqual({ count: 200 });
    expect(limits("link_user")).toEqual({ count: 100 });
    expect(CEILING_KINDS).toHaveLength(9);
    // Another environment's values are what it answers with.
    const other = { ...env, CEIL_SHARES_DAY: "7", CEIL_USER_BYTES_DAY: "123" };
    expect(effectiveLimits(other, none, "share_user", OLD, NOW)).toEqual({ count: 7 });
    expect(effectiveLimits(other, none, "download_user", { ...OLD, quotaBytes: 0 }, NOW)).toEqual({
      bytes: 123,
    });
  });

  it("scales the per-user limits with the quota and nothing else", () => {
    const big = { ...OLD, quotaBytes: 3_000_000_000_000 };
    expect(effectiveLimits(env, none, "download_user", big, NOW)).toEqual({ bytes: 3_000_000_000_000 });
    expect(effectiveLimits(env, none, "upload_user", big, NOW)).toEqual({
      bytes: 3_000_000_000_000,
      count: 300_000,
    });
    // One file a day per 10,000,000 bytes of quota (decimal): 5,000,000,000 bytes give 500 —
    // which the base of 2,000 exceeds, so it shows only once the base is lower.
    const lowBase = { ceilings: { CEIL_UPLOAD_COUNT_DAY: 100 } };
    expect(effectiveLimits(env, lowBase, "upload_user", OLD, NOW).count).toBe(500);
    expect(effectiveLimits(env, lowBase, "upload_user", { ...OLD, quotaBytes: 9_999_999 }, NOW).count).toBe(
      100,
    );
    expect(
      effectiveLimits(env, lowBase, "upload_user", { ...OLD, quotaBytes: 1_010_000_000 }, NOW).count,
    ).toBe(101);
    // A quota below the base leaves the base.
    expect(effectiveLimits(env, none, "download_user", OLD, NOW)).toEqual({ bytes: 20_000_000_000 });
    expect(effectiveLimits(env, none, "upload_user", OLD, NOW)).toEqual({
      bytes: 10_000_000_000,
      count: 2000,
    });
    // Link, editor, transform, share and link-creation limits never scale.
    expect(effectiveLimits(env, none, "download_link", big, NOW)).toEqual({
      bytes: 20_000_000_000,
      count: 1000,
    });
    expect(effectiveLimits(env, none, "upload_editor", big, NOW)).toEqual({ bytes: 2_000_000_000 });
    // The owner-wide link limit protects against strangers too: it does not grow with the quota.
    expect(effectiveLimits(env, none, "download_owner", big, NOW)).toEqual({ bytes: 100_000_000_000 });
    expect(effectiveLimits(env, none, "transform_user", big, NOW)).toEqual({ count: 2000 });
    expect(effectiveLimits(env, none, "share_user", big, NOW)).toEqual({ count: 200 });
    expect(effectiveLimits(env, none, "link_user", big, NOW)).toEqual({ count: 100 });
  });

  it("applies the new-account factor after scaling, while the account is younger than 7 days", () => {
    expect(env.NEW_ACCOUNT_DAYS).toBe("7");
    expect(env.NEW_ACCOUNT_FACTOR).toBe("0.25");
    expect(effectiveLimits(env, none, "download_user", NEW, NOW)).toEqual({ bytes: 5_000_000_000 });
    expect(effectiveLimits(env, none, "download_link", NEW, NOW)).toEqual({
      bytes: 5_000_000_000,
      count: 250,
    });
    expect(effectiveLimits(env, none, "upload_user", NEW, NOW)).toEqual({ bytes: 2_500_000_000, count: 500 });
    expect(effectiveLimits(env, none, "download_owner", NEW, NOW)).toEqual({ bytes: 25_000_000_000 });
    expect(
      effectiveLimits(env, { ceilings: { CEIL_OWNER_LINK_BYTES_DAY: 4000 } }, "download_owner", OLD, NOW),
    ).toEqual({
      bytes: 4000,
    });
    expect(
      effectiveLimits(env, { ceilings: { CEIL_OWNER_LINK_BYTES_DAY: 4000 } }, "download_owner", NEW, NOW),
    ).toEqual({
      bytes: 1000,
    });
    expect(effectiveLimits(env, none, "upload_editor", NEW, NOW)).toEqual({ bytes: 500_000_000 });
    expect(effectiveLimits(env, none, "transform_user", NEW, NOW)).toEqual({ count: 500 });
    expect(effectiveLimits(env, none, "share_user", NEW, NOW)).toEqual({ count: 50 });
    expect(effectiveLimits(env, none, "link_user", NEW, NOW)).toEqual({ count: 25 });
    // Scaling first, then the factor.
    const bigNew = { ...NEW, quotaBytes: 100_000_000_000 };
    expect(effectiveLimits(env, none, "download_user", bigNew, NOW)).toEqual({ bytes: 25_000_000_000 });
    // The boundary: one millisecond short of seven days is new; exactly seven days is not.
    const at = (ms: number) => ({ ...OLD, createdAt: new Date(NOW.getTime() - ms) });
    const week = 7 * 86_400_000;
    expect(effectiveLimits(env, none, "share_user", at(week - 1), NOW)).toEqual({ count: 50 });
    expect(effectiveLimits(env, none, "share_user", at(week), NOW)).toEqual({ count: 200 });
    // An unreadable creation time is a new account.
    expect(effectiveLimits(env, none, "share_user", { ...OLD, createdAt: new Date("nope") }, NOW)).toEqual({
      count: 50,
    });
  });

  it("the address limit has no account and no factor", () => {
    expect(effectiveLimits(env, none, "download_ip", NEW, NOW)).toEqual({ bytes: 50_000_000_000 });
    expect(effectiveLimits(env, none, "download_ip", undefined, NOW)).toEqual({ bytes: 50_000_000_000 });
  });

  it("every other kind refuses to answer without the account", () => {
    for (const kind of CEILING_KINDS.filter((k) => k !== "download_ip")) {
      expect(() => effectiveLimits(env, none, kind, undefined, NOW), kind).toThrow("needs the account");
    }
  });

  it("settings.ceilings overrides a var key by key, including the new-account settings", () => {
    const stored = { ceilings: { CEIL_SHARES_DAY: 10, NEW_ACCOUNT_FACTOR: 0.5, NEW_ACCOUNT_DAYS: 1 } };
    expect(effectiveLimits(env, stored, "share_user", OLD, NOW)).toEqual({ count: 10 });
    // NEW is two and a half days old: no longer new once NEW_ACCOUNT_DAYS is 1.
    expect(effectiveLimits(env, stored, "share_user", NEW, NOW)).toEqual({ count: 10 });
    const fresh = { ...NEW, createdAt: new Date(NOW.getTime() - 3_600_000) };
    expect(effectiveLimits(env, stored, "share_user", fresh, NOW)).toEqual({ count: 5 });
    // A key that is not overridden still comes from the var.
    expect(effectiveLimits(env, stored, "link_user", OLD, NOW)).toEqual({ count: 100 });
    expect(
      effectiveLimits(
        env,
        { ceilings: { CEIL_USER_BYTES_DAY: 0 } },
        "download_user",
        { ...OLD, quotaBytes: 0 },
        NOW,
      ),
    ).toEqual({
      bytes: 0,
    });
    // Every limit this file reads is a key the settings contract accepts.
    for (const key of Object.keys(stored.ceilings)) expect(CEILING_KEYS).toContain(key);
  });

  it("fails closed: a var that is missing or not a number is a limit of 0", () => {
    for (const bad of ["", "ten", undefined, "-5", "NaN", "Infinity"]) {
      const broken = { ...env, CEIL_SHARES_DAY: bad as string, CEIL_IP_BYTES_DAY: bad as string };
      expect(effectiveLimits(broken, none, "share_user", OLD, NOW), String(bad)).toEqual({ count: 0 });
      expect(effectiveLimits(broken, none, "download_ip", undefined, NOW), String(bad)).toEqual({ bytes: 0 });
    }
    // An unreadable factor shrinks a new account's limit to nothing; an old account is unaffected.
    const noFactor = { ...env, NEW_ACCOUNT_FACTOR: "a quarter" };
    expect(effectiveLimits(noFactor, none, "share_user", NEW, NOW)).toEqual({ count: 0 });
    expect(effectiveLimits(noFactor, none, "share_user", OLD, NOW)).toEqual({ count: 200 });
    // An unreadable age threshold treats every account as new; a factor above 1 never raises a limit.
    expect(effectiveLimits({ ...env, NEW_ACCOUNT_DAYS: "" }, none, "share_user", OLD, NOW)).toEqual({
      count: 50,
    });
    expect(effectiveLimits({ ...env, NEW_ACCOUNT_FACTOR: "3" }, none, "share_user", NEW, NOW)).toEqual({
      count: 200,
    });
  });
});

/** Small limits, so that a boundary is a handful of units. Quota 0: no scaling in the way. */
const SMALL: Settings = {
  ceilings: {
    CEIL_USER_BYTES_DAY: 1000,
    CEIL_LINK_BYTES_DAY: 1000,
    CEIL_LINK_DOWNLOADS_DAY: 3,
    CEIL_IP_BYTES_DAY: 1000,
    CEIL_OWNER_LINK_BYTES_DAY: 1000,
    CEIL_UPLOAD_BYTES_DAY: 1000,
    CEIL_UPLOAD_COUNT_DAY: 3,
    CEIL_EDITOR_UPLOAD_BYTES_DAY: 1000,
    CEIL_TRANSFORMS_DAY: 3,
    CEIL_SHARES_DAY: 3,
    CEIL_LINKS_DAY: 3,
  },
};
const small: InvokeOptions = { settings: SMALL };
const oldAccount = { quotaBytes: 0, createdAt: OLD.createdAt };

describe("checkCeiling at the boundary", () => {
  const cases: { kind: CeilingKind; dimension: "bytes" | "count"; limit: number; needsUser?: boolean }[] = [
    { kind: "download_user", dimension: "bytes", limit: 1000 },
    { kind: "download_link", dimension: "bytes", limit: 1000 },
    { kind: "download_link", dimension: "count", limit: 3 },
    { kind: "download_ip", dimension: "bytes", limit: 1000 },
    { kind: "download_owner", dimension: "bytes", limit: 1000 },
    { kind: "upload_user", dimension: "bytes", limit: 1000, needsUser: true },
    { kind: "upload_user", dimension: "count", limit: 3, needsUser: true },
    { kind: "upload_editor", dimension: "bytes", limit: 1000, needsUser: true },
    { kind: "transform_user", dimension: "count", limit: 3 },
    { kind: "share_user", dimension: "count", limit: 3 },
    { kind: "link_user", dimension: "count", limit: 3, needsUser: true },
  ];

  it.each(cases)("$kind $dimension: used + amount = limit passes, one more is refused", async (kase) => {
    const id = kase.needsUser ? (await makeUser()).id : subjectId();
    const subject: CeilingSubject = {
      id,
      ...(kase.kind === "download_ip" ? {} : { account: oldAccount }),
    };
    // The kind is a variable here, so the amount is too: the per-kind types are tested elsewhere.
    const amount = (n: number) => ({ [kase.dimension]: n }) as never;
    const used = kase.limit - 1;

    const seen = await value(
      null,
      async (c) => {
        const empty = await checkCeiling(c, kase.kind, subject, amount(kase.limit));
        const overEmpty = await checkCeiling(c, kase.kind, subject, amount(kase.limit + 1));
        await recordUsage(c, kase.kind, id, amount(used));
        return {
          empty,
          overEmpty,
          exact: await checkCeiling(c, kase.kind, subject, amount(1)),
          over: await checkCeiling(c, kase.kind, subject, amount(2)),
          zero: await checkCeiling(c, kase.kind, subject, amount(0)),
        };
      },
      small,
    );
    expect(seen.empty).toEqual({ ok: true });
    expect(seen.overEmpty).toMatchObject({
      ok: false,
      dimension: kase.dimension,
      limit: kase.limit,
      used: 0,
    });
    expect(seen.exact).toEqual({ ok: true });
    expect(seen.over).toMatchObject({
      ok: false,
      kind: kase.kind,
      dimension: kase.dimension,
      limit: kase.limit,
      used,
    });
    expect(seen.zero).toEqual({ ok: true });
  });

  it("the ledger subjects are separate: one kind's usage is not another's", async () => {
    const id = (await makeUser()).id;
    const subject = { id, account: oldAccount };
    const seen = await value(
      null,
      async (c) => {
        await recordUsage(c, "download_user", id, { bytes: 1000 });
        await recordUsage(c, "upload_editor", id, { bytes: 1000 });
        await recordUsage(c, "share_user", id, { count: 3 });
        return {
          transform: await checkCeiling(c, "transform_user", subject, { count: 3 }),
          link: await checkCeiling(c, "link_user", subject, { count: 3 }),
          upload: await checkCeiling(c, "upload_user", subject, { bytes: 1000, count: 3 }),
          download: await checkCeiling(c, "download_user", subject, { bytes: 1 }),
          share: await checkCeiling(c, "share_user", subject, { count: 1 }),
        };
      },
      small,
    );
    expect(seen.transform).toEqual({ ok: true });
    expect(seen.link).toEqual({ ok: true });
    expect(seen.upload).toEqual({ ok: true });
    expect(seen.download).toMatchObject({ ok: false, dimension: "bytes" });
    expect(seen.share).toMatchObject({ ok: false, dimension: "count" });
  });

  it("uses the request's settings and the account's quota and age", async () => {
    const id = subjectId();
    const check = (account: CeilingSubject["account"], bytes: number, options: InvokeOptions = small) =>
      value(null, (c) => checkCeiling(c, "download_user", { id, account }, { bytes }), options);
    // Scaling: a quota above the base is the limit.
    expect(await check({ ...oldAccount, quotaBytes: 5000 }, 5000)).toEqual({ ok: true });
    expect(await check({ ...oldAccount, quotaBytes: 5000 }, 5001)).toMatchObject({ ok: false, limit: 5000 });
    // The new-account factor: a quarter of it.
    const fresh = { quotaBytes: 0, createdAt: new Date() };
    expect(await check(fresh, 250)).toEqual({ ok: true });
    expect(await check(fresh, 251)).toMatchObject({ ok: false, limit: 250 });
    // Without an override: the var.
    expect(await check(oldAccount, 20_000_000_000, {})).toEqual({ ok: true });
    expect(await check(oldAccount, 20_000_000_001, {})).toMatchObject({ ok: false, limit: 20_000_000_000 });
    // The account's age is measured with the request's clock.
    const born = { quotaBytes: 0, createdAt: new Date("2026-10-01T00:00:00.000Z") };
    const atDay = (day: string) => ({
      ...small,
      headers: { "x-holdfast-test-now": `2026-10-${day}T00:00:00.000Z` },
    });
    expect(await check(born, 251, atDay("07"))).toMatchObject({ ok: false, limit: 250 });
    expect(await check(born, 251, atDay("08"))).toEqual({ ok: true });
  });

  it("a negative or fractional amount is a validation error, never a pass", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    for (const amount of [{ bytes: -1 }, { bytes: 1.5 }, { bytes: Number.NaN }, { bytes: Infinity }]) {
      expect(
        await invoke(null, (c) => checkCeiling(c, "download_user", subject, amount), small),
      ).toMatchObject({
        ok: false,
        status: 400,
        error: "validation",
      });
    }
  });
});

describe("open uploads count", () => {
  it("upload_user: the bytes and count of open and completing sessions into the owner's tree are used", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const subject = { id: owner.id, account: oldAccount };
    const check = (amount: { bytes: number; count?: number } | { count: number }) =>
      value(null, (c) => checkCeiling(c, "upload_user", subject, amount), small);

    // The control: with nothing open the whole limit is free.
    expect(await check({ bytes: 1000, count: 3 })).toEqual({ ok: true });

    // An editor's open session into the owner's tree pins the OWNER's day.
    await makeUpload(owner.id, editor.id, { size: 600, status: "open" });
    expect(await check({ bytes: 400, count: 1 })).toEqual({ ok: true });
    expect(await check({ bytes: 401, count: 1 })).toMatchObject({
      ok: false,
      dimension: "bytes",
      limit: 1000,
      used: 600,
    });
    await makeUpload(owner.id, owner.id, { size: 100, status: "completing" });
    expect(await check({ bytes: 300, count: 1 })).toEqual({ ok: true });
    expect(await check({ bytes: 301 })).toMatchObject({ ok: false, used: 700 });
    // Two sessions are open: one more file fits the count of 3, two do not.
    expect(await check({ count: 1 })).toEqual({ ok: true });
    expect(await check({ count: 2 })).toMatchObject({ ok: false, dimension: "count", limit: 3, used: 2 });

    // Finished and aborted sessions, and avatar uploads, are not open work.
    await makeUpload(owner.id, owner.id, { size: 5000, status: "done" });
    await makeUpload(owner.id, owner.id, { size: 5000, status: "aborted" });
    await makeUpload(owner.id, owner.id, { size: 5000, status: "open", purpose: "avatar" });
    expect(await check({ bytes: 300, count: 1 })).toEqual({ ok: true });

    // Ledger and open work add up.
    await value(null, (c) => recordUsage(c, "upload_user", owner.id, { bytes: 200, count: 1 }), small);
    expect(await check({ bytes: 100 })).toEqual({ ok: true });
    expect(await check({ bytes: 101 })).toMatchObject({ ok: false, used: 900 });
    expect(await check({ count: 1 })).toMatchObject({ ok: false, dimension: "count", used: 3 });
  });

  it("upload_editor: only the editor's sessions in OTHER owners' trees are used", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const subject = { id: editor.id, account: oldAccount };
    const check = (bytes: number) =>
      value(null, (c) => checkCeiling(c, "upload_editor", subject, { bytes }), small);
    expect(await check(1000)).toEqual({ ok: true });
    // The editor's uploads into their OWN tree are not "editor uploads".
    await makeUpload(editor.id, editor.id, { size: 900, status: "open" });
    expect(await check(1000)).toEqual({ ok: true });
    await makeUpload(owner.id, editor.id, { size: 700, status: "open" });
    expect(await check(300)).toEqual({ ok: true });
    expect(await check(301)).toMatchObject({ ok: false, dimension: "bytes", limit: 1000, used: 700 });
  });
});

describe("link_user: the new-account cap on live links", () => {
  const withCap: InvokeOptions = {
    settings: { ceilings: { ...SMALL.ceilings, NEW_ACCOUNT_MAX_LINKS: 2, CEIL_LINKS_DAY: 100 } },
  };

  it("a young account is refused once it has NEW_ACCOUNT_MAX_LINKS live links; an old one is not", async () => {
    const young = await makeUser();
    const folder = await makeFolder(young.id);
    const account = { quotaBytes: 0, createdAt: new Date() };
    const check = (who: CeilingSubject) =>
      value(null, (c) => checkCeiling(c, "link_user", who, { count: 1 }), withCap);

    await makeLink(folder.id, young.id);
    expect(await check({ id: young.id, account })).toEqual({ ok: true });
    await makeLink(folder.id, young.id);
    const refused = await check({ id: young.id, account });
    expect(refused).toMatchObject({ ok: false, kind: "link_user", dimension: "count", limit: 2, used: 2 });
    expect(refused.ok === false && refused.retryAfterSec).toBeGreaterThan(0);
    // The control: the same two links under an OLD account are no reason to refuse.
    expect(await check({ id: young.id, account: oldAccount })).toEqual({ ok: true });

    // A revoked link is not live: there is room again.
    const [one] = await testDb().select().from(shareLinks).where(eq(shareLinks.createdBy, young.id)).limit(1);
    await testDb().update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, one!.id));
    expect(await check({ id: young.id, account })).toEqual({ ok: true });
  });

  it("the cap comes from the var when there is no override (10)", async () => {
    expect(env.NEW_ACCOUNT_MAX_LINKS).toBe("10");
    const young = await makeUser();
    const folder = await makeFolder(young.id);
    const account = { quotaBytes: 0, createdAt: new Date() };
    for (let i = 0; i < 9; i++) await makeLink(folder.id, young.id);
    const check = () =>
      value(null, (c) => checkCeiling(c, "link_user", { id: young.id, account }, { count: 1 }));
    expect(await check()).toEqual({ ok: true });
    await makeLink(folder.id, young.id);
    expect(await check()).toMatchObject({ ok: false, limit: 10, used: 10 });
  });
});

describe("refusals", () => {
  it("a refusal is 429 ceiling_exceeded with details and Retry-After to 00:00 UTC", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const at = (iso: string): InvokeOptions => ({ ...small, headers: { "x-holdfast-test-now": iso } });
    const refused = await invoke(
      null,
      (c) => consumeCeiling(c, "transform_user", subject, { count: 4 }),
      at("2026-10-12T23:59:30.000Z"),
    );
    expect(refused).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "transform_user", dimension: "count" },
    });
    expect(refused.headers.get("retry-after")).toBe("30");
    const midday = await invoke(
      null,
      (c) => consumeCeiling(c, "transform_user", subject, { count: 4 }),
      at("2026-10-12T12:00:00.000Z"),
    );
    expect(midday.headers.get("retry-after")).toBe("43200");
    const midnight = await invoke(
      null,
      (c) => consumeCeiling(c, "transform_user", subject, { count: 4 }),
      at("2026-10-12T00:00:00.000Z"),
    );
    expect(midnight.headers.get("retry-after")).toBe("86400");
    // The control: within the limit nothing is thrown.
    expect(
      await invoke(null, (c) => consumeCeiling(c, "transform_user", subject, { count: 3 }), small),
    ).toMatchObject({
      ok: true,
    });
  });
});

describe("recordUsage and consumeCeiling", () => {
  it("recordUsage adds bytes and count to today's row of the kind's subject", async () => {
    const id = subjectId();
    await value(null, async (c) => {
      await recordUsage(c, "download_link", id, { bytes: 100, count: 1 });
      await recordUsage(c, "download_link", id, { bytes: 50 });
      await recordUsage(c, "download_ip", id, { bytes: 7 });
    });
    expect(await todayTotals(testDb(), "link", id)).toEqual({ bytes: 150, count: 1 });
    expect(await todayTotals(testDb(), "ip", id)).toEqual({ bytes: 7, count: 0 });
    expect(await todayTotals(testDb(), "user", id)).toEqual({ bytes: 0, count: 0 });
  });

  it("consumeCeiling checks and records in one step, and refuses with the same 429", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    for (let i = 0; i < 3; i++) {
      expect(
        await invoke(null, (c) => consumeCeiling(c, "share_user", subject, { count: 1 }), small),
      ).toMatchObject({
        ok: true,
      });
    }
    const refused = await invoke(null, (c) => consumeCeiling(c, "share_user", subject, { count: 1 }), small);
    expect(refused).toMatchObject({
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "share_user", dimension: "count" },
    });
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await todayTotals(testDb(), "share_user", subject.id)).toEqual({ bytes: 0, count: 3 });
  });

  it("requests that run together cannot take a consumed counter past its limit", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        invoke(null, (c) => consumeCeiling(c, "share_user", subject, { count: 1 }), small),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok).every((result) => result.status === 429)).toBe(true);
    expect(await todayTotals(testDb(), "share_user", subject.id)).toEqual({ bytes: 0, count: 3 });
  });
});
