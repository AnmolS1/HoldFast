// The small modules: ledger, email ledger, blocklist, settings, audit, upload IPs, users, and
// the filename stub.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { decodeCursor, encodeCursor } from "../../../src/worker/db/cursor";
import { QueryError } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import { insertAudit } from "../../../src/worker/db/queries/audit";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { tryConsume } from "../../../src/worker/db/queries/email-ledger";
import { addUsage, addUsageIfUnder, todayTotals, utcDay } from "../../../src/worker/db/queries/ledger";
import { clearSettingsCache, getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import * as uploadIps from "../../../src/worker/db/queries/upload-ips";
import { isActive, revokeAllSessions, termsVersionOf, userState } from "../../../src/worker/db/queries/users";
import {
  auditLog,
  downloadLedger,
  emailLedger,
  session,
  settings,
  uploadIps as uploadIpsTable,
  user,
} from "../../../src/worker/db/schema";
import { extOf, nameKeyOf, sanitizeName } from "../../../src/worker/services/filename";
import { baId, makeFile, makeUser, openDb, rand, rejection } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

describe("ledger", () => {
  // `todayTotals` → compare → `addUsage` lets every concurrent request through on the same stale
  // total. The conditional add is one statement: the ceiling holds under any concurrency.
  it("addUsageIfUnder never passes a ceiling, however many requests race", async () => {
    const today = utcDay();
    const byBytes = `ceil-b-${rand()}`;
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        addUsageIfUnder(db, today, "user", byBytes, { bytes: 10 }, { bytes: 100 }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await todayTotals(db, "user", byBytes)).toEqual({ bytes: 100, count: 10 });

    const byCount = `ceil-c-${rand()}`;
    const counted = await Promise.all(
      Array.from({ length: 30 }, () => addUsageIfUnder(db, today, "ip", byCount, { bytes: 7 }, { count: 5 })),
    );
    expect(counted.filter(Boolean)).toHaveLength(5);
    expect(await todayTotals(db, "ip", byCount)).toEqual({ bytes: 35, count: 5 });
  });

  it("addUsageIfUnder: the exact ceiling fits, one more does not, and a refusal writes nothing", async () => {
    const today = utcDay();
    const subject = `ceil-x-${rand()}`;
    // The very first add is checked too (there is no row yet to compare with).
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 101 }, { bytes: 100 })).toBe(false);
    expect(await todayTotals(db, "user", subject)).toEqual({ bytes: 0, count: 0 });
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 60 }, { bytes: 100 })).toBe(true);
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 41 }, { bytes: 100 })).toBe(false);
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 40 }, { bytes: 100 })).toBe(true);
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 0, count: 0 }, { bytes: 100 })).toBe(
      true,
    );
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 1 }, { bytes: 100 })).toBe(false);
    expect(await todayTotals(db, "user", subject)).toEqual({ bytes: 100, count: 2 });
    // Both ceilings at once; no ceiling at all behaves like addUsage.
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 0 }, { bytes: 100, count: 2 })).toBe(
      false,
    );
    expect(await addUsageIfUnder(db, today, "user", subject, { bytes: 5 }, {})).toBe(true);
    expect(await todayTotals(db, "user", subject)).toEqual({ bytes: 105, count: 3 });
    await expect(addUsageIfUnder(db, today, "user", subject, { bytes: -1 }, {})).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("addUsage creates the row, then adds; todayTotals reads the UTC day", async () => {
    const subject = `user-${rand()}`;
    expect(await todayTotals(db, "user", subject)).toEqual({ bytes: 0, count: 0 });
    const today = utcDay();
    await addUsage(db, today, "user", subject, 1000);
    await addUsage(db, today, "user", subject, 500, 2);
    await addUsage(db, today, "user", subject, 250, 0);
    const totals = await todayTotals(db, "user", subject);
    expect(totals).toEqual({ bytes: 1750, count: 3 });
    expect(typeof totals.bytes).toBe("number");
    // The database agrees with the application about which day it is.
    const dbDay = await db.execute<{ day: string }>(
      sql`SELECT (now() AT TIME ZONE 'UTC')::date::text AS day`,
    );
    expect(dbDay.rows[0]!.day).toBe(today);
  });

  it("keeps subjects, subject types and days apart", async () => {
    const subject = `ip-${rand()}`;
    const today = utcDay();
    const yesterday = utcDay(new Date(Date.now() - 86_400_000));
    await addUsage(db, today, "ip", subject, 10);
    await addUsage(db, today, "signup_ip", subject, 0, 1);
    await addUsage(db, yesterday, "ip", subject, 99_999, 7);
    await addUsage(db, today, "ip", `${subject}-other`, 5);
    expect(await todayTotals(db, "ip", subject)).toEqual({ bytes: 10, count: 1 });
    expect(await todayTotals(db, "signup_ip", subject)).toEqual({ bytes: 0, count: 1 });
    expect(await todayTotals(db, "link", subject)).toEqual({ bytes: 0, count: 0 });
    expect(utcDay(new Date("2026-03-01T23:59:59.999Z"))).toBe("2026-03-01");
    expect(utcDay(new Date("2026-03-02T00:00:00.000Z"))).toBe("2026-03-02");
  });

  it("50 concurrent additions lose nothing", async () => {
    const subject = `link-${rand()}`;
    const today = utcDay();
    await Promise.all(Array.from({ length: 50 }, (_, i) => addUsage(db, today, "link", subject, i + 1)));
    expect(await todayTotals(db, "link", subject)).toEqual({ bytes: 1275, count: 50 });
    const rows = await db.select().from(downloadLedger).where(eq(downloadLedger.subjectId, subject));
    expect(rows).toHaveLength(1);
  });

  it("accepts every declared subject type", async () => {
    const subject = `all-${rand()}`;
    for (const type of downloadLedger.subjectType.enumValues) await addUsage(db, utcDay(), type, subject, 1);
    expect(downloadLedger.subjectType.enumValues).toEqual([
      "user",
      "link",
      "ip",
      "upload_user",
      "upload_editor",
      "transform_user",
      "share_user",
      "link_user",
      "signup_ip",
      "signup_ip24",
      "signup_asn",
      "signup_domain",
      "ip24",
      "asn",
      "email",
    ]);
  });
});

describe("email-ledger.tryConsume", () => {
  const counts = async (hash: string) => {
    const rows = await db.select().from(emailLedger).where(eq(emailLedger.recipientHash, hash));
    return Object.fromEntries(rows.map((r) => [r.windowKind, r.count]));
  };

  it("allows up to the hourly cap, then refuses without counting", async () => {
    const hash = `rcpt-${rand()}`;
    for (let i = 0; i < 5; i++) expect(await tryConsume(db, hash, { perHour: 5, perDay: 50 })).toBe(true);
    expect(await tryConsume(db, hash, { perHour: 5, perDay: 50 })).toBe(false);
    expect(await tryConsume(db, hash, { perHour: 5, perDay: 50 })).toBe(false);
    expect(await counts(hash)).toEqual({ hour: 5, day: 5 });
  });

  it("a full day window refuses and does NOT use up the hour window", async () => {
    const hash = `rcpt-${rand()}`;
    for (let i = 0; i < 3; i++) expect(await tryConsume(db, hash, { perHour: 100, perDay: 3 })).toBe(true);
    expect(await tryConsume(db, hash, { perHour: 100, perDay: 3 })).toBe(false);
    expect(await counts(hash)).toEqual({ hour: 3, day: 3 });
  });

  it("a full hour window refuses and does NOT use up the day window", async () => {
    const hash = `rcpt-${rand()}`;
    for (let i = 0; i < 2; i++) await tryConsume(db, hash, { perHour: 2, perDay: 50 });
    for (let i = 0; i < 4; i++) expect(await tryConsume(db, hash, { perHour: 2, perDay: 50 })).toBe(false);
    expect(await counts(hash)).toEqual({ hour: 2, day: 2 });
  });

  it("30 concurrent sends respect the cap exactly", async () => {
    const hash = `rcpt-${rand()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, () => tryConsume(db, hash, { perHour: 5, perDay: 50 })),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await counts(hash)).toEqual({ hour: 5, day: 5 });
  });

  it("a new hour starts a new count while the day keeps counting; recipients are separate", async () => {
    const hash = `rcpt-${rand()}`;
    for (let i = 0; i < 5; i++) await tryConsume(db, hash, { perHour: 5, perDay: 7 });
    // Move the hour window into the past: as if an hour had gone by.
    await db
      .update(emailLedger)
      .set({ windowStart: sql`${emailLedger.windowStart} - interval '1 hour'` })
      .where(sql`${emailLedger.recipientHash} = ${hash} AND ${emailLedger.windowKind} = 'hour'`);
    expect(await tryConsume(db, hash, { perHour: 5, perDay: 7 })).toBe(true);
    expect(await tryConsume(db, hash, { perHour: 5, perDay: 7 })).toBe(true);
    expect(await tryConsume(db, hash, { perHour: 5, perDay: 7 })).toBe(false);
    expect(await tryConsume(db, `other-${rand()}`, { perHour: 5, perDay: 7 })).toBe(true);
    expect(await tryConsume(db, hash, { perHour: 0, perDay: 7 })).toBe(false);
  });
});

describe("blocklist", () => {
  it("lookup, upsert, and the conditional remove", async () => {
    const owner = await makeUser(db);
    const admin = await makeUser(db);
    const file = await makeFile(db, owner, null, `b-${rand()}.bin`);
    const sha = rand(32);
    expect(await blocklist.lookup(db, sha)).toBeNull();
    await blocklist.upsert(db, { sha256: sha, reason: "malware", sourceNodeId: file.id });
    expect(await blocklist.lookup(db, sha)).toEqual({ reason: "malware", sourceNodeId: file.id });
    // Repeating it is one row; a different write replaces the entry.
    await blocklist.upsert(db, { sha256: sha, reason: "malware", sourceNodeId: file.id });
    await blocklist.upsert(db, { sha256: sha, reason: "dmca", addedBy: admin, note: "notice 12" });
    expect(await blocklist.lookup(db, sha)).toEqual({ reason: "dmca", sourceNodeId: null });

    // The false-positive path removes the entry only when that node added it.
    expect(await blocklist.remove(db, sha, { onlyIfSourceNodeId: file.id })).toBe(false);
    expect(await blocklist.lookup(db, sha)).not.toBeNull();
    await blocklist.upsert(db, { sha256: sha, reason: "malware", sourceNodeId: file.id });
    expect(await blocklist.remove(db, sha, { onlyIfSourceNodeId: uuidv7() })).toBe(false);
    expect(await blocklist.remove(db, sha, { onlyIfSourceNodeId: file.id })).toBe(true);
    expect(await blocklist.lookup(db, sha)).toBeNull();
    expect(await blocklist.remove(db, sha)).toBe(false);
    await blocklist.upsert(db, { sha256: sha, reason: "admin" });
    expect(await blocklist.remove(db, sha)).toBe(true);
  });

  it("a csam entry is never downgraded by a later write", async () => {
    const sha = rand(32);
    const source = uuidv7();
    await blocklist.upsert(db, { sha256: sha, reason: "csam", sourceNodeId: source });
    await blocklist.upsert(db, { sha256: sha, reason: "malware", sourceNodeId: uuidv7() });
    await blocklist.upsert(db, { sha256: sha, reason: "admin" });
    expect(await blocklist.lookup(db, sha)).toEqual({ reason: "csam", sourceNodeId: source });
  });
});

describe("settings", () => {
  // The table is global: this file is the only one that writes the real keys.
  const KEYS = [
    "signupMode",
    "uploadsEnabled",
    "linksEnabled",
    "readOnly",
    "ceilings",
    "termsVersion",
    "orphanDeleteEnabled",
    "reconcileCursor",
    "dmcaAutoCloseDays",
  ];
  const clearKeys = async () => {
    await db.delete(settings).where(
      sql`${settings.key} IN (${sql.join(
        KEYS.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
    clearSettingsCache();
  };
  beforeEach(clearKeys);
  // The table is this checkout's one `settings` table: the dev server and the Worker tests read
  // it too. Rows left behind here (a read-only switch, a ceiling) would configure them.
  afterAll(clearKeys);

  it("an empty table yields no keys; every key round-trips with its type", async () => {
    expect(await getSettings(db)).toEqual({});
    const admin = await makeUser(db);
    await setSetting(db, "signupMode", "open", admin);
    await setSetting(db, "uploadsEnabled", false, admin);
    await setSetting(db, "linksEnabled", true, admin);
    await setSetting(db, "readOnly", true, null);
    await setSetting(db, "ceilings", { CEIL_UPLOAD_BYTES_DAY: 1_000_000, signupIpDay: 3 }, admin);
    await setSetting(db, "termsVersion", "2026-10-01", admin);
    await setSetting(db, "orphanDeleteEnabled", false, null);
    await setSetting(db, "reconcileCursor", { prefix: "u/", after: "u/abc" }, null);
    await setSetting(db, "dmcaAutoCloseDays", null, admin);
    expect(await getSettings(db)).toEqual({
      signupMode: "open",
      uploadsEnabled: false,
      linksEnabled: true,
      readOnly: true,
      ceilings: { CEIL_UPLOAD_BYTES_DAY: 1_000_000, signupIpDay: 3 },
      termsVersion: "2026-10-01",
      orphanDeleteEnabled: false,
      reconcileCursor: { prefix: "u/", after: "u/abc" },
      dmcaAutoCloseDays: null,
    });
    const [row] = await db.select().from(settings).where(eq(settings.key, "signupMode"));
    expect(row).toMatchObject({ value: "open", updatedBy: admin });
    const [system] = await db.select().from(settings).where(eq(settings.key, "readOnly"));
    expect(system).toMatchObject({ value: true, updatedBy: null });
    await setSetting(db, "dmcaAutoCloseDays", 14, admin);
    expect((await getSettings(db)).dmcaAutoCloseDays).toBe(14);
  });

  it("setSetting is visible at once in this isolate; another isolate's write within 60 s is not, unless fresh", async () => {
    await setSetting(db, "termsVersion", "v1", null);
    expect((await getSettings(db)).termsVersion).toBe("v1");
    await setSetting(db, "termsVersion", "v2", null);
    expect((await getSettings(db)).termsVersion).toBe("v2");
    // A write that did not go through this module's setSetting (another isolate).
    await db.update(settings).set({ value: "v3" }).where(eq(settings.key, "termsVersion"));
    expect((await getSettings(db)).termsVersion).toBe("v2");
    expect((await getSettings(db, { fresh: true })).termsVersion).toBe("v3");
    expect((await getSettings(db)).termsVersion).toBe("v3");
  });

  it("ignores unknown keys and values of the wrong type", async () => {
    const junk = `junk-${rand()}`;
    await db.insert(settings).values([
      { key: junk, value: { anything: true } },
      { key: "signupMode", value: "everyone" },
      { key: "readOnly", value: "yes" },
      { key: "ceilings", value: { good: 5, bad: "x", negative: -1 } },
      { key: "dmcaAutoCloseDays", value: 1.5 },
    ]);
    expect(await getSettings(db, { fresh: true })).toEqual({ ceilings: { good: 5 } });
    await db.delete(settings).where(eq(settings.key, junk));
  });
});

describe("audit", () => {
  it("insertAudit writes every column", async () => {
    const actor = baId();
    const requestId = `req-${rand()}`;
    await insertAudit(db, {
      actorUserId: actor,
      actorType: "admin",
      action: "node.takedown",
      targetType: "node",
      targetId: uuidv7(),
      ipHashDaily: "daily-hash",
      ua: "Mozilla/5.0",
      country: "NL",
      requestId,
      meta: { reason: "dmca", legalHold: true },
    });
    await insertAudit(db, {
      actorUserId: null,
      actorType: "system",
      action: "system.purge",
      targetType: null,
      targetId: null,
      ipHashDaily: null,
      ua: null,
      country: null,
      requestId: null,
      meta: null,
    });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.requestId, requestId));
    expect(row).toMatchObject({
      actorUserId: actor,
      actorType: "admin",
      action: "node.takedown",
      targetType: "node",
      ipHashDaily: "daily-hash",
      ua: "Mozilla/5.0",
      country: "NL",
      meta: { reason: "dmca", legalHold: true },
    });
    expect(row!.at).toBeInstanceOf(Date);
    expect(Math.abs(row!.at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

describe("upload-ips", () => {
  it("record, forNode, and retention that spares held rows", async () => {
    const nodeId = uuidv7();
    const cipher = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const iv = new Uint8Array(12).fill(7);
    const id = await uploadIps.record(db, {
      nodeId,
      versionId: "v1",
      uploaderId: baId(),
      ipEncrypted: cipher,
      iv,
      keyVersion: 2,
    });
    await uploadIps.record(db, {
      nodeId,
      versionId: "v2",
      uploaderId: baId(),
      ipEncrypted: cipher,
      iv,
      keyVersion: 2,
    });
    const rows = await uploadIps.forNode(db, nodeId);
    expect(rows.map((r) => r.versionId)).toEqual(["v1", "v2"]);
    expect(rows[0]).toMatchObject({ id, nodeId, keyVersion: 2, legalHold: false });
    expect([...rows[0]!.ipEncrypted]).toEqual([...cipher]);
    expect([...rows[0]!.iv]).toEqual([...iv]);
    expect(await uploadIps.forNode(db, uuidv7())).toEqual([]);

    const old = new Date(Date.now() - 91 * 86_400_000);
    const [expiredRow, heldRow, recentRow] = await db
      .insert(uploadIpsTable)
      .values([
        { nodeId, versionId: "old", uploaderId: baId(), ipEncrypted: cipher, iv, keyVersion: 1, at: old },
        {
          nodeId,
          versionId: "held",
          uploaderId: baId(),
          ipEncrypted: cipher,
          iv,
          keyVersion: 1,
          at: old,
          legalHold: true,
        },
        {
          nodeId,
          versionId: "recent",
          uploaderId: baId(),
          ipEncrypted: cipher,
          iv,
          keyVersion: 1,
          at: new Date(Date.now() - 89 * 86_400_000),
        },
      ])
      .returning({ id: uploadIpsTable.id });
    const due = await uploadIps.expired(db, 100_000);
    expect(due).toContain(expiredRow!.id);
    expect(due).not.toContain(heldRow!.id);
    expect(due).not.toContain(recentRow!.id);
    expect(await uploadIps.deleteExpired(db, 100_000)).toBeGreaterThanOrEqual(1);
    expect((await uploadIps.forNode(db, nodeId)).map((r) => r.versionId).sort()).toEqual([
      "held",
      "recent",
      "v1",
      "v2",
    ]);
  });
});

describe("users", () => {
  it("userState reports the four fields; banned honours banExpires; isActive combines them", async () => {
    const plain = await makeUser(db);
    expect(await userState(db, plain)).toEqual({
      banned: false,
      suspendedAt: null,
      deleteScheduledAt: null,
      legalHold: false,
    });
    expect(isActive(await userState(db, plain))).toBe(true);
    expect(await userState(db, baId())).toBeNull();
    expect(isActive(null)).toBe(false);

    const banned = await makeUser(db, { banned: true });
    expect((await userState(db, banned))!.banned).toBe(true);
    const timed = await makeUser(db, { banned: true, banExpires: new Date(Date.now() + 60_000) });
    expect((await userState(db, timed))!.banned).toBe(true);
    const lapsed = await makeUser(db, { banned: true, banExpires: new Date(Date.now() - 60_000) });
    expect((await userState(db, lapsed))!.banned).toBe(false);
    expect(isActive(await userState(db, lapsed))).toBe(true);

    const when = new Date("2026-09-09T09:09:09.000Z");
    const suspended = await makeUser(db, { suspendedAt: when, legalHold: true });
    const state = (await userState(db, suspended))!;
    expect(state.suspendedAt!.getTime()).toBe(when.getTime());
    expect(state.legalHold).toBe(true);
    expect(isActive(state)).toBe(false);
    expect(isActive(await userState(db, banned))).toBe(false);
    // Legal hold alone does not make an account inactive (it must stay invisible).
    const held = await makeUser(db, { legalHold: true });
    expect(isActive(await userState(db, held))).toBe(true);
    const leaving = await makeUser(db, { deleteScheduledAt: new Date(Date.now() + 86_400_000) });
    expect(isActive(await userState(db, leaving))).toBe(false);
    await db
      .update(user)
      .set({ legalHold: false })
      .where(sql`${user.id} IN (${suspended}, ${held})`);
  });

  it("termsVersionOf and revokeAllSessions", async () => {
    const userId = await makeUser(db, { termsVersion: "2026-01-01" });
    const other = await makeUser(db);
    expect(await termsVersionOf(db, userId)).toBe("2026-01-01");
    expect(await termsVersionOf(db, other)).toBeNull();
    expect(await termsVersionOf(db, baId())).toBeNull();

    for (const owner of [userId, userId, other]) {
      await db.insert(session).values({
        id: baId(),
        userId: owner,
        token: rand(16),
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      });
    }
    expect(await revokeAllSessions(db, userId)).toBe(2);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.userId, other))).toHaveLength(1);
    expect(await revokeAllSessions(db, userId)).toBe(0);
  });
});

describe("cursor codec", () => {
  it("round-trips, and rejects another tag, a failed check and garbage", () => {
    const isN = (v: unknown): v is { n: number } =>
      !!v && typeof v === "object" && typeof (v as { n: unknown }).n === "number";
    const cursor = encodeCursor("tag-a", { n: 5 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor("tag-a", cursor, isN)).toEqual({ n: 5 });
    for (const attempt of [
      () => decodeCursor("tag-b", cursor, isN),
      () => decodeCursor("tag-a", encodeCursor("tag-a", { n: "5" }), isN),
      () => decodeCursor("tag-a", "!!!", isN),
      () => decodeCursor("tag-a", "", isN),
      () => decodeCursor("tag-a", Buffer.from("[1,2]").toString("base64url"), isN),
    ]) {
      expect(attempt).toThrowError(QueryError);
    }
    expect(decodeCursor("t", encodeCursor("t", { n: 1, s: "naïve — ünïcode" }), isN)).toMatchObject({ n: 1 });
  });
});

describe("filename stub", () => {
  it("sanitizeName normalises, strips invisible characters and rejects unusable names", async () => {
    expect(sanitizeName("  report.pdf  ")).toBe("report.pdf");
    // NFC: e + combining acute becomes one code point.
    expect(sanitizeName("cafe" + String.fromCharCode(0x301) + ".txt")).toBe(
      "caf" + String.fromCharCode(0xe9) + ".txt",
    );
    // A right-to-left override, a zero-width space, a control character and a BOM are removed.
    const hostile =
      "inv" +
      String.fromCharCode(0x202e) +
      "oice" +
      String.fromCharCode(0x200b) +
      String.fromCharCode(0x07) +
      String.fromCharCode(0xfeff) +
      ".exe";
    expect(sanitizeName(hostile)).toBe("invoice.exe");
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", String.fromCharCode(0x200b), "x".repeat(256)]) {
      const error = await rejection(Promise.resolve().then(() => sanitizeName(bad)));
      expect((error as QueryError).code, JSON.stringify(bad)).toBe("validation");
    }
    expect(sanitizeName("x".repeat(255))).toHaveLength(255);
  });

  it("nameKeyOf lower-cases after the same cleaning; extOf gives the lower-case extension", () => {
    expect(nameKeyOf("Report.PDF")).toBe("report.pdf");
    expect(nameKeyOf("ÉCOLE.txt")).toBe("école.txt");
    expect(nameKeyOf("a" + String.fromCharCode(0x200b) + "B")).toBe("ab");
    expect(nameKeyOf(sanitizeName(" Mixed Case "))).toBe("mixed case");
    expect(extOf("archive.TAR.GZ")).toBe("gz");
    expect(extOf("photo.JPEG")).toBe("jpeg");
    expect(extOf("README")).toBe("");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("trailing.")).toBe("");
    expect(extOf("weird.ext with space")).toBe("");
    expect(extOf("a.b.c.d")).toBe("d");
  });
});
