// T22 step 8 — the limits written elsewhere, proven through the REAL routes that enforce them:
// the upload admission (T12), share and link creation (T24), the public download mint's daily
// count (T24) and the link-password throttle (D7, T24's unlock), and the three-strike suspension
// (T10's addStrike). Tests only: T22 owns none of this code. Every password, token and address
// here is made up; settings are passed in, never written.
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addUsage, todayTotals, utcDay } from "../../../src/worker/db/queries/ledger";
import { PASSWORD_FREE_ATTEMPTS, PASSWORD_LOCK_MAX_SEC } from "../../../src/worker/db/queries/links";
import { linkPasswordAttempts, shareLinks, strikes, user as userTable } from "../../../src/worker/db/schema";
import { session as authSession } from "../../../src/worker/db/auth-schema";
import { TEST_NOW_HEADER } from "../../../src/worker/services/clock";
import { ipHashStable } from "../../../src/worker/services/ip-hash";
import { addStrike } from "../../../src/worker/services/strikes";
import { STRIKES_TO_SUSPEND } from "../../../src/shared/constants";
import { mailTo, makeLink, serviceDeps } from "../auth/helpers";
import {
  api,
  asCaller,
  makeFile,
  makeFolder,
  member,
  rand,
  settingsWith,
  testDb,
  testKeys,
} from "../sharing/helpers";
import { linkTo, mint, unlock } from "../sharing/public-helpers";
import { call, initBody, ROOMY, uploader } from "../uploads/helpers";
import { freshIp } from "./helpers";

const DAY = 86_400_000;

describe("the upload admission (T12) answers 429 ceiling_exceeded with Retry-After", () => {
  it("POST /api/uploads: the daily count reached (open sessions count) → 429 with Retry-After to midnight UTC", async () => {
    // A small quota: the count does not scale above the base (floor(5,000,000 / 10,000,000) = 0).
    const user = await uploader({ quotaBytes: 5_000_000 });
    const settings = { ...ROOMY, ceilings: { ...ROOMY.ceilings, CEIL_UPLOAD_COUNT_DAY: 1 } };
    const first = await call(user, "POST", "/uploads", { json: initBody(), settings });
    expect(first.status).toBe(201);
    const second = await call(user, "POST", "/uploads", { json: initBody(), settings });
    expect(second.status).toBe(429);
    expect((second.body as { error: string }).error).toBe("ceiling_exceeded");
    const retryAfter = Number(second.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });
});

describe("share and link creation hit share_user / link_user", () => {
  it("the second share of the day with CEIL_SHARES_DAY 1 → 429; the second link with CEIL_LINKS_DAY 1 → 429", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const settings = settingsWith({ ceilings: { CEIL_SHARES_DAY: 1, CEIL_LINKS_DAY: 1 } });
    const share = (email: string) =>
      api(asCaller(owner), `/nodes/${folder.id}/shares`, { json: { email, role: "viewer" }, settings });
    expect((await share(`a-${rand()}@example.test`)).status).toBe(201);
    const refusedShare = await share(`b-${rand()}@example.test`);
    expect(refusedShare.status).toBe(429);
    expect((refusedShare.body as { error: string }).error).toBe("ceiling_exceeded");
    expect((await todayTotals(testDb(), "share_user", owner.id)).count).toBe(1);

    const link = () =>
      api(asCaller(owner), `/nodes/${folder.id}/links`, { json: { allowPreview: true }, settings });
    expect((await link()).status).toBe(201);
    const refusedLink = await link();
    expect(refusedLink.status).toBe(429);
    expect((refusedLink.body as { error: string }).error).toBe("ceiling_exceeded");
  });
});

describe("the public download mint's daily count (T24)", () => {
  it("the 1,001st download mint of a day → 429, the link NOT paused, the owner told once; inline mints never count; the first mint of the next UTC day succeeds without any job", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, {
      scanStatus: "clean",
      name: `doc-${rand()}.txt`,
      mimeSniffed: "text/plain",
    });
    const settings = settingsWith({ ceilings: { CEIL_LINK_DOWNLOADS_DAY: 1000 } });
    const made = await linkTo(owner, file.id, {}, settings);
    // A thousand downloads counted today (the link's own ledger row).
    await addUsage(testDb(), utcDay(), "link", made.id, 0, 999);
    const ip = freshIp();
    const thousandth = await mint(made.token, { kind: "download", nodeId: file.id }, { settings, ip });
    expect(thousandth.status).toBe(200);
    expect((await todayTotals(testDb(), "link", made.id)).count).toBe(1000);

    const refused = await mint(made.token, { kind: "download", nodeId: file.id }, { settings, ip });
    expect(refused.status).toBe(429);
    expect((refused.body as { error: string }).error).toBe("ceiling_exceeded");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    const [row] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, made.id));
    expect(row).toMatchObject({ pauseReasons: [], pausedAt: null, revokedAt: null });
    const limitMails = () => mailTo(owner.email).filter((m) => m.template === "linkLimitReached");
    expect(limitMails()).toHaveLength(1);
    // Refused again the same day: no second mail, still nothing paused.
    expect((await mint(made.token, { kind: "download", nodeId: file.id }, { settings, ip })).status).toBe(
      429,
    );
    expect(limitMails()).toHaveLength(1);
    // An inline mint is not a download: it is not counted, and not refused by the count.
    expect((await mint(made.token, { kind: "inline", nodeId: file.id }, { settings, ip })).status).toBe(200);
    expect((await todayTotals(testDb(), "link", made.id)).count).toBe(1000);
    // The next UTC day (this request's own clock): served again — nothing had to lift anything.
    const tomorrow = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1, 0, 5),
    );
    const next = await mint(
      made.token,
      { kind: "download", nodeId: file.id },
      { settings, ip, headers: { [TEST_NOW_HEADER]: tomorrow.toISOString() } },
    );
    expect(next.status).toBe(200);
  });
});

describe("the link-password throttle (D7, enforced inline by T24's unlock)", () => {
  const PASSWORD = "made-up link password 22";

  async function attemptsRow(linkId: string, ip: string) {
    const hash = await ipHashStable(testKeys(), ip);
    const [row] = await testDb()
      .select()
      .from(linkPasswordAttempts)
      .where(and(eq(linkPasswordAttempts.linkId, linkId), eq(linkPasswordAttempts.ipHashStable, hash)));
    return row ?? null;
  }
  const lockSeconds = (row: { lockedUntil: Date | null; lastFailureAt: Date }) =>
    row.lockedUntil === null
      ? 0
      : Math.round((row.lockedUntil.getTime() - row.lastFailureAt.getTime()) / 1000);
  async function unlockNow(linkId: string, ip: string) {
    const hash = await ipHashStable(testKeys(), ip);
    await testDb()
      .update(linkPasswordAttempts)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(and(eq(linkPasswordAttempts.linkId, linkId), eq(linkPasswordAttempts.ipHashStable, hash)));
  }

  it("twenty-one wrong passwords from one address: failures 1–3 carry no delay, the 4th locks the pair, the rest answer 429 + Retry-After WITHOUT evaluating (the right one too); the link is never paused; a second address is not slowed", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await linkTo(owner, file.id, { password: PASSWORD });
    const ipA = freshIp();
    const ipB = freshIp();
    const statuses: number[] = [];
    let lastRetryAfter = 0;
    for (let i = 0; i < 21; i++) {
      const { answer } = await unlock(made.token, `wrong guess ${i}`, { ip: ipA });
      statuses.push(answer.status);
      if (answer.status === 429) lastRetryAfter = Number(answer.headers["retry-after"]);
    }
    expect(statuses.slice(0, PASSWORD_FREE_ATTEMPTS + 1)).toEqual([403, 403, 403, 403]);
    expect(statuses.slice(PASSWORD_FREE_ATTEMPTS + 1).every((s) => s === 429)).toBe(true);
    expect(lastRetryAfter).toBeGreaterThan(0);
    // The fourth failure locked the pair for 2^(4−3) = 2 seconds.
    const row = (await attemptsRow(made.id, ipA))!;
    expect(row.failures).toBe(PASSWORD_FREE_ATTEMPTS + 1);
    expect(lockSeconds(row)).toBe(2);
    // While locked, even the right password is refused unread.
    expect((await unlock(made.token, PASSWORD, { ip: ipA })).answer.status).toBe(429);
    // The link is never paused by failures.
    const [link] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, made.id));
    expect(link).toMatchObject({ pauseReasons: [], pausedAt: null });
    // Another address is not slowed: its wrong guess is evaluated (403), its right one opens.
    expect((await unlock(made.token, "another wrong guess", { ip: ipB })).answer.status).toBe(403);
    const opened = await unlock(made.token, PASSWORD, { ip: ipB });
    expect(opened.answer.status).toBe(200);
    expect(opened.session).toBeTruthy();
    // …and its success deleted its row.
    expect(await attemptsRow(made.id, ipB)).toBeNull();
  });

  it("failure n > 3 locks for min(2^(n−3), 900) seconds; a success deletes the row", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await linkTo(owner, file.id, { password: PASSWORD });
    const ip = freshIp();
    for (let i = 0; i < PASSWORD_FREE_ATTEMPTS; i++) await unlock(made.token, `wrong ${i}`, { ip });
    expect(lockSeconds((await attemptsRow(made.id, ip))!)).toBe(0);
    await unlock(made.token, "wrong 4", { ip });
    expect(lockSeconds((await attemptsRow(made.id, ip))!)).toBe(2);
    await unlockNow(made.id, ip);
    await unlock(made.token, "wrong 5", { ip });
    expect(lockSeconds((await attemptsRow(made.id, ip))!)).toBe(4);
    // Far along: 2^(14−3) = 2048 is capped at 900.
    const hash = await ipHashStable(testKeys(), ip);
    await testDb()
      .update(linkPasswordAttempts)
      .set({ failures: 13 })
      .where(and(eq(linkPasswordAttempts.linkId, made.id), eq(linkPasswordAttempts.ipHashStable, hash)));
    await unlockNow(made.id, ip);
    await unlock(made.token, "wrong 14", { ip });
    expect(lockSeconds((await attemptsRow(made.id, ip))!)).toBe(PASSWORD_LOCK_MAX_SEC);
    await unlockNow(made.id, ip);
    expect((await unlock(made.token, PASSWORD, { ip })).answer.status).toBe(200);
    expect(await attemptsRow(made.id, ip)).toBeNull();
  });
});

describe("strikes (T10's addStrike): the third unlifted strike in 365 days suspends the uploader", () => {
  async function seeded(n: number, opts: { lifted?: number; daysAgo?: number } = {}) {
    const user = await member();
    for (let i = 0; i < n; i++) {
      await testDb()
        .insert(strikes)
        .values({
          userId: user.id,
          kind: "malware",
          nodeId: crypto.randomUUID(),
          at: new Date(Date.now() - (opts.daysAgo ?? 1) * DAY),
          liftedAt: i < (opts.lifted ?? 0) ? new Date() : null,
        });
    }
    return user;
  }
  const rowOf = async (id: string) =>
    (await testDb().select().from(userTable).where(eq(userTable.id, id)))[0]!;

  it(`the ${STRIKES_TO_SUSPEND}rd strike: suspended — its sessions gone, its links paused owner_suspended`, async () => {
    const user = await seeded(STRIKES_TO_SUSPEND - 1);
    await testDb()
      .insert(authSession)
      .values({
        id: rand(16),
        token: `made-up-${rand(16)}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + DAY),
        updatedAt: new Date(),
      });
    const file = await makeFile(user.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, user.id);
    const deps = serviceDeps();
    const result = await addStrike(deps.deps, {
      userId: user.id,
      kind: "malware",
      nodeId: crypto.randomUUID(),
      sha256: rand(32),
    });
    await deps.settle();
    expect(result).toMatchObject({ activeStrikes: STRIKES_TO_SUSPEND, suspended: true });
    expect((await rowOf(user.id)).suspendedAt).toBeInstanceOf(Date);
    expect(await testDb().select().from(authSession).where(eq(authSession.userId, user.id))).toEqual([]);
    const [linkRow] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, link.id));
    expect(linkRow!.pauseReasons).toEqual(["owner_suspended"]);
  });

  it("a lifted strike and a strike older than the window do not count: still not suspended", async () => {
    for (const user of [
      await seeded(STRIKES_TO_SUSPEND - 1, { lifted: 1 }),
      await seeded(STRIKES_TO_SUSPEND - 1, { daysAgo: 366 }),
    ]) {
      const deps = serviceDeps();
      const result = await addStrike(deps.deps, {
        userId: user.id,
        kind: "malware",
        nodeId: crypto.randomUUID(),
        sha256: rand(32),
      });
      await deps.settle();
      expect(result.suspended).toBe(false);
      expect((await rowOf(user.id)).suspendedAt).toBeNull();
    }
  });
});
