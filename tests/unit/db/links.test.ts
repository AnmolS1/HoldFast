import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { QueryError } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  clearPasswordFailures,
  consumeDownload,
  countCreatedToday,
  countLive,
  findByTokenHash,
  getById,
  logAccess,
  passwordLock,
  pauseLinks,
  recordPasswordFailure,
  unpauseLinks,
} from "../../../src/worker/db/queries/links";
import {
  linkAccessLog,
  linkPasswordAttempts,
  type PauseReason,
  shareLinks,
} from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeLink, makeUser, openDb, rand, rejection } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

async function state(linkId: string): Promise<{ reasons: PauseReason[]; pausedAt: Date | null }> {
  const link = (await getById(db, linkId))!;
  return { reasons: link.pauseReasons, pausedAt: link.pausedAt };
}

async function linked(reasons: PauseReason[] = []) {
  const owner = await makeUser(db);
  const file = await makeFile(db, owner, null, `l-${rand()}.txt`);
  const link = await makeLink(db, file.id, owner, { pauseReasons: reasons });
  return { owner, file, link };
}

describe("lookup", () => {
  it("findByTokenHash and getById return the row whatever its state", async () => {
    const { link, file, owner } = await linked(["owner"]);
    await db
      .update(shareLinks)
      .set({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shareLinks.id, link.id));
    const byHash = await findByTokenHash(db, link.tokenHash);
    expect(byHash).toMatchObject({ id: link.id, nodeId: file.id, createdBy: owner, pauseReasons: ["owner"] });
    expect(byHash!.revokedAt).toBeInstanceOf(Date);
    expect(Buffer.from(byHash!.tokenEnc).equals(Buffer.from(link.tokenEnc))).toBe(true);
    expect((await getById(db, link.id))!.tokenHash).toBe(link.tokenHash);
    expect(await findByTokenHash(db, "no-such-hash")).toBeNull();
    expect(await getById(db, uuidv7())).toBeNull();
    expect(await getById(db, "junk")).toBeNull();
  });

  it("countLive counts links that are neither revoked nor expired; countCreatedToday the UTC day's", async () => {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `c-${rand()}.txt`);
    await makeLink(db, file.id, owner);
    await makeLink(db, file.id, owner, { pauseReasons: ["ceiling"] });
    await makeLink(db, file.id, owner, { expiresAt: new Date(Date.now() + 60_000) });
    await makeLink(db, file.id, owner, { expiresAt: new Date(Date.now() - 60_000) });
    await makeLink(db, file.id, owner, { revokedAt: new Date() });
    await makeLink(db, file.id, owner, { createdAt: new Date(Date.now() - 2 * 86_400_000) });
    const live = await countLive(db, owner);
    expect(live).toBe(4);
    expect(typeof live).toBe("number");
    expect(await countCreatedToday(db, owner)).toBe(5);
    expect(await countLive(db, await makeUser(db))).toBe(0);
  });
});

describe("consumeDownload", () => {
  it("20 concurrent calls never take download_count past max_downloads", async () => {
    const { link } = await linked();
    await db.update(shareLinks).set({ maxDownloads: 3 }).where(eq(shareLinks.id, link.id));
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeDownload(db, link.id)));
    expect(results.filter(Boolean)).toHaveLength(3);
    const after = (await getById(db, link.id))!;
    expect(after.downloadCount).toBe(3);
    expect(after.downloadCount).toBeLessThanOrEqual(after.maxDownloads!);
    expect(await consumeDownload(db, link.id)).toBe(false);
  });

  it("is unlimited without a cap, and false for an unknown link", async () => {
    const { link } = await linked();
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeDownload(db, link.id)));
    expect(results.every(Boolean)).toBe(true);
    expect((await getById(db, link.id))!.downloadCount).toBe(20);
    expect(await consumeDownload(db, uuidv7())).toBe(false);
    expect(await consumeDownload(db, "junk")).toBe(false);
  });
});

describe("logAccess", () => {
  it("writes the tabled columns", async () => {
    const { link, file } = await linked();
    await logAccess(db, {
      linkId: link.id,
      nodeId: file.id,
      outcome: "ok",
      ipHashDaily: "ip-d",
      country: "DE",
      uaHash: "ua-h",
      bytes: 1234,
    });
    await logAccess(db, {
      linkId: link.id,
      nodeId: null,
      outcome: "denied_password",
      ipHashDaily: null,
      country: null,
      uaHash: null,
    });
    const rows = await db.select().from(linkAccessLog).where(eq(linkAccessLog.linkId, link.id));
    expect(rows).toHaveLength(2);
    // Ids made in the same millisecond do not order: pick the rows by outcome.
    rows.sort((x, y) => (x.outcome === "ok" ? -1 : 1) - (y.outcome === "ok" ? -1 : 1));
    expect(rows[0]).toMatchObject({
      linkId: link.id,
      nodeId: file.id,
      outcome: "ok",
      ipHashDaily: "ip-d",
      country: "DE",
      uaHash: "ua-h",
      bytes: 1234,
    });
    expect(rows[0]!.at).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({ nodeId: null, outcome: "denied_password", ipHashDaily: null, bytes: 0 });
  });
});

describe("the pause set", () => {
  it("adding a reason pauses the link; adding it again changes nothing and keeps the first pausedAt", async () => {
    const { link } = await linked();
    const first = await pauseLinks(db, { linkId: link.id }, "report");
    expect(first).toEqual([
      { linkId: link.id, nodeId: link.nodeId, ownerId: link.createdBy, newlyPaused: true },
    ]);
    const paused = await state(link.id);
    expect(paused.reasons).toEqual(["report"]);
    expect(paused.pausedAt).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(await pauseLinks(db, { linkId: link.id }, "report")).toEqual([]);
    const again = await state(link.id);
    expect(again.reasons).toEqual(["report"]);
    expect(again.pausedAt!.getTime()).toBe(paused.pausedAt!.getTime());
  });

  it("a second reason is added without touching pausedAt, and is not a new pause", async () => {
    const { link } = await linked();
    await pauseLinks(db, { linkId: link.id }, "owner_deletion");
    const before = await state(link.id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await pauseLinks(db, { linkId: link.id }, "report");
    expect(second).toEqual([
      { linkId: link.id, nodeId: link.nodeId, ownerId: link.createdBy, newlyPaused: false },
    ]);
    const after = await state(link.id);
    expect([...after.reasons].sort()).toEqual(["owner_deletion", "report"]);
    expect(after.pausedAt!.getTime()).toBe(before.pausedAt!.getTime());
  });

  it("removing one reason leaves the others: {owner_deletion, report} minus report is still paused", async () => {
    const { link } = await linked(["owner_deletion", "report"]);
    const before = await state(link.id);
    const removed = await unpauseLinks(db, { linkId: link.id }, "report");
    expect(removed).toEqual([
      { linkId: link.id, nodeId: link.nodeId, ownerId: link.createdBy, nowLive: false },
    ]);
    const after = await state(link.id);
    expect(after.reasons).toEqual(["owner_deletion"]);
    expect(after.pausedAt!.getTime()).toBe(before.pausedAt!.getTime());
  });

  it("removing the last reason clears pausedAt", async () => {
    const { link } = await linked(["owner_deletion"]);
    const removed = await unpauseLinks(db, { linkId: link.id }, "owner_deletion");
    expect(removed).toEqual([
      { linkId: link.id, nodeId: link.nodeId, ownerId: link.createdBy, nowLive: true },
    ]);
    expect(await state(link.id)).toEqual({ reasons: [], pausedAt: null });
  });

  it("removing an absent reason changes nothing", async () => {
    const { link } = await linked(["moderation"]);
    const before = await state(link.id);
    expect(await unpauseLinks(db, { linkId: link.id }, "report")).toEqual([]);
    expect(await state(link.id)).toEqual(before);
    const live = await linked();
    expect(await unpauseLinks(db, { linkId: live.link.id }, "report")).toEqual([]);
    expect(await state(live.link.id)).toEqual({ reasons: [], pausedAt: null });
  });

  it("concurrent pauses with the same reason leave one element", async () => {
    const { link } = await linked();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pauseLinks(db, { linkId: link.id }, "anomaly")),
    );
    expect(results.flat()).toHaveLength(1);
    expect((await state(link.id)).reasons).toEqual(["anomaly"]);
    const mixed = await Promise.all(
      (["report", "owner", "report", "moderation", "owner"] as const).map((r) =>
        pauseLinks(db, { linkId: link.id }, r),
      ),
    );
    expect(mixed.flat()).toHaveLength(3);
    expect([...(await state(link.id)).reasons].sort()).toEqual(["anomaly", "moderation", "owner", "report"]);
  });

  it("selects by node (that node only) and by owner", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `f-${rand()}`);
    const file = await makeFile(db, owner, folder.id, "in.txt");
    const onFolder = await makeLink(db, folder.id, owner);
    const onFile = await makeLink(db, file.id, owner);
    const second = await makeLink(db, file.id, owner);
    const theirFile = await makeFile(db, other, null, `t-${rand()}.txt`);
    const theirs = await makeLink(db, theirFile.id, other);

    const byNode = await pauseLinks(db, { nodeId: file.id }, "report");
    expect(byNode.map((c) => c.linkId).sort()).toEqual([onFile.id, second.id].sort());
    expect((await state(onFolder.id)).reasons).toEqual([]);

    const byOwner = await pauseLinks(db, { ownerId: owner }, "owner_suspended");
    expect(byOwner.map((c) => c.linkId).sort()).toEqual([onFolder.id, onFile.id, second.id].sort());
    expect(byOwner.find((c) => c.linkId === onFolder.id)!.newlyPaused).toBe(true);
    expect(byOwner.find((c) => c.linkId === onFile.id)!.newlyPaused).toBe(false);
    expect((await state(theirs.id)).reasons).toEqual([]);

    const back = await unpauseLinks(db, { ownerId: owner }, "owner_suspended");
    expect(back.filter((c) => c.nowLive).map((c) => c.linkId)).toEqual([onFolder.id]);
    expect((await state(onFile.id)).reasons).toEqual(["report"]);
    expect(await pauseLinks(db, { linkId: "junk" }, "report")).toEqual([]);
    expect(await unpauseLinks(db, { nodeId: "junk" }, "report")).toEqual([]);
  });

  it("unpauseLinks({ all: true }, 'ceiling') removes ceiling only and leaves lockedByAdmin rows alone", async () => {
    const onlyCeiling = await linked(["ceiling"]);
    const both = await linked(["ceiling", "report"]);
    const anomaly = await linked(["anomaly"]);
    const locked = await linked(["ceiling"]);
    await db.update(shareLinks).set({ lockedByAdmin: true }).where(eq(shareLinks.id, locked.link.id));

    const changed = await unpauseLinks(db, { all: true }, "ceiling");
    const mine = changed.filter((c) =>
      [onlyCeiling.link.id, both.link.id, anomaly.link.id, locked.link.id].includes(c.linkId),
    );
    expect(mine.map((c) => [c.linkId, c.nowLive]).sort()).toEqual(
      [
        [onlyCeiling.link.id, true],
        [both.link.id, false],
      ].sort(),
    );
    expect(mine.find((c) => c.linkId === onlyCeiling.link.id)!.ownerId).toBe(onlyCeiling.owner);

    expect(await state(onlyCeiling.link.id)).toEqual({ reasons: [], pausedAt: null });
    const stillPaused = await state(both.link.id);
    expect(stillPaused.reasons).toEqual(["report"]);
    expect(stillPaused.pausedAt).not.toBeNull();
    expect((await state(anomaly.link.id)).reasons).toEqual(["anomaly"]);
    expect((await state(locked.link.id)).reasons).toEqual(["ceiling"]);
    // No link is left with `ceiling` except admin-locked ones.
    const left = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM share_links WHERE 'ceiling' = ANY(pause_reasons) AND NOT locked_by_admin`,
    );
    expect(left.rows[0]!.n).toBe(0);
  });

  it("rejects an unknown reason before touching the database", async () => {
    const { link } = await linked();
    const error = await rejection(pauseLinks(db, { linkId: link.id }, "whatever" as PauseReason));
    expect((error as QueryError).code).toBe("validation");
    expect(((await rejection(unpauseLinks(db, { all: true }, "x" as PauseReason))) as QueryError).code).toBe(
      "validation",
    );
  });
});

describe("the password throttle", () => {
  it("a link id that is malformed or does not exist records nothing and does not throw", async () => {
    const ip = `ip-${rand()}`;
    expect(await recordPasswordFailure(db, "not-a-uuid", ip)).toBeNull();
    expect(await recordPasswordFailure(db, "", ip)).toBeNull();
    expect(await recordPasswordFailure(db, uuidv7(), ip)).toBeNull();
    // Inside a caller's transaction the refusal leaves the transaction usable.
    await db.transaction(async (tx) => {
      expect(await recordPasswordFailure(tx, uuidv7(), ip)).toBeNull();
      expect(await recordPasswordFailure(tx, "junk", ip)).toBeNull();
      expect((await tx.execute(sql`SELECT 1 AS one`)).rows).toEqual([{ one: 1 }]);
    });
    expect(
      await db.select().from(linkPasswordAttempts).where(eq(linkPasswordAttempts.ipHashStable, ip)),
    ).toEqual([]);
  });

  it("three free failures, then min(2^(n-3), 900) seconds; a success clears the pair; the link is never paused", async () => {
    const { link } = await linked();
    const ip = `ip-${rand()}`;
    expect(await passwordLock(db, link.id, ip)).toBeNull();
    for (let n = 1; n <= 3; n++) {
      expect(await recordPasswordFailure(db, link.id, ip)).toEqual({ failures: n, lockedUntil: null });
      expect(await passwordLock(db, link.id, ip)).toBeNull();
    }
    const expected = [2, 4, 8, 16, 32, 64, 128, 256, 512, 900, 900];
    for (let i = 0; i < expected.length; i++) {
      const result = (await recordPasswordFailure(db, link.id, ip))!;
      expect(result.failures).toBe(4 + i);
      const seconds = (result.lockedUntil!.getTime() - Date.now()) / 1000;
      expect(seconds, `failure ${4 + i}`).toBeGreaterThan(expected[i]! - 2);
      expect(seconds, `failure ${4 + i}`).toBeLessThanOrEqual(expected[i]! + 1);
    }
    const lock = await passwordLock(db, link.id, ip);
    expect(lock!.retryAfterSec).toBeGreaterThan(895);
    expect(lock!.retryAfterSec).toBeLessThanOrEqual(900);
    expect(lock!.lockedUntil).toBeInstanceOf(Date);
    // Another address on the same link is not affected, and the link itself is not paused.
    expect(await passwordLock(db, link.id, "someone-else")).toBeNull();
    expect((await getById(db, link.id))!.pauseReasons).toEqual([]);

    await clearPasswordFailures(db, link.id, ip);
    expect(await passwordLock(db, link.id, ip)).toBeNull();
    expect(await recordPasswordFailure(db, link.id, ip)).toEqual({ failures: 1, lockedUntil: null });
  });

  it("an expired lock is no lock, and a pair idle for 24 hours starts again", async () => {
    const { link } = await linked();
    const ip = `ip-${rand()}`;
    for (let n = 0; n < 6; n++) await recordPasswordFailure(db, link.id, ip);
    const where = sql`${linkPasswordAttempts.linkId} = ${link.id} AND ${linkPasswordAttempts.ipHashStable} = ${ip}`;
    await db
      .update(linkPasswordAttempts)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(where);
    expect(await passwordLock(db, link.id, ip)).toBeNull();
    expect((await recordPasswordFailure(db, link.id, ip))!.failures).toBe(7);
    await db
      .update(linkPasswordAttempts)
      .set({ lastFailureAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(where);
    expect(await recordPasswordFailure(db, link.id, ip)).toEqual({ failures: 1, lockedUntil: null });
  });

  it("concurrent failures are all counted", async () => {
    const { link } = await linked();
    const ip = `ip-${rand()}`;
    await Promise.all(Array.from({ length: 10 }, () => recordPasswordFailure(db, link.id, ip)));
    const [row] = await db
      .select()
      .from(linkPasswordAttempts)
      .where(eq(linkPasswordAttempts.linkId, link.id));
    expect(row!.failures).toBe(10);
  });
});
