// A limit that is read in one statement and acted on in another is not a limit. These tests run
// requests TOGETHER — real transactions on separate connections, interleaved with gates and the
// server's own view of who waits for whom, never with a sleep — and hold the ceilings to it.
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { Tx } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { todayTotals } from "../../../src/worker/db/queries/ledger";
import type { Settings } from "../../../src/worker/db/queries/settings";
import { lockUser } from "../../../src/worker/db/queries/users";
import { downloadLedger, shareLinks, uploads } from "../../../src/worker/db/schema";
import * as ceilings from "../../../src/worker/services/ceilings";
import {
  ceilingExceeded,
  checkCeiling,
  consumeCeiling,
  enforceUploadCeilings,
  recordUsage,
  refundUsage,
  tryConsumeCeiling,
  type CeilingLedgerSubject,
  type CeilingSubject,
} from "../../../src/worker/services/ceilings";
import { db, type AppEnv } from "../../../src/worker/services/request-context";
import { keyFor } from "../../../src/worker/services/storage";
import { backendPid, gate, makeFolder, makeUser, rand, serviceDeps, testDb, untilBlockedBy } from "./helpers";
import { invoke, value, type InvokeOptions } from "./request";

/** Small limits, so that "fits alone, not together" is a handful of units. Quota 0: no scaling. */
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
const oldAccount = { quotaBytes: 0, createdAt: new Date("2025-01-01T00:00:00.000Z") };
const subjectId = () => `ceil-${rand(8)}`;

/** An open upload session row, as the upload route inserts it in the admission's transaction. */
function uploadRow(ownerId: string, uploaderId: string, size: number) {
  const nodeId = uuidv7();
  const versionId = uuidv7();
  return {
    ownerId,
    uploaderId,
    parentId: null,
    nodeId,
    versionId,
    name: "upload.bin",
    nameKey: "upload.bin",
    size,
    r2Key: keyFor(ownerId, nodeId, versionId),
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

const linkRow = (nodeId: string, userId: string) => ({
  nodeId,
  createdBy: userId,
  tokenHash: rand(32),
  tokenEnc: new Uint8Array(48),
  tokenIv: new Uint8Array(12),
});

/**
 * Two admissions of the same subject, interleaved on purpose: A decides, then waits — inside its
 * transaction — until B is either blocked on A's lock or has decided too; only then does A write
 * and commit. With the lock, B is blocked, then sees A's row and is refused. Without it, both
 * have decided before either wrote, and both are admitted.
 */
async function race(
  admit: (c: Context<AppEnv>, tx: Tx) => Promise<unknown>,
  write: (tx: Tx) => Promise<unknown>,
  options: InvokeOptions,
) {
  const aDecided = gate<number>();
  let bDecided = false;
  const a = invoke(
    null,
    (c) =>
      db(c).transaction(async (tx) => {
        await admit(c, tx);
        const pid = await backendPid(tx);
        aDecided.open(pid);
        await untilBlockedBy(pid, () => bDecided);
        await write(tx);
      }),
    options,
  );
  const b = invoke(
    null,
    async (c) => {
      await aDecided.opened;
      return db(c).transaction(async (tx) => {
        await admit(c, tx);
        bDecided = true;
        await write(tx);
      });
    },
    options,
  );
  return Promise.all([a, b]);
}

/**
 * The transaction, with `pause` run once right after its first row lock (`… FOR UPDATE`) has been
 * taken — the one point between an admission's two user locks.
 */
function afterFirstRowLock(tx: Tx, pause: () => Promise<void>): Tx {
  let pending = true;
  type Chain = Record<string, (...args: unknown[]) => unknown>;
  const wrap = (builder: Chain): Chain =>
    new Proxy(builder, {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        const call = (member as (...args: unknown[]) => unknown).bind(target);
        if (property === "for") {
          return async (...args: unknown[]) => {
            const rows = await (call(...args) as Promise<unknown>);
            if (pending) {
              pending = false;
              await pause();
            }
            return rows;
          };
        }
        if (property === "from" || property === "where")
          return (...args: unknown[]) => wrap(call(...args) as Chain);
        return call;
      },
    });
  return new Proxy(tx, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      const call = (member as (...args: unknown[]) => unknown).bind(target);
      return property === "select" ? (...args: unknown[]) => wrap(call(...args) as Chain) : call;
    },
  });
}

describe("tryConsumeCeiling answers; the caller MUST refuse on ok: false", () => {
  it("ok: true means CHARGED; a refusal says what was refused and writes nothing", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const answers = await value(
      null,
      async (c) => [
        await tryConsumeCeiling(c, "share_user", subject, { count: 2 }),
        await tryConsumeCeiling(c, "share_user", subject, { count: 2 }),
        await tryConsumeCeiling(c, "share_user", subject, { count: 1 }),
        await tryConsumeCeiling(c, "share_user", subject, { count: 1 }),
      ],
      small,
    );
    expect(answers[0]).toEqual({ ok: true, day: new Date().toISOString().slice(0, 10) });
    expect(answers[1]).toMatchObject({
      ok: false,
      kind: "share_user",
      dimension: "count",
      limit: 3,
      used: 2,
    });
    expect(answers[1]!.ok === false && answers[1]!.retryAfterSec).toBeGreaterThan(0);
    expect(answers[2]).toMatchObject({ ok: true });
    expect(answers[3]).toMatchObject({ ok: false, used: 3 });
    expect(await todayTotals(testDb(), "share_user", subject.id)).toEqual({ bytes: 0, count: 3 });
  });

  it("ceilingExceeded is the 429 of a refusal: details and Retry-After", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const thrown = await invoke(
      null,
      async (c) => {
        const result = await tryConsumeCeiling(c, "transform_user", subject, { count: 4 });
        if (!result.ok) throw ceilingExceeded(result);
      },
      { ...small, headers: { "x-holdfast-test-now": "2026-10-12T23:59:30.000Z" } },
    );
    expect(thrown).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "transform_user", dimension: "count" },
    });
    expect(thrown.headers.get("retry-after")).toBe("30");
  });

  it("a bytes-only consume adds no count, and a count-only consume no bytes", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    await value(null, (c) => tryConsumeCeiling(c, "download_link", subject, { bytes: 100 }), small);
    await value(null, (c) => tryConsumeCeiling(c, "download_link", subject, { bytes: 100 }), small);
    expect(await todayTotals(testDb(), "link", subject.id)).toEqual({ bytes: 200, count: 0 });
    await value(null, (c) => tryConsumeCeiling(c, "download_link", subject, { count: 1 }), small);
    expect(await todayTotals(testDb(), "link", subject.id)).toEqual({ bytes: 200, count: 1 });
  });

  it("a preview refuses nothing and counts no metric; an enforcing refusal counts exactly one", async () => {
    const points: { blobs: string[] }[] = [];
    const recording = {
      METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) },
    };
    const ceilingPoints = () =>
      points.filter((point) => point.blobs[0] === "ceiling").map((point) => point.blobs.slice(1, 4));
    const owner = await makeUser();
    const subject = { id: owner.id, account: oldAccount };
    const options = { ...small, env: recording };

    const preview = await value(null, (c) => checkCeiling(c, "share_user", subject, { count: 4 }), options);
    expect(preview).toMatchObject({ ok: false, dimension: "count" });
    expect(ceilingPoints()).toEqual([]);

    await value(null, (c) => tryConsumeCeiling(c, "share_user", subject, { count: 4 }), options);
    expect(ceilingPoints()).toEqual([["refused", "share_user", "count"]]);
    await value(null, (c) => tryConsumeCeiling(c, "share_user", subject, { count: 3 }), options);
    expect(ceilingPoints(), "a charge is not a refusal").toHaveLength(1);

    await invoke(
      null,
      (c) =>
        db(c).transaction((tx) =>
          enforceUploadCeilings(c, { owner: subject }, { bytes: 1001, count: 1 }, { tx }),
        ),
      options,
    );
    expect(ceilingPoints()).toEqual([
      ["refused", "share_user", "count"],
      ["refused", "upload_user", "bytes"],
    ]);
  });
});

describe("consumeCeiling throws: a refusal cannot be ignored", () => {
  it("within the limit it charges and returns the receipt; beyond it, it throws the 429 and charges nothing", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const today = new Date().toISOString().slice(0, 10);
    expect(await value(null, (c) => consumeCeiling(c, "share_user", subject, { count: 2 }), small)).toEqual({
      day: today,
    });
    const refused = await invoke(null, (c) => consumeCeiling(c, "share_user", subject, { count: 2 }), small);
    expect(refused).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "share_user", dimension: "count" },
    });
    expect(refused.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
    expect(await todayTotals(testDb(), "share_user", subject.id)).toEqual({ bytes: 0, count: 2 });
  });

  it("a caller that does not look at anything still serves nothing on a refusal", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    let served = 0;
    // The careless route: consume, then serve. It never inspects a result.
    const route = (bytes: number) =>
      invoke(
        null,
        async (c) => {
          await consumeCeiling(c, "download_user", subject, { bytes });
          served += bytes;
        },
        small,
      );
    expect(await route(600)).toMatchObject({ ok: true });
    expect(await route(600)).toMatchObject({ ok: false, status: 429 });
    expect(served, "the second request did not reach its serve").toBe(600);
    // The control: the same careless shape over the ANSWERING form serves what was refused.
    let leaked = 0;
    await invoke(
      null,
      async (c) => {
        await tryConsumeCeiling(c, "download_user", subject, { bytes: 600 });
        leaked += 600;
      },
      small,
    );
    expect(leaked, "which is why the answering form is a separate, named export").toBe(600);
    expect(await todayTotals(testDb(), "user", subject.id)).toEqual({ bytes: 600, count: 0 });
  });

  it("the link_user form throws inside the caller's transaction, which then leaves nothing behind", async () => {
    const user = await makeUser();
    const folder = await makeFolder(user.id);
    const subject = { id: user.id, account: oldAccount };
    const create = () =>
      invoke(
        null,
        (c) =>
          db(c).transaction(async (tx) => {
            await tx.insert(shareLinks).values(linkRow(folder.id, user.id));
            await consumeCeiling(c, "link_user", subject, { count: 1 }, { tx });
          }),
        small,
      );
    for (let i = 0; i < 3; i++) expect(await create()).toMatchObject({ ok: true });
    expect(await create()).toMatchObject({ ok: false, status: 429 });
    expect(await testDb().select().from(shareLinks).where(eq(shareLinks.createdBy, user.id))).toHaveLength(3);
  });
});

describe("the amount is typed per kind", () => {
  it("type level: the wrong dimension does not compile", () => {
    const neverRun = async (c: Context<AppEnv>, tx: Tx) => {
      const subject = { id: "x", account: oldAccount };
      // @ts-expect-error a count-only kind takes no bytes
      await consumeCeiling(c, "transform_user", subject, { bytes: 1 });
      // @ts-expect-error nor bytes beside the count
      await consumeCeiling(c, "share_user", subject, { count: 1, bytes: 1 });
      // @ts-expect-error a bytes-only kind takes no count
      await consumeCeiling(c, "download_user", subject, { count: 1 });
      // @ts-expect-error nor a count beside the bytes
      await consumeCeiling(c, "download_owner", subject, { bytes: 1, count: 1 });
      // @ts-expect-error an empty amount is no amount
      await consumeCeiling(c, "download_ip", subject, {});
      // @ts-expect-error not for the two-dimension kind either
      await consumeCeiling(c, "download_link", subject, {});
      // @ts-expect-error the link form counts links
      await consumeCeiling(c, "link_user", subject, { bytes: 1 }, { tx });
      // @ts-expect-error the same types on the answering form
      await tryConsumeCeiling(c, "transform_user", subject, { bytes: 1 });
      // @ts-expect-error and on the preview
      await checkCeiling(c, "share_user", subject, { bytes: 1 });
      // @ts-expect-error and on a plain record
      await recordUsage(c, "download_user", subject.id, { count: 1 });
      // @ts-expect-error an upload names its bytes
      await enforceUploadCeilings(c, { owner: subject }, { count: 1 }, { tx });
      // @ts-expect-error and its count: both dimensions are required
      await enforceUploadCeilings(c, { owner: subject }, { bytes: 1 }, { tx });
      // What exists: bytes, a count, or — for the two kinds with both — either or both.
      await consumeCeiling(c, "download_link", subject, { bytes: 1 });
      await consumeCeiling(c, "download_link", subject, { count: 1 });
      await consumeCeiling(c, "download_link", subject, { bytes: 1, count: 1 });
      await checkCeiling(c, "upload_user", subject, { bytes: 1, count: 1 });
    };
    expect(typeof neverRun).toBe("function");
  });

  it("run time: an upload that does not name BOTH its bytes and its count is a validation error — never a pass", async () => {
    const user = await makeUser();
    const editor = await makeUser();
    const subject = { id: user.id, account: oldAccount };
    const loose = enforceUploadCeilings as unknown as (...args: unknown[]) => Promise<void>;
    const outcome = async (amount: unknown, subjects: unknown = { owner: subject }) => {
      const invoked = await invoke(
        null,
        (c) => db(c).transaction((tx) => loose(c, subjects, amount, { tx })),
        small,
      );
      return invoked.ok ? "ok" : `${invoked.status} ${invoked.error}`;
    };
    for (const amount of [{ bytes: 1 }, { count: 1 }, {}, undefined, null, { bytes: 1, count: undefined }]) {
      expect(await outcome(amount), JSON.stringify(amount)).toBe("400 validation");
      expect(
        await outcome(amount, { owner: subject, editor: { id: editor.id, account: oldAccount } }),
        JSON.stringify(amount),
      ).toBe("400 validation");
    }
    // The control: with both, the same call is admitted.
    expect(await outcome({ bytes: 1, count: 1 })).toBe("ok");
  });

  it("run time: an empty amount, and a dimension the kind does not have, are validation errors — never a pass", async () => {
    const user = await makeUser();
    const subject = { id: user.id, account: oldAccount };
    const loose = {
      consume: consumeCeiling,
      tryConsume: tryConsumeCeiling,
      check: checkCeiling,
      record: recordUsage,
    } as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const outcome = async (work: Parameters<typeof invoke>[1]) => {
      const invoked = await invoke(null, work, small);
      return invoked.ok ? "ok" : `${invoked.status} ${invoked.error}`;
    };
    const bad: [string, unknown][] = [
      ["transform_user", { bytes: 5 }],
      ["transform_user", {}],
      ["share_user", { bytes: 1, count: 1 }],
      ["download_user", { count: 1 }],
      ["download_user", {}],
      ["download_ip", { bytes: 1, count: 1 }],
      ["download_link", {}],
      ["download_owner", undefined],
      ["download_owner", null],
    ];
    for (const [kind, amount] of bad) {
      const label = `${kind} ${JSON.stringify(amount)}`;
      expect(await outcome((c) => loose.consume!(c, kind, subject, amount)), label).toBe("400 validation");
      expect(await outcome((c) => loose.tryConsume!(c, kind, subject, amount)), label).toBe("400 validation");
      expect(await outcome((c) => loose.check!(c, kind, subject, amount)), label).toBe("400 validation");
      expect(await outcome((c) => loose.record!(c, kind, subject.id, amount)), label).toBe("400 validation");
    }
    expect(
      await outcome((c) => db(c).transaction((tx) => loose.consume!(c, "link_user", subject, {}, { tx }))),
    ).toBe("400 validation");
    expect(
      await outcome((c) =>
        db(c).transaction((tx) =>
          (enforceUploadCeilings as unknown as (...args: unknown[]) => Promise<void>)(
            c,
            { owner: subject },
            {},
            { tx },
          ),
        ),
      ),
    ).toBe("400 validation");
    // Nothing was written by any of them.
    for (const ledger of ["transform_user", "share_user", "user", "ip", "link", "link_owner"] as const) {
      expect(await todayTotals(testDb(), ledger, user.id), ledger).toEqual({ bytes: 0, count: 0 });
    }
    // The control: zero is an amount (it names the dimension), and it passes.
    expect(await outcome((c) => consumeCeiling(c, "transform_user", subject, { count: 0 }))).toBe("ok");
  });
});

describe("one clock per decision", () => {
  const at = (iso: string): InvokeOptions => ({ ...small, headers: { "x-holdfast-test-now": iso } });
  const dayTotals = async (day: string, id: string) => {
    const [row] = await testDb()
      .select()
      .from(downloadLedger)
      .where(
        and(
          eq(downloadLedger.day, day),
          eq(downloadLedger.subjectType, "share_user"),
          eq(downloadLedger.subjectId, id),
        ),
      );
    return row ? { bytes: row.bytes, count: row.count } : null;
  };

  it("a consume at 23:59:59.999 UTC and one at 00:00:00.000 land on different days, each with its own total", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const lastMs = at("2031-03-04T23:59:59.999Z");
    const firstMs = at("2031-03-05T00:00:00.000Z");
    expect(await value(null, (c) => consumeCeiling(c, "share_user", subject, { count: 3 }), lastMs)).toEqual({
      day: "2031-03-04",
    });
    expect(await value(null, (c) => consumeCeiling(c, "share_user", subject, { count: 2 }), firstMs)).toEqual(
      {
        day: "2031-03-05",
      },
    );
    expect(await dayTotals("2031-03-04", subject.id)).toEqual({ bytes: 0, count: 3 });
    expect(await dayTotals("2031-03-05", subject.id)).toEqual({ bytes: 0, count: 2 });

    // Each refusal reports ITS day's total, and the distance to ITS midnight.
    const late = await value(null, (c) => tryConsumeCeiling(c, "share_user", subject, { count: 1 }), lastMs);
    expect(late).toEqual({
      ok: false,
      kind: "share_user",
      dimension: "count",
      limit: 3,
      used: 3,
      retryAfterSec: 1,
    });
    const early = await value(
      null,
      (c) => tryConsumeCeiling(c, "share_user", subject, { count: 2 }),
      firstMs,
    );
    expect(early).toEqual({
      ok: false,
      kind: "share_user",
      dimension: "count",
      limit: 3,
      used: 2,
      retryAfterSec: 86_400,
    });
    // The preview and a plain record use the same day.
    expect(
      await value(null, (c) => checkCeiling(c, "share_user", subject, { count: 1 }), lastMs),
    ).toMatchObject({
      ok: false,
      used: 3,
    });
    expect(await value(null, (c) => checkCeiling(c, "share_user", subject, { count: 1 }), firstMs)).toEqual({
      ok: true,
    });
    await value(null, (c) => recordUsage(c, "share_user", subject.id, { count: 5 }), lastMs);
    expect(await dayTotals("2031-03-04", subject.id)).toEqual({ bytes: 0, count: 8 });
    expect(await dayTotals("2031-03-05", subject.id)).toEqual({ bytes: 0, count: 2 });
  });

  it("a refusal never names a dimension the kind is not limited on", async () => {
    // Count-only kinds: always count, with the real limit — also when the limit is 0.
    const zero: InvokeOptions = {
      settings: { ceilings: { ...SMALL.ceilings, CEIL_SHARES_DAY: 0, CEIL_IP_BYTES_DAY: 0 } },
    };
    const share = await value(
      null,
      (c) => tryConsumeCeiling(c, "share_user", { id: subjectId(), account: oldAccount }, { count: 1 }),
      zero,
    );
    expect(share).toMatchObject({ ok: false, dimension: "count", limit: 0, used: 0 });
    const ip = await value(
      null,
      (c) => tryConsumeCeiling(c, "download_ip", { id: subjectId() }, { bytes: 1 }),
      zero,
    );
    expect(ip).toMatchObject({ ok: false, dimension: "bytes", limit: 0, used: 0 });
    for (const kind of ["transform_user", "share_user"] as const) {
      const subject = { id: subjectId(), account: oldAccount };
      const refused = await value(null, (c) => tryConsumeCeiling(c, kind, subject, { count: 4 }), small);
      expect(refused, kind).toMatchObject({ ok: false, dimension: "count", limit: 3 });
    }
  });
});

describe("a refusal lost to a race still names a dimension the kind has", () => {
  it("the statement refuses, the re-read shows room: a count-only kind is refused on its count, with its limit", async () => {
    const user = await makeUser();
    const subject = { id: user.id, account: oldAccount };
    // The conditional insert answers "not added" (as when another request took the room and gave
    // it back in between); every other statement goes to the database.
    const result = await value(
      null,
      (c) =>
        db(c).transaction((tx) => {
          const refusing = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === "execute") return async () => ({ rows: [] });
              const member: unknown = Reflect.get(target, property, receiver);
              return typeof member === "function"
                ? (member as (...a: unknown[]) => unknown).bind(target)
                : member;
            },
          });
          return tryConsumeCeiling(c, "link_user", subject, { count: 1 }, { tx: refusing });
        }),
      small,
    );
    expect(result).toMatchObject({ ok: false, kind: "link_user", dimension: "count", limit: 3, used: 0 });
  });
});

describe("refundUsage: unsent bytes are given back", () => {
  const deps = () => serviceDeps().deps;
  const today = () => new Date().toISOString().slice(0, 10);

  it("consume 100, refund 60 → 40; a refund larger than what is there stops at 0", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const charge = await value(
      null,
      (c) => consumeCeiling(c, "download_owner", subject, { bytes: 100 }),
      small,
    );
    expect(charge).toEqual({ day: today() });
    await refundUsage(deps(), "download_owner", subject.id, { bytes: 60 }, charge);
    expect(await todayTotals(testDb(), "link_owner", subject.id)).toEqual({ bytes: 40, count: 0 });
    // What was given back can be used again — and no more than that.
    expect(
      await invoke(null, (c) => consumeCeiling(c, "download_owner", subject, { bytes: 960 }), small),
    ).toMatchObject({ ok: true });
    expect(
      await invoke(null, (c) => consumeCeiling(c, "download_owner", subject, { bytes: 1 }), small),
    ).toMatchObject({ status: 429 });
    await refundUsage(deps(), "download_owner", subject.id, { bytes: 5000 }, charge);
    expect(await todayTotals(testDb(), "link_owner", subject.id)).toEqual({ bytes: 0, count: 0 });
    // A refund of nothing, and one for a subject with no row, change nothing and create no row.
    await refundUsage(deps(), "download_owner", subject.id, { bytes: 0 }, charge);
    const other = subjectId();
    await refundUsage(deps(), "download_owner", other, { bytes: 10 }, charge);
    expect(await todayTotals(testDb(), "link_owner", other)).toEqual({ bytes: 0, count: 0 });
  });

  it("a count is never refunded, and each kind's refund touches only its own ledger", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const charge = await value(
      null,
      (c) => consumeCeiling(c, "download_link", subject, { bytes: 100, count: 1 }),
      small,
    );
    await value(null, (c) => consumeCeiling(c, "download_user", subject, { bytes: 100 }), small);
    await refundUsage(deps(), "download_link", subject.id, { bytes: 30 }, charge);
    expect(await todayTotals(testDb(), "link", subject.id)).toEqual({ bytes: 70, count: 1 });
    expect(await todayTotals(testDb(), "user", subject.id)).toEqual({ bytes: 100, count: 0 });
  });

  it("a refund for a charge booked on another UTC day is dropped, never applied to today", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const yesterday = new Date(Date.now() - 86_400_000);
    // Charged yesterday (the request's clock), and something else charged today.
    const old = await value(
      null,
      (c) => consumeCeiling(c, "download_ip", { id: subject.id }, { bytes: 500 }),
      {
        ...small,
        headers: { "x-holdfast-test-now": yesterday.toISOString() },
      },
    );
    expect(old.day).toBe(yesterday.toISOString().slice(0, 10));
    await value(null, (c) => consumeCeiling(c, "download_ip", { id: subject.id }, { bytes: 300 }), small);

    await refundUsage(deps(), "download_ip", subject.id, { bytes: 200 }, old);
    expect(await todayTotals(testDb(), "ip", subject.id), "today's row is untouched").toEqual({
      bytes: 300,
      count: 0,
    });
    const [stale] = await testDb()
      .select()
      .from(downloadLedger)
      .where(
        and(
          eq(downloadLedger.day, old.day),
          eq(downloadLedger.subjectType, "ip"),
          eq(downloadLedger.subjectId, subject.id),
        ),
      );
    expect(stale!.bytes, "and yesterday's row is history").toBe(500);
    // The control: the same refund with today's receipt is applied.
    await refundUsage(deps(), "download_ip", subject.id, { bytes: 200 }, { day: today() });
    expect(await todayTotals(testDb(), "ip", subject.id)).toEqual({ bytes: 100, count: 0 });
  });

  it("concurrent consumes and refunds keep the row consistent", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const roomy: InvokeOptions = {
      settings: { ceilings: { ...SMALL.ceilings, CEIL_USER_BYTES_DAY: 1_000_000 } },
    };
    const charge = await value(
      null,
      (c) => consumeCeiling(c, "download_user", subject, { bytes: 10_000 }),
      roomy,
    );
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      work.push(value(null, (c) => consumeCeiling(c, "download_user", subject, { bytes: 1000 }), roomy));
      work.push(refundUsage(deps(), "download_user", subject.id, { bytes: 300 }, charge));
    }
    await Promise.all(work);
    expect(await todayTotals(testDb(), "user", subject.id)).toEqual({
      bytes: 10_000 + 10 * 1000 - 10 * 300,
      count: 0,
    });
  });

  it("it cannot raise a limit or be pointed at a count: bad input throws and writes nothing", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const charge = await value(
      null,
      (c) => consumeCeiling(c, "download_user", subject, { bytes: 100 }),
      small,
    );
    const loose = refundUsage as unknown as (...args: unknown[]) => Promise<void>;
    for (const amount of [{ bytes: -50 }, { bytes: 1.5 }, { bytes: Number.NaN }, { count: 1 }, {}, null]) {
      await expect(
        loose(deps(), "download_user", subject.id, amount, charge),
        JSON.stringify(amount),
      ).rejects.toThrow();
    }
    for (const kind of [
      "share_user",
      "transform_user",
      "link_user",
      "upload_user",
      "upload_editor",
      "nope",
    ]) {
      await expect(loose(deps(), kind, subject.id, { bytes: 1 }, charge), kind).rejects.toThrow();
    }
    await expect(
      loose(deps(), "download_user", subject.id, { bytes: 1 }, { day: "not-a-day" }),
    ).rejects.toThrow();
    expect(await todayTotals(testDb(), "user", subject.id)).toEqual({ bytes: 100, count: 0 });
  });
});

describe("consumeCeiling: the ledger-only kinds", () => {
  it("two consumes that each fit alone but not together: exactly one succeeds, the ledger holds one amount", async () => {
    const ledger = {
      download_user: "user",
      download_link: "link",
      download_ip: "ip",
      download_owner: "link_owner",
      transform_user: "transform_user",
      share_user: "share_user",
    } as const;
    for (const kind of Object.keys(ledger) as (keyof typeof ledger)[]) {
      const subject: CeilingSubject = {
        id: subjectId(),
        ...(kind === "download_ip" ? {} : { account: oldAccount }),
      };
      const byBytes = kind.startsWith("download");
      // 600 of 1000 bytes, or 2 of 3: one fits, two do not.
      const amount = byBytes ? { bytes: 600 } : { count: 2 };
      const [a, b] = await Promise.all([
        invoke(null, (c) => consumeCeiling(c, kind, subject, amount), small),
        invoke(null, (c) => consumeCeiling(c, kind, subject, amount), small),
      ]);
      expect([a.ok, b.ok].sort(), kind).toEqual([false, true]);
      expect(
        [a, b].find((result) => !result.ok),
        kind,
      ).toMatchObject({ status: 429, error: "ceiling_exceeded" });
      expect(await todayTotals(testDb(), ledger[kind], subject.id), kind).toEqual(
        byBytes ? { bytes: 600, count: 0 } : { bytes: 0, count: 2 },
      );
    }
  });

  it("a link's download count and its bytes are one consume: both dimensions or neither", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    const consume = (bytes: number, count: number) =>
      invoke(null, (c) => consumeCeiling(c, "download_link", subject, { bytes, count }), small);
    expect(await consume(400, 1)).toMatchObject({ ok: true });
    // The bytes would fit, the count would not after two more.
    expect(await consume(100, 2)).toMatchObject({ ok: true });
    expect(await consume(100, 1)).toMatchObject({ status: 429, details: { dimension: "count" } });
    // The count would fit, the bytes would not.
    expect(await consume(501, 0)).toMatchObject({ status: 429, details: { dimension: "bytes" } });
    // A refusal added nothing to either dimension.
    expect(await todayTotals(testDb(), "link", subject.id)).toEqual({ bytes: 500, count: 3 });
  });

  it("recordUsage enforces nothing: it adds past any limit (it is for corrections)", async () => {
    const subject = { id: subjectId(), account: oldAccount };
    await value(null, (c) => recordUsage(c, "share_user", subject.id, { count: 50 }), small);
    expect(await todayTotals(testDb(), "share_user", subject.id)).toEqual({ bytes: 0, count: 50 });
    // …after which the enforcing call refuses, as it should.
    expect(
      await invoke(null, (c) => consumeCeiling(c, "share_user", subject, { count: 1 }), small),
    ).toMatchObject({
      status: 429,
    });
  });
});

describe("what cannot be written", () => {
  it("type level: the unsafe calls do not compile", () => {
    // Never called: these lines exist for the compiler (`npm run typecheck`).
    const neverRun = async (c: Context<AppEnv>, tx: Tx) => {
      const subject = { id: "x", account: oldAccount };
      // @ts-expect-error an upload needs the caller's transaction
      await enforceUploadCeilings(c, { owner: subject }, { bytes: 1 });
      // @ts-expect-error the live-link cap needs the caller's transaction
      await consumeCeiling(c, "link_user", subject, { count: 1 });
      // @ts-expect-error an upload kind cannot be consumed: its open sessions are not in the ledger
      await consumeCeiling(c, "upload_user", subject, { bytes: 1 });
      // @ts-expect-error nor the editor's
      await consumeCeiling(c, "upload_editor", subject, { bytes: 1 });
      // @ts-expect-error a ledger-only kind is one statement of its own: it takes no transaction
      await consumeCeiling(c, "download_owner", subject, { bytes: 1 }, { tx });
      // @ts-expect-error likewise
      await consumeCeiling(c, "download_user", subject, { bytes: 1 }, { tx });
      // These are the forms that exist.
      await enforceUploadCeilings(c, { owner: subject }, { bytes: 1, count: 1 }, { tx });
      await enforceUploadCeilings(c, { owner: subject, editor: subject }, { bytes: 1, count: 1 }, { tx });
      await consumeCeiling(c, "link_user", subject, { count: 1 }, { tx });
      await consumeCeiling(c, "download_user", subject, { bytes: 1 });
      await consumeCeiling(c, "download_owner", subject, { bytes: 1 });
    };
    expect(typeof neverRun).toBe("function");
    // A ceiling is never counted on the marker subject, nor on a sign-up velocity subject.
    type Refused<T extends string> = T extends CeilingLedgerSubject ? "allowed" : "refused";
    const notice: Refused<"notice"> = "refused";
    const signup: Refused<"signup_ip"> = "refused";
    const owner: Refused<"link_owner"> = "allowed";
    expect([notice, signup, owner]).toEqual(["refused", "refused", "allowed"]);
    // There is no check-then-record call to import: the single-kind enforcer is not exported.
    expect(Object.keys(ceilings).sort()).toEqual([
      "CEILING_KINDS",
      "ceilingExceeded",
      "checkCeiling",
      "consumeCeiling",
      "effectiveLimits",
      "enforceUploadCeilings",
      "recordUsage",
      "refundUsage",
      "tryConsumeCeiling",
    ]);
  });

  it("at run time too: the wrong form throws before it admits anything", async () => {
    const user = await makeUser();
    const subject = { id: user.id, account: oldAccount };
    const loose = { upload: enforceUploadCeilings, consume: consumeCeiling } as unknown as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >;
    const failure = async (work: Parameters<typeof invoke>[1]) => {
      const invoked = await invoke(null, work, small);
      return invoked.ok ? "ok" : `${invoked.status} ${invoked.error}`;
    };
    // An unexpected Error is a 500: nothing was admitted.
    expect(await failure((c) => loose.upload!(c, { owner: subject }, { bytes: 1 }))).toBe("500 internal");
    expect(await failure((c) => loose.upload!(c, { owner: subject }, { bytes: 1 }, {}))).toBe("500 internal");
    expect(await failure((c) => loose.consume!(c, "link_user", subject, { count: 1 }))).toBe("500 internal");
    expect(await failure((c) => loose.consume!(c, "upload_user", subject, { bytes: 1 }))).toBe(
      "500 internal",
    );
    expect(
      await failure((c) =>
        db(c).transaction((tx) => loose.consume!(c, "download_user", subject, { bytes: 1 }, { tx })),
      ),
    ).toBe("500 internal");
    for (const ledger of ["upload_user", "link_user", "user"] as const) {
      expect(await todayTotals(testDb(), ledger, user.id)).toEqual({ bytes: 0, count: 0 });
    }
  });
});

describe("lockUser", () => {
  it("is true for a user and false for nobody; a second locker waits until the first transaction ends", async () => {
    const user = await makeUser();
    expect(await testDb().transaction((tx) => lockUser(tx, user.id))).toBe(true);
    expect(await testDb().transaction((tx) => lockUser(tx, "n".repeat(32)))).toBe(false);

    const held = gate<number>();
    const order: string[] = [];
    const first = testDb().transaction(async (tx) => {
      await lockUser(tx, user.id);
      const pid = await backendPid(tx);
      held.open(pid);
      expect(await untilBlockedBy(pid)).toBe("blocked");
      order.push("first ends");
    });
    await held.opened;
    const second = testDb().transaction(async (tx) => {
      await lockUser(tx, user.id);
      order.push("second has the lock");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first ends", "second has the lock"]);
  });
});

/** The owner's own limits out of the way, so that only the editor's ceiling can refuse. */
const roomyOwner: InvokeOptions = {
  settings: {
    ceilings: { ...SMALL.ceilings, CEIL_UPLOAD_BYTES_DAY: 1_000_000, CEIL_UPLOAD_COUNT_DAY: 1000 },
  },
};

describe("enforceUploadCeilings: the admission of one upload", () => {
  const admit = (
    owner: CeilingSubject,
    editor: CeilingSubject | undefined,
    bytes: number,
    options: InvokeOptions = small,
  ) =>
    invoke(
      null,
      (c) =>
        db(c).transaction(async (tx) => {
          await enforceUploadCeilings(c, { owner, editor }, { bytes, count: 1 }, { tx });
          // The caller's own row, in the same transaction: the next admission counts it.
          await tx.insert(uploads).values(uploadRow(owner.id, editor?.id ?? owner.id, bytes));
        }),
      options,
    );

  it("owner only: admits within the limit, refuses beyond it, on bytes and on count", async () => {
    const owner = await makeUser();
    const subject = { id: owner.id, account: oldAccount };
    expect(await admit(subject, undefined, 600)).toMatchObject({ ok: true });
    expect(await admit(subject, undefined, 401)).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "upload_user", dimension: "bytes" },
    });
    expect(await admit(subject, undefined, 400)).toMatchObject({ ok: true });
    // Two sessions are open; the count limit is 3.
    expect(await admit(subject, undefined, 0)).toMatchObject({ ok: true });
    expect(await admit(subject, undefined, 0)).toMatchObject({
      status: 429,
      details: { kind: "upload_user", dimension: "count" },
    });
    // A refused admission wrote nothing.
    expect(await testDb().select().from(uploads).where(eq(uploads.ownerId, owner.id))).toHaveLength(3);
    // Naming the owner as their own editor changes nothing: one ceiling, one lock.
    const self = await makeUser();
    const selfSubject = { id: self.id, account: oldAccount };
    expect(await admit(selfSubject, selfSubject, 1000)).toMatchObject({ ok: true });
    expect(await admit(selfSubject, selfSubject, 1)).toMatchObject({
      status: 429,
      details: { kind: "upload_user" },
    });
  });

  it("owner and editor: each ceiling refuses in turn, and the refusal names its kind", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const other = await makeUser();
    const ownerSubject = { id: owner.id, account: oldAccount };
    const editorSubject = { id: editor.id, account: oldAccount };
    // The editor's own limit is 500 here; the owner's 1000.
    const tight: InvokeOptions = {
      settings: {
        ceilings: { ...SMALL.ceilings, CEIL_EDITOR_UPLOAD_BYTES_DAY: 500, CEIL_UPLOAD_COUNT_DAY: 100 },
      },
    };
    expect(await admit(ownerSubject, editorSubject, 400, tight)).toMatchObject({ ok: true });
    expect(await admit(ownerSubject, editorSubject, 101, tight)).toMatchObject({
      status: 429,
      details: { kind: "upload_editor", dimension: "bytes" },
    });
    expect(await admit(ownerSubject, editorSubject, 100, tight)).toMatchObject({ ok: true });
    // The owner's day is half used by the editor; another editor meets the OWNER's ceiling.
    expect(await admit(ownerSubject, { id: other.id, account: oldAccount }, 501, tight)).toMatchObject({
      status: 429,
      details: { kind: "upload_user", dimension: "bytes" },
    });
    // And the owner's own upload meets it too.
    expect(await admit(ownerSubject, undefined, 501, tight)).toMatchObject({
      status: 429,
      details: { kind: "upload_user" },
    });
  });

  it("reads through the caller's transaction: a session inserted earlier in it already counts", async () => {
    const owner = await makeUser();
    const subject = { id: owner.id, account: oldAccount };
    const result = await invoke(
      null,
      (c) =>
        db(c).transaction(async (tx) => {
          await enforceUploadCeilings(c, { owner: subject }, { bytes: 600, count: 1 }, { tx });
          await tx.insert(uploads).values(uploadRow(owner.id, owner.id, 600));
          // Not committed yet — and it must count all the same.
          await enforceUploadCeilings(c, { owner: subject }, { bytes: 600, count: 1 }, { tx });
        }),
      small,
    );
    expect(result).toMatchObject({ ok: false, status: 429, error: "ceiling_exceeded" });
    // The refusal rolled the whole transaction back.
    expect(await testDb().select().from(uploads).where(eq(uploads.ownerId, owner.id))).toEqual([]);
  });

  it("an owner or an editor that does not exist is a 404", async () => {
    const real = { id: (await makeUser()).id, account: oldAccount };
    const ghost = { id: "n".repeat(32), account: oldAccount };
    expect(await admit(ghost, undefined, 1)).toMatchObject({ ok: false, status: 404, error: "not_found" });
    expect(await admit(real, ghost, 1)).toMatchObject({ ok: false, status: 404, error: "not_found" });
  });

  it("two parallel admissions into one owner's tree that fit alone but not together: exactly one is admitted", async () => {
    const owner = await makeUser();
    const subject = { id: owner.id, account: oldAccount };
    const [a, b] = await race(
      (c, tx) => enforceUploadCeilings(c, { owner: subject }, { bytes: 600, count: 1 }, { tx }),
      (tx) => tx.insert(uploads).values(uploadRow(owner.id, owner.id, 600)),
      small,
    );
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: false, status: 429, error: "ceiling_exceeded" });
    const open = await testDb().select().from(uploads).where(eq(uploads.ownerId, owner.id));
    expect(open.map((row) => row.size)).toEqual([600]);
  });

  it("the same for the editor's own ceiling, across two different owners' trees", async () => {
    const ownerA = await makeUser();
    const ownerB = await makeUser();
    const editor = await makeUser();
    const editorSubject = { id: editor.id, account: oldAccount };
    // Two different owners: only the editor's row and the editor's ceiling are shared.
    const aDecided = gate<number>();
    let bDecided = false;
    const admitInto = (ownerId: string, after: (tx: Tx) => Promise<void>, before: () => Promise<unknown>) =>
      invoke(
        null,
        async (c) => {
          await before();
          return db(c).transaction(async (tx) => {
            await enforceUploadCeilings(
              c,
              { owner: { id: ownerId, account: oldAccount }, editor: editorSubject },
              { bytes: 600, count: 1 },
              { tx },
            );
            await after(tx);
            await tx.insert(uploads).values(uploadRow(ownerId, editor.id, 600));
          });
        },
        roomyOwner,
      );
    const [a, b] = await Promise.all([
      admitInto(
        ownerA.id,
        async (tx) => {
          const pid = await backendPid(tx);
          aDecided.open(pid);
          await untilBlockedBy(pid, () => bDecided);
        },
        async () => {},
      ),
      admitInto(
        ownerB.id,
        async () => void (bDecided = true),
        () => aDecided.opened,
      ),
    ]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(b).toMatchObject({ status: 429, details: { kind: "upload_editor" } });
    expect(await testDb().select().from(uploads).where(eq(uploads.uploaderId, editor.id))).toHaveLength(1);
  });

  it("locks the two users lowest id first, whichever of them is the owner", async () => {
    const one = await makeUser();
    const two = await makeUser();
    const [low, high] = [one.id, two.id].sort() as [string, string];
    for (const [ownerId, editorId] of [
      [low, high],
      [high, low],
    ] as const) {
      const held = gate<number>();
      let observed: string | null = null;
      // The LOW user's row is held. An admission that locks in ascending order stops there,
      // holding nothing: the HIGH user's row can still be locked by someone else.
      const holder = testDb().transaction(async (tx) => {
        await lockUser(tx, low);
        const pid = await backendPid(tx);
        held.open(pid);
        await untilBlockedBy(pid);
        observed = await testDb()
          .transaction((probe) =>
            probe.execute(sql`SELECT id FROM "user" WHERE id = ${high} FOR UPDATE NOWAIT`),
          )
          .then(
            () => "free",
            () => "locked",
          );
      });
      await held.opened;
      const admission = admit(
        { id: ownerId, account: oldAccount },
        { id: editorId, account: oldAccount },
        10,
      );
      const [, admitted] = await Promise.all([holder, admission]);
      expect(observed, `owner is the ${ownerId === low ? "low" : "high"} id`).toBe("free");
      expect(admitted).toMatchObject({ ok: true });
    }
  });

  it("A uploads into B's tree while B uploads into A's: both finish — no deadlock", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const subjectA = { id: userA.id, account: oldAccount };
    const subjectB = { id: userB.id, account: oldAccount };
    // Each side stops right after its FIRST row lock until the other side has its first lock too
    // or is waiting for this one — the interleaving in which opposite lock orders deadlock.
    const firstLock = { one: gate<number>(), two: gate<number>() };
    const has = { one: false, two: false };
    const side = (me: "one" | "two", owner: CeilingSubject, editor: CeilingSubject) =>
      invoke(
        null,
        (c) =>
          db(c).transaction(async (tx) => {
            // A backstop only: a deadlock is reported by the server itself, well before this.
            await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
            const pid = await backendPid(tx);
            const other = me === "one" ? "two" : "one";
            const paused = afterFirstRowLock(tx, async () => {
              has[me] = true;
              firstLock[me].open(pid);
              await untilBlockedBy(pid, () => has[other]);
            });
            await enforceUploadCeilings(c, { owner, editor }, { bytes: 10, count: 1 }, { tx: paused });
            await tx.insert(uploads).values(uploadRow(owner.id, editor.id, 10));
          }),
        small,
      );
    const [one, two] = await Promise.all([side("one", subjectA, subjectB), side("two", subjectB, subjectA)]);
    expect(one, "A into B's tree").toMatchObject({ ok: true });
    expect(two, "B into A's tree").toMatchObject({ ok: true });
  });
});

describe("download_owner: everything one owner's public links serve in a day", () => {
  const owned: InvokeOptions = {
    settings: { ceilings: { ...SMALL.ceilings, CEIL_OWNER_LINK_BYTES_DAY: 1000 } },
  };
  const serve = (ownerId: string, linkId: string, bytes: number) =>
    invoke(
      null,
      async (c) => {
        // What the files host does for a link download: the link's own ceiling, and the owner's.
        await consumeCeiling(c, "download_owner", { id: ownerId, account: oldAccount }, { bytes });
        await consumeCeiling(c, "download_link", { id: linkId, account: oldAccount }, { bytes });
      },
      owned,
    );

  it("two links of ONE owner share the counter; another owner has their own", async () => {
    const owner = (await makeUser()).id;
    const other = (await makeUser()).id;
    const [linkA, linkB, linkC] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    expect(await serve(owner, linkA, 600)).toMatchObject({ ok: true });
    // Link B has served nothing — and the owner's day is 600 of 1000 used.
    expect(await serve(owner, linkB, 401)).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "download_owner", dimension: "bytes" },
    });
    expect(await serve(owner, linkB, 400)).toMatchObject({ ok: true });
    expect(await serve(owner, linkA, 1)).toMatchObject({ status: 429, details: { kind: "download_owner" } });
    expect(await todayTotals(testDb(), "link_owner", owner)).toEqual({ bytes: 1000, count: 0 });
    // Another owner's links are untouched by that.
    expect(await serve(other, linkC, 1000)).toMatchObject({ ok: true });
    expect(await todayTotals(testDb(), "link_owner", other)).toEqual({ bytes: 1000, count: 0 });
    // The owner's own (signed-in) downloads are another ledger altogether.
    expect(await todayTotals(testDb(), "user", owner)).toEqual({ bytes: 0, count: 0 });
  });

  it("two parallel downloads through two links of one owner that fit alone but not together: one is served", async () => {
    const owner = (await makeUser()).id;
    const [a, b] = await Promise.all([
      serve(owner, crypto.randomUUID(), 600),
      serve(owner, crypto.randomUUID(), 600),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(await todayTotals(testDb(), "link_owner", owner)).toEqual({ bytes: 600, count: 0 });
  });

  it("a refusal is counted in the metric under its own kind", async () => {
    const points: { blobs: string[] }[] = [];
    const subject = { id: (await makeUser()).id, account: oldAccount };
    await invoke(null, (c) => consumeCeiling(c, "download_owner", subject, { bytes: 1001 }), {
      ...owned,
      env: { METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) } },
    });
    expect(
      points.filter((point) => point.blobs[0] === "ceiling").map((point) => point.blobs.slice(1, 4)),
    ).toEqual([["refused", "download_owner", "bytes"]]);
  });
});

describe("link_user inside the caller's transaction", () => {
  const capped: InvokeOptions = {
    settings: {
      ceilings: { ...SMALL.ceilings, NEW_ACCOUNT_MAX_LINKS: 3, CEIL_LINKS_DAY: 100, NEW_ACCOUNT_FACTOR: 1 },
    },
  };

  it("counts the link and refuses at the live-link cap; a rolled-back creation is not counted", async () => {
    const young = await makeUser();
    const folder = await makeFolder(young.id);
    const subject = { id: young.id, account: { quotaBytes: 0, createdAt: new Date() } };
    const create = (fail = false) =>
      invoke(
        null,
        (c) =>
          db(c).transaction(async (tx) => {
            await consumeCeiling(c, "link_user", subject, { count: 1 }, { tx });
            await tx.insert(shareLinks).values(linkRow(folder.id, young.id));
            if (fail) throw new Error("the creation failed after the ceiling was consumed");
          }),
        capped,
      );
    expect(await create()).toMatchObject({ ok: true });
    expect(await create(true)).toMatchObject({ ok: false, status: 500 });
    // The failed creation left neither a link nor a count.
    expect(await todayTotals(testDb(), "link_user", young.id)).toEqual({ bytes: 0, count: 1 });
    expect(await create()).toMatchObject({ ok: true });
    expect(await create()).toMatchObject({ ok: true });
    expect(await create()).toMatchObject({
      ok: false,
      status: 429,
      error: "ceiling_exceeded",
      details: { kind: "link_user", dimension: "count" },
    });
    expect(await todayTotals(testDb(), "link_user", young.id)).toEqual({ bytes: 0, count: 3 });
  });

  it("the daily count is enforced in the same step (an old account, no cap)", async () => {
    const user = await makeUser();
    const folder = await makeFolder(user.id);
    const subject = { id: user.id, account: oldAccount };
    const create = () =>
      invoke(
        null,
        (c) =>
          db(c).transaction(async (tx) => {
            await consumeCeiling(c, "link_user", subject, { count: 1 }, { tx });
            await tx.insert(shareLinks).values(linkRow(folder.id, user.id));
          }),
        small,
      );
    for (let i = 0; i < 3; i++) expect(await create()).toMatchObject({ ok: true });
    expect(await create()).toMatchObject({ status: 429, details: { kind: "link_user", dimension: "count" } });
  });

  it("two parallel creations at one below the cap: exactly one link is made", async () => {
    const young = await makeUser();
    const folder = await makeFolder(young.id);
    const subject = { id: young.id, account: { quotaBytes: 0, createdAt: new Date() } };
    // NEW_ACCOUNT_MAX_LINKS - 1 live links already.
    for (let i = 0; i < 2; i++) await testDb().insert(shareLinks).values(linkRow(folder.id, young.id));
    const [a, b] = await race(
      (c, tx) => consumeCeiling(c, "link_user", subject, { count: 1 }, { tx }),
      (tx) => tx.insert(shareLinks).values(linkRow(folder.id, young.id)),
      capped,
    );
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: false, status: 429, error: "ceiling_exceeded" });
    expect(await testDb().select().from(shareLinks).where(eq(shareLinks.createdBy, young.id))).toHaveLength(
      3,
    );
  });
});
