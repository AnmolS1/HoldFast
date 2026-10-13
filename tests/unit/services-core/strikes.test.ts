// Strikes: counted against the uploader, suspension at the third — through the auth layer's
// suspendUser, after the commit, exactly once.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../../src/shared/constants";
import { countActive, insert, usersAtThreshold } from "../../../src/worker/db/queries/strikes";
import { strikes, user as userTable } from "../../../src/worker/db/schema";
import { AppError } from "../../../src/worker/services/errors";
import {
  addStrike,
  enforceStrikeThreshold,
  liftStrike,
  sweepStrikeThresholds,
} from "../../../src/worker/services/strikes";
import {
  auditRows,
  linkById,
  mailTo,
  makeFolder,
  makeLink,
  serviceDeps,
  sessionsOf,
  testDb,
  userById,
  verifiedUser,
} from "../auth/helpers";

const strikeRows = (userId: string) => testDb().select().from(strikes).where(eq(strikes.userId, userId));

/** Runs `work` with a ServiceDeps and waits for everything it deferred (audit rows, mail). */
async function settled<T>(work: (deps: ReturnType<typeof serviceDeps>["deps"]) => Promise<T>): Promise<T> {
  const { deps, settle } = serviceDeps();
  const result = await work(deps);
  await settle();
  return result;
}

describe("addStrike", () => {
  it("the constants are 3 strikes in 365 days", () => {
    expect(STRIKES_TO_SUSPEND).toBe(3);
    expect(STRIKE_WINDOW_DAYS).toBe(365);
  });

  it("the third strike suspends through suspendUser: sessions ended, links paused, one email", async () => {
    const { user, email } = await verifiedUser();
    const folder = await makeFolder(user.id);
    const link = await makeLink(folder.id, user.id);
    expect(await sessionsOf(user.id)).toHaveLength(1);

    const first = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "malware", nodeId: folder.id }),
    );
    expect(first).toMatchObject({ created: true, activeStrikes: 1, suspended: false, applySuspension: null });
    const second = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "dmca", note: "notice 7" }),
    );
    expect(second).toMatchObject({ activeStrikes: 2, suspended: false });
    // Two strikes change nothing about the account.
    expect((await userById(user.id))!.suspendedAt).toBeNull();
    expect(await sessionsOf(user.id)).toHaveLength(1);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);

    const third = await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));
    expect(third).toMatchObject({ activeStrikes: 3, suspended: true, applySuspension: null });
    const after = await userById(user.id);
    expect(after!.suspendedAt).toBeInstanceOf(Date);
    expect(after!.suspendedReason).toBe("strikes");
    expect(await sessionsOf(user.id)).toEqual([]);
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_suspended"]);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
    expect(await auditRows({ action: "account.suspended", targetId: user.id })).toHaveLength(1);

    const audits = await auditRows({ action: "strike.added", targetId: user.id });
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => row.actorType)).toEqual(["system", "system", "system"]);
    expect(audits.find((row) => row.meta?.strikeId === first.strikeId)?.meta).toMatchObject({
      kind: "malware",
      nodeId: folder.id,
      activeStrikes: 1,
    });
    const rows = await strikeRows(user.id);
    expect(rows.map((row) => row.kind).sort()).toEqual(["abuse", "dmca", "malware"]);
    expect(rows.find((row) => row.id === second.strikeId)).toMatchObject({
      note: "notice 7",
      issuedBy: null,
    });

    // A fourth strike on a suspended account: recorded, and nothing happens twice.
    const fourth = await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));
    expect(fourth).toMatchObject({ activeStrikes: 4, suspended: true });
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
    expect(await auditRows({ action: "account.suspended", targetId: user.id })).toHaveLength(1);
  });

  it("a strike issued by an admin is recorded with that admin", async () => {
    const admin = await verifiedUser();
    const { user } = await verifiedUser();
    const result = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "dmca", issuedBy: admin.user.id }),
    );
    expect((await strikeRows(user.id))[0]).toMatchObject({ id: result.strikeId, issuedBy: admin.user.id });
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toMatchObject([
      { actorType: "admin", actorUserId: admin.user.id },
    ]);
  });

  it("a lifted strike does not count: lifting one keeps the next strike below the threshold", async () => {
    const admin = await verifiedUser();
    const { user } = await verifiedUser();
    const first = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca" }));
    await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca" }));

    const lifted = await settled((deps) => liftStrike(deps, first.strikeId, admin.user.id));
    expect(lifted).toEqual({ activeStrikes: 1 });
    expect((await strikeRows(user.id)).find((row) => row.id === first.strikeId)).toMatchObject({
      liftedBy: admin.user.id,
    });
    expect(await auditRows({ action: "strike.lifted", targetId: user.id })).toMatchObject([
      {
        actorType: "admin",
        actorUserId: admin.user.id,
        meta: { strikeId: first.strikeId, activeStrikes: 1 },
      },
    ]);

    // The third strike ROW is only the second active one: no suspension.
    const next = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware" }));
    expect(next).toMatchObject({ activeStrikes: 2, suspended: false });
    expect((await userById(user.id))!.suspendedAt).toBeNull();
    // The control: one more — three active — suspends.
    const last = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware" }));
    expect(last).toMatchObject({ activeStrikes: 3, suspended: true });
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);

    // Lifting twice, or lifting nothing, is a 404 and changes nothing.
    for (const id of [first.strikeId, crypto.randomUUID(), "not-an-id"]) {
      const error = await settled((deps) => liftStrike(deps, id, admin.user.id)).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("not_found");
    }
    expect(await auditRows({ action: "strike.lifted", targetId: user.id })).toHaveLength(1);
  });

  it("a strike older than the window does not count", async () => {
    const { user } = await verifiedUser();
    const old = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca" }));
    await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca" }));
    const age = (days: number) =>
      testDb()
        .update(strikes)
        .set({ at: sql`now() - make_interval(days => ${days})` })
        .where(eq(strikes.id, old.strikeId));

    await age(STRIKE_WINDOW_DAYS + 1);
    expect(await countActive(testDb(), user.id, STRIKE_WINDOW_DAYS)).toBe(1);
    const third = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca" }));
    expect(third).toMatchObject({ activeStrikes: 2, suspended: false });
    expect((await userById(user.id))!.suspendedAt).toBeNull();

    // The control: the same strike one day inside the window counts, and the next one suspends.
    await age(STRIKE_WINDOW_DAYS - 1);
    expect(await countActive(testDb(), user.id, STRIKE_WINDOW_DAYS)).toBe(3);
    const fourth = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca" }));
    expect(fourth).toMatchObject({ activeStrikes: 4, suspended: true });
  });

  it("strikes are per user", async () => {
    const a = await verifiedUser();
    const b = await verifiedUser();
    for (let i = 0; i < 2; i++)
      await settled((deps) => addStrike(deps, { userId: a.user.id, kind: "abuse" }));
    const other = await settled((deps) => addStrike(deps, { userId: b.user.id, kind: "abuse" }));
    expect(other).toMatchObject({ activeStrikes: 1, suspended: false });
    expect((await userById(a.user.id))!.suspendedAt).toBeNull();
  });
});

describe("addStrike inside a caller's transaction", () => {
  async function withTwoStrikes() {
    const created = await verifiedUser();
    const folder = await makeFolder(created.user.id);
    const link = await makeLink(folder.id, created.user.id);
    for (let i = 0; i < 2; i++) {
      await settled((deps) => addStrike(deps, { userId: created.user.id, kind: "malware" }));
    }
    return { ...created, link };
  }

  it("writes only the strike row — no audit row, no suspension — until applySuspension() runs after the commit", async () => {
    const { user, email, link } = await withTwoStrikes();
    const { deps, deferred, settle } = serviceDeps();
    let insideTx: { rowsSeenOutside: number; audits: number; suspendedAt: Date | null } | null = null;

    const result = await testDb().transaction(async (tx) => {
      const added = await addStrike(deps, { userId: user.id, kind: "malware" }, { tx });
      // Still inside the caller's transaction: the row is the caller's, nothing else has happened.
      insideTx = {
        rowsSeenOutside: (await strikeRows(user.id)).length,
        audits: (await auditRows({ action: "strike.added", targetId: user.id })).length,
        suspendedAt: (await userById(user.id))!.suspendedAt,
      };
      return added;
    });
    expect(insideTx).toEqual({ rowsSeenOutside: 2, audits: 2, suspendedAt: null });
    expect(result).toMatchObject({ activeStrikes: 3, suspended: false });
    expect(typeof result.applySuspension).toBe("function");
    expect(deferred, "nothing was deferred by the tx form").toHaveLength(0);

    // Committed, and applySuspension not yet awaited: the row exists, and still nothing else.
    await settle();
    expect(await strikeRows(user.id)).toHaveLength(3);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(2);
    expect((await userById(user.id))!.suspendedAt).toBeNull();
    expect(await sessionsOf(user.id)).toHaveLength(1);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
    expect(mailTo(email, "accountSuspended")).toHaveLength(0);

    await result.applySuspension!();
    await settle();
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(3);
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);
    expect(await sessionsOf(user.id)).toEqual([]);
    expect((await linkById(link.id)).pauseReasons).toEqual(["owner_suspended"]);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);

    // Awaited again (a redelivered message): nothing happens twice.
    await result.applySuspension!();
    await settle();
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(3);
    expect(await auditRows({ action: "account.suspended", targetId: user.id })).toHaveLength(1);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
  });

  it("a caller's rollback leaves no strike, and nothing to apply was ever done", async () => {
    const { user } = await withTwoStrikes();
    const { deps, settle } = serviceDeps();
    await expect(
      testDb().transaction(async (tx) => {
        await addStrike(deps, { userId: user.id, kind: "malware" }, { tx });
        throw new Error("the caller's verdict failed");
      }),
    ).rejects.toThrow("the caller's verdict failed");
    await settle();
    expect(await strikeRows(user.id)).toHaveLength(2);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(2);
    expect((await userById(user.id))!.suspendedAt).toBeNull();
  });

  it("below the threshold applySuspension writes the audit row and suspends nobody", async () => {
    const { user } = await verifiedUser();
    const { deps, settle } = serviceDeps();
    const result = await testDb().transaction((tx) =>
      addStrike(deps, { userId: user.id, kind: "dmca" }, { tx }),
    );
    await result.applySuspension!();
    await settle();
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(1);
    expect((await userById(user.id))!.suspendedAt).toBeNull();
  });

  it("two third strikes that land together still suspend (the decision is taken after the commit)", async () => {
    const { user, email } = await withTwoStrikes();
    // Lift one, so that the two concurrent strikes are the second and the third.
    const [one] = await strikeRows(user.id);
    await testDb().update(strikes).set({ liftedAt: new Date() }).where(eq(strikes.id, one!.id));

    const { deps, settle } = serviceDeps();
    const [a, b] = await Promise.all([
      testDb().transaction((tx) => addStrike(deps, { userId: user.id, kind: "abuse" }, { tx })),
      testDb().transaction((tx) => addStrike(deps, { userId: user.id, kind: "abuse" }, { tx })),
    ]);
    await Promise.all([a.applySuspension!(), b.applySuspension!()]);
    await settle();
    expect(await countActive(testDb(), user.id, STRIKE_WINDOW_DAYS)).toBe(3);
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
  });
});

// A 64-character hex digest that belongs to no real content.
const fakeSha = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A ServiceDeps whose database refuses to open a transaction `times` times: suspendUser throws. */
function failingSuspension(times = 1) {
  const made = serviceDeps();
  let left = times;
  const db = new Proxy(made.deps.db, {
    get(target, property, receiver) {
      if (property === "transaction" && left > 0) {
        return () => {
          left -= 1;
          return Promise.reject(new Error("the database is unavailable (made up for the test)"));
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...made, deps: { ...made.deps, db } };
}

describe("the same violation strikes once", () => {
  it("the same user, kind and node twice: one row, one audit row, the count unchanged", async () => {
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    const first = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware", nodeId }));
    expect(first).toMatchObject({ created: true, activeStrikes: 1 });
    // A redelivered verdict, twice more.
    for (let i = 0; i < 2; i++) {
      const again = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware", nodeId }));
      expect(again).toMatchObject({
        strikeId: first.strikeId,
        created: false,
        activeStrikes: 1,
        suspended: false,
      });
    }
    expect(await strikeRows(user.id)).toHaveLength(1);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(1);
    expect((await userById(user.id))!.suspendedAt, "three deliveries are not three strikes").toBeNull();
  });

  it("the same content on three different nodes: one strike, and no suspension", async () => {
    const { user } = await verifiedUser();
    const sha256 = fakeSha();
    const first = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "malware", nodeId: uuidv7(), sha256 }),
    );
    for (let i = 0; i < 2; i++) {
      const retry = await settled((deps) =>
        addStrike(deps, { userId: user.id, kind: "malware", nodeId: uuidv7(), sha256 }),
      );
      expect(retry).toMatchObject({ strikeId: first.strikeId, created: false, activeStrikes: 1 });
    }
    expect(await strikeRows(user.id)).toMatchObject([{ contentSha256: sha256 }]);
    expect((await userById(user.id))!.suspendedAt).toBeNull();
    // The control: three DIFFERENT bad files are three strikes and a suspension.
    for (let i = 0; i < 2; i++) {
      await settled((deps) =>
        addStrike(deps, { userId: user.id, kind: "malware", nodeId: uuidv7(), sha256: fakeSha() }),
      );
    }
    expect(await strikeRows(user.id)).toHaveLength(3);
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);
  });

  it("another kind, another node, another hash or another user is another strike", async () => {
    const a = await verifiedUser();
    const b = await verifiedUser();
    const nodeId = uuidv7();
    const sha256 = fakeSha();
    const add = (input: Parameters<typeof addStrike>[1]) => settled((deps) => addStrike(deps, input));
    expect((await add({ userId: a.user.id, kind: "malware", nodeId, sha256 })).created).toBe(true);
    expect((await add({ userId: a.user.id, kind: "dmca", nodeId, sha256 })).created).toBe(true);
    expect((await add({ userId: b.user.id, kind: "malware", nodeId, sha256 })).created).toBe(true);
    expect(
      (await add({ userId: b.user.id, kind: "malware", nodeId: uuidv7(), sha256: fakeSha() })).created,
    ).toBe(true);
    expect(await strikeRows(a.user.id)).toHaveLength(2);
    expect(await strikeRows(b.user.id)).toHaveLength(2);
  });

  it("a strike with neither a node nor a hash is never de-duplicated", async () => {
    const { user } = await verifiedUser();
    const one = await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));
    const two = await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));
    expect(one.created && two.created).toBe(true);
    expect(two.strikeId).not.toBe(one.strikeId);
    expect(two.activeStrikes).toBe(2);
  });

  it("a lifted strike does not block a new one for the same node or the same content", async () => {
    const admin = await verifiedUser();
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    const sha256 = fakeSha();
    const first = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca", nodeId, sha256 }));
    await settled((deps) => liftStrike(deps, first.strikeId, admin.user.id));
    const byNode = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca", nodeId }));
    expect(byNode.created).toBe(true);
    expect(byNode.strikeId).not.toBe(first.strikeId);
    // The same node once more: the UNLIFTED strike is the existing one, not the older lifted one.
    const repeat = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca", nodeId }));
    expect(repeat).toMatchObject({ strikeId: byNode.strikeId, created: false });
    const byContent = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca", sha256 }));
    expect(byContent.created).toBe(true);
    expect(await strikeRows(user.id)).toHaveLength(3);
    expect(await countActive(testDb(), user.id, STRIKE_WINDOW_DAYS)).toBe(2);
  });

  it("node matches one strike and content another: the older one is returned", async () => {
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    const sha256 = fakeSha();
    const byContent = await insert(
      testDb(),
      { userId: user.id, kind: "malware", sha256 },
      STRIKE_WINDOW_DAYS,
    );
    const byNode = await insert(testDb(), { userId: user.id, kind: "malware", nodeId }, STRIKE_WINDOW_DAYS);
    expect(byContent.created && byNode.created).toBe(true);
    expect(
      await insert(testDb(), { userId: user.id, kind: "malware", nodeId, sha256 }, STRIKE_WINDOW_DAYS),
    ).toEqual({
      id: byContent.id,
      created: false,
    });
    await testDb()
      .update(strikes)
      .set({ at: sql`now() - interval '1 day'` })
      .where(eq(strikes.id, byNode.id));
    expect(
      await insert(testDb(), { userId: user.id, kind: "malware", nodeId, sha256 }, STRIKE_WINDOW_DAYS),
    ).toEqual({
      id: byNode.id,
      created: false,
    });
    expect(await strikeRows(user.id)).toHaveLength(2);
  });

  it("two concurrent inserts of the same key, in real transactions, leave one row", async () => {
    const { user } = await verifiedUser();
    for (const key of [{ nodeId: uuidv7() }, { sha256: fakeSha() }]) {
      const before = (await strikeRows(user.id)).length;
      const results = await Promise.all(
        // Different nodes for the hash case: the content is what collides.
        [0, 1, 2, 3].map(() =>
          testDb().transaction((tx) =>
            insert(
              tx,
              {
                userId: user.id,
                kind: "malware",
                ...("sha256" in key ? { nodeId: uuidv7() } : {}),
                ...key,
              },
              STRIKE_WINDOW_DAYS,
            ),
          ),
        ),
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect((await strikeRows(user.id)).length - before).toBe(1);
    }
  });

  it("the table itself refuses a second unlifted row for the same node or content", async () => {
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    const sha256 = fakeSha();
    const row = { userId: user.id, kind: "malware" as const };
    await testDb()
      .insert(strikes)
      .values({ ...row, nodeId });
    await expect(
      testDb()
        .insert(strikes)
        .values({ ...row, nodeId }),
    ).rejects.toThrow();
    await testDb()
      .insert(strikes)
      .values({ ...row, contentSha256: sha256 });
    await expect(
      testDb()
        .insert(strikes)
        .values({ ...row, contentSha256: sha256 }),
    ).rejects.toThrow();
    // Neither key: any number.
    await testDb().insert(strikes).values([row, row]);
  });

  it("in a caller's transaction a repeated strike adds nothing and audits nothing, and still enforces", async () => {
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware", nodeId }));
    const { deps, settle } = serviceDeps();
    const again = await testDb().transaction((tx) =>
      addStrike(deps, { userId: user.id, kind: "malware", nodeId }, { tx }),
    );
    expect(again).toMatchObject({ created: false, activeStrikes: 1, suspended: false });
    await again.applySuspension!();
    await settle();
    expect(await strikeRows(user.id)).toHaveLength(1);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(1);
  });
});

const atThreshold = async (limit = 1000) =>
  (await usersAtThreshold(testDb(), STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND, limit)).map(
    (found) => found.userId,
  );

describe("a committed strike can never leave the account un-suspended", () => {
  /** Three unlifted strikes written as rows only: the state a consumer killed after its commit leaves. */
  async function atThresholdUnsuspended() {
    const created = await verifiedUser();
    const { deps } = serviceDeps();
    for (let i = 0; i < STRIKES_TO_SUSPEND; i++) {
      // The tx form, and applySuspension is never called.
      await testDb().transaction((tx) =>
        addStrike(deps, { userId: created.user.id, kind: "malware" }, { tx }),
      );
    }
    expect((await userById(created.user.id))!.suspendedAt).toBeNull();
    return created;
  }

  it("applySuspension never called: the sweep suspends, with exactly one email", async () => {
    const { user, email } = await atThresholdUnsuspended();
    expect(await atThreshold()).toContain(user.id);

    const swept = await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect(swept.checked).toBeGreaterThanOrEqual(1);
    expect(swept.suspended).toBeGreaterThanOrEqual(1);
    expect(swept.failed).toBe(0);
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);
    expect((await userById(user.id))!.suspendedReason).toBe("strikes");
    expect(await sessionsOf(user.id)).toEqual([]);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);

    // Swept again: the user is no longer found, and nothing is sent twice.
    expect(await atThreshold()).not.toContain(user.id);
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
    expect(await auditRows({ action: "account.suspended", targetId: user.id })).toHaveLength(1);
  });

  it("a redelivery repairs it: the repeated strike adds no row and enforces the threshold", async () => {
    const created = await verifiedUser();
    const nodeId = uuidv7();
    const { deps } = serviceDeps();
    for (let i = 0; i < 2; i++)
      await settled((d) => addStrike(d, { userId: created.user.id, kind: "abuse" }));
    // The third strike commits, and the consumer dies before applySuspension.
    await testDb().transaction((tx) =>
      addStrike(deps, { userId: created.user.id, kind: "malware", nodeId }, { tx }),
    );
    expect((await userById(created.user.id))!.suspendedAt).toBeNull();
    // The message is delivered again.
    const again = await settled((d) => addStrike(d, { userId: created.user.id, kind: "malware", nodeId }));
    expect(again).toMatchObject({ created: false, activeStrikes: 3, suspended: true });
    expect(await strikeRows(created.user.id)).toHaveLength(3);
    expect((await userById(created.user.id))!.suspendedAt).toBeInstanceOf(Date);
  });

  it("a suspension that fails is not swallowed: addStrike rejects, the row exists, enforcing later suspends", async () => {
    const { user, email } = await verifiedUser();
    for (let i = 0; i < 2; i++) await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));

    const failing = failingSuspension(1);
    await expect(addStrike(failing.deps, { userId: user.id, kind: "abuse" })).rejects.toThrow(
      "the database is unavailable",
    );
    await failing.settle();
    expect(await strikeRows(user.id)).toHaveLength(3);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(3);
    expect((await userById(user.id))!.suspendedAt, "the suspension did fail").toBeNull();

    const enforced = await settled((deps) => enforceStrikeThreshold(deps, user.id));
    expect(enforced).toEqual({ activeStrikes: 3, suspended: true });
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
    // Enforcing again changes nothing.
    expect(await settled((deps) => enforceStrikeThreshold(deps, user.id))).toEqual({
      activeStrikes: 3,
      suspended: true,
    });
    expect(mailTo(email, "accountSuspended")).toHaveLength(1);
  });

  it("applySuspension can be awaited again after it failed", async () => {
    const { user } = await verifiedUser();
    for (let i = 0; i < 2; i++) await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));
    const failing = failingSuspension(1);
    const result = await testDb().transaction((tx) =>
      addStrike(failing.deps, { userId: user.id, kind: "abuse" }, { tx }),
    );
    await expect(result.applySuspension!()).rejects.toThrow("the database is unavailable");
    expect((await userById(user.id))!.suspendedAt).toBeNull();
    await result.applySuspension!();
    await failing.settle();
    expect((await userById(user.id))!.suspendedAt).toBeInstanceOf(Date);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(3);
  });

  it("enforceStrikeThreshold below the threshold counts and suspends nobody", async () => {
    const { user } = await verifiedUser();
    for (let i = 0; i < 2; i++) await settled((deps) => addStrike(deps, { userId: user.id, kind: "abuse" }));
    expect(await settled((deps) => enforceStrikeThreshold(deps, user.id))).toEqual({
      activeStrikes: 2,
      suspended: false,
    });
    expect((await userById(user.id))!.suspendedAt).toBeNull();
  });

  it("the sweep ignores users below the threshold, suspended users, lifted strikes and strikes outside the window", async () => {
    const admin = await verifiedUser();
    const rowsOnly = async (userId: string, count: number) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++)
        ids.push((await insert(testDb(), { userId, kind: "abuse" }, STRIKE_WINDOW_DAYS)).id);
      return ids;
    };
    const below = await verifiedUser();
    await rowsOnly(below.user.id, 2);
    const lifted = await verifiedUser();
    const [liftMe] = await rowsOnly(lifted.user.id, 3);
    await settled((deps) => liftStrike(deps, liftMe!, admin.user.id));
    const stale = await verifiedUser();
    const [ageMe] = await rowsOnly(stale.user.id, 3);
    await testDb()
      .update(strikes)
      .set({ at: sql`now() - make_interval(days => ${STRIKE_WINDOW_DAYS + 1})` })
      .where(eq(strikes.id, ageMe!));
    const already = await atThresholdUnsuspended();
    await settled((deps) => enforceStrikeThreshold(deps, already.user.id));
    const mailsBefore = mailTo(already.email, "accountSuspended").length;
    // The control: a user at the threshold, unsuspended — the sweep must take this one.
    const due = await atThresholdUnsuspended();

    const found = await atThreshold();
    expect(found).toContain(due.user.id);
    for (const ignored of [below, lifted, stale, already]) expect(found).not.toContain(ignored.user.id);

    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect((await userById(due.user.id))!.suspendedAt).toBeInstanceOf(Date);
    for (const ignored of [below, lifted, stale]) {
      expect((await userById(ignored.user.id))!.suspendedAt).toBeNull();
      expect(mailTo(ignored.email, "accountSuspended")).toEqual([]);
    }
    expect(mailTo(already.email, "accountSuspended")).toHaveLength(mailsBefore);
    expect(await auditRows({ action: "account.suspended", targetId: already.user.id })).toHaveLength(1);
  });

  it("one failing user does not stop the rest of the sweep, and is met again by the next", async () => {
    const one = await atThresholdUnsuspended();
    const two = await atThresholdUnsuspended();
    const failing = failingSuspension(1);
    const swept = await sweepStrikeThresholds(failing.deps, { limit: 1000 });
    await failing.settle();
    expect(swept.failed).toBe(1);
    expect(swept.checked).toBeGreaterThanOrEqual(2);
    expect(swept.suspended).toBe(swept.checked - 1);
    // Whoever the failure hit, the next sweep finishes the job for both.
    const next = await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect(next.failed).toBe(0);
    for (const user of [one, two]) expect((await userById(user.user.id))!.suspendedAt).toBeInstanceOf(Date);
  });

  it("`suspended` counts only the users this run suspended, not the ones it merely found at the threshold", async () => {
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    const one = await atThresholdUnsuspended();
    const two = await atThresholdUnsuspended();
    // Between the sweep's read of the list and its turn for `two`, something else suspends `two`
    // (the redelivery that repairs it, say): the first transaction the sweep opens is `one`'s
    // suspension, and `two` is suspended just before it runs.
    const made = serviceDeps();
    let raced = false;
    const racing = new Proxy(made.deps.db, {
      get(target, property, receiver) {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        const call = (member as (...args: unknown[]) => unknown).bind(target);
        if (property !== "transaction" || raced) return call;
        return async (...args: unknown[]) => {
          raced = true;
          await settled((deps) => enforceStrikeThreshold(deps, two.user.id));
          return call(...args);
        };
      },
    });
    const swept = await sweepStrikeThresholds({ ...made.deps, db: racing }, { limit: 1000 });
    await made.settle();
    expect(swept).toEqual({ checked: 2, suspended: 1, failed: 0 });
    for (const user of [one, two]) expect((await userById(user.user.id))!.suspendedAt).toBeInstanceOf(Date);
  });

  it("the sweep is bounded and takes the oldest first", async () => {
    const older = await atThresholdUnsuspended();
    const newer = await atThresholdUnsuspended();
    // Make `older` the oldest case there is.
    await testDb()
      .update(strikes)
      .set({ at: sql`now() - make_interval(days => ${STRIKE_WINDOW_DAYS - 1})` })
      .where(eq(strikes.userId, older.user.id));
    expect((await atThreshold(1))[0]).toBe(older.user.id);
    const swept = await settled((deps) => sweepStrikeThresholds(deps, { limit: 1 }));
    expect(swept).toEqual({ checked: 1, suspended: 1, failed: 0 });
    expect((await userById(older.user.id))!.suspendedAt).toBeInstanceOf(Date);
    expect((await userById(newer.user.id))!.suspendedAt).toBeNull();
    // Leave nothing at the threshold behind for other tests' sweeps.
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect((await userById(newer.user.id))!.suspendedAt).toBeInstanceOf(Date);
  });
});

describe("an expired strike does not swallow a new violation", () => {
  const ageTo = (strikeId: string, days: number) =>
    testDb()
      .update(strikes)
      .set({ at: sql`now() - make_interval(days => ${days})` })
      .where(eq(strikes.id, strikeId));

  it("the same content after 366 days: the old strike is lifted as expired and a NEW one is created", async () => {
    const { user } = await verifiedUser();
    const sha256 = fakeSha();
    const old = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "malware", nodeId: uuidv7(), sha256, note: "first time" }),
    );
    await ageTo(old.strikeId, STRIKE_WINDOW_DAYS + 1);
    expect(await countActive(testDb(), user.id, STRIKE_WINDOW_DAYS)).toBe(0);

    const again = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "malware", nodeId: uuidv7(), sha256 }),
    );
    expect(again.created).toBe(true);
    expect(again.strikeId).not.toBe(old.strikeId);
    expect(again.activeStrikes).toBe(1);
    const rows = await strikeRows(user.id);
    expect(rows).toHaveLength(2);
    const lifted = rows.find((row) => row.id === old.strikeId)!;
    expect(lifted.liftedAt).toBeInstanceOf(Date);
    expect(lifted.liftedBy, "the system lifted it").toBeNull();
    expect(lifted.note).toBe(
      "first time [expired: lifted when a new strike was issued for the same file or content]",
    );
    expect(rows.find((row) => row.id === again.strikeId)).toMatchObject({
      liftedAt: null,
      contentSha256: sha256,
    });
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(2);
  });

  it("the same node after 366 days: likewise; and a note-less strike gets the note alone", async () => {
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    const old = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca", nodeId }));
    await ageTo(old.strikeId, STRIKE_WINDOW_DAYS + 1);
    const again = await settled((deps) => addStrike(deps, { userId: user.id, kind: "dmca", nodeId }));
    expect(again).toMatchObject({ created: true, activeStrikes: 1 });
    const lifted = (await strikeRows(user.id)).find((row) => row.id === old.strikeId)!;
    expect(lifted.liftedAt).toBeInstanceOf(Date);
    expect(lifted.note).toBe("[expired: lifted when a new strike was issued for the same file or content]");
  });

  it("at 364 days the old strike still counts: created false, nothing lifted (the control)", async () => {
    const { user } = await verifiedUser();
    const sha256 = fakeSha();
    const old = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware", sha256 }));
    await ageTo(old.strikeId, STRIKE_WINDOW_DAYS - 1);
    const again = await settled((deps) =>
      addStrike(deps, { userId: user.id, kind: "malware", nodeId: uuidv7(), sha256 }),
    );
    expect(again).toMatchObject({ strikeId: old.strikeId, created: false, activeStrikes: 1 });
    expect(await strikeRows(user.id)).toMatchObject([{ id: old.strikeId, liftedAt: null, note: null }]);
  });

  it("three violations of the same content, each after the last expired, are three strikes over the years — never zero", async () => {
    const { user } = await verifiedUser();
    const sha256 = fakeSha();
    for (let round = 0; round < 3; round++) {
      const strike = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware", sha256 }));
      expect(strike, `round ${round}`).toMatchObject({ created: true, activeStrikes: 1, suspended: false });
      await ageTo(strike.strikeId, STRIKE_WINDOW_DAYS + 1);
    }
    expect(await strikeRows(user.id)).toHaveLength(3);
  });

  it("an expired match on the node and a live one on the content: the live one is returned, the expired one stays", async () => {
    const { user } = await verifiedUser();
    const nodeId = uuidv7();
    const sha256 = fakeSha();
    const byNode = await insert(testDb(), { userId: user.id, kind: "malware", nodeId }, STRIKE_WINDOW_DAYS);
    const byContent = await insert(
      testDb(),
      { userId: user.id, kind: "malware", sha256 },
      STRIKE_WINDOW_DAYS,
    );
    await ageTo(byNode.id, STRIKE_WINDOW_DAYS + 1);
    expect(
      await insert(testDb(), { userId: user.id, kind: "malware", nodeId, sha256 }, STRIKE_WINDOW_DAYS),
    ).toEqual({
      id: byContent.id,
      created: false,
    });
    expect((await strikeRows(user.id)).find((row) => row.id === byNode.id)!.liftedAt).toBeNull();
  });

  it("inside a caller's transaction the lift and the new strike commit or roll back together", async () => {
    const { user } = await verifiedUser();
    const sha256 = fakeSha();
    const old = await settled((deps) => addStrike(deps, { userId: user.id, kind: "malware", sha256 }));
    await ageTo(old.strikeId, STRIKE_WINDOW_DAYS + 1);
    const { deps } = serviceDeps();
    await expect(
      testDb().transaction(async (tx) => {
        const added = await addStrike(deps, { userId: user.id, kind: "malware", sha256 }, { tx });
        expect(added.created).toBe(true);
        throw new Error("the caller's verdict failed");
      }),
    ).rejects.toThrow("the caller's verdict failed");
    expect(await strikeRows(user.id)).toMatchObject([{ id: old.strikeId, liftedAt: null }]);
  });
});

describe("the sweep does not starve behind users it cannot change", () => {
  it("limit 2, two users whose suspension fails at the head, an ordinary user behind: suspended in the same run", async () => {
    // Leave nobody at the threshold from earlier tests, so the three below are the whole list.
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    const age = (userId: string, days: number) =>
      testDb()
        .update(strikes)
        .set({ at: sql`now() - make_interval(days => ${days})` })
        .where(eq(strikes.userId, userId));
    const threeRows = async () => {
      const created = await verifiedUser();
      for (let i = 0; i < STRIKES_TO_SUSPEND; i++) {
        await insert(testDb(), { userId: created.user.id, kind: "abuse" }, STRIKE_WINDOW_DAYS);
      }
      return created;
    };
    const stuckA = await threeRows();
    const stuckB = await threeRows();
    const ordinary = await threeRows();
    // The two stuck users are the oldest cases there are; the ordinary one comes after them.
    await age(stuckA.user.id, STRIKE_WINDOW_DAYS - 1);
    await age(stuckB.user.id, STRIKE_WINDOW_DAYS - 2);
    await age(ordinary.user.id, STRIKE_WINDOW_DAYS - 3);
    expect((await atThreshold(3)).slice(0, 3)).toEqual([stuckA.user.id, stuckB.user.id, ordinary.user.id]);

    // Suspension fails for the first two users the sweep meets: the head of the list.
    const failing = failingSuspension(2);
    const swept = await sweepStrikeThresholds(failing.deps, { limit: 2 });
    await failing.settle();
    expect(swept.failed).toBe(2);
    expect(swept.suspended).toBeGreaterThanOrEqual(1);
    expect((await userById(stuckA.user.id))!.suspendedAt).toBeNull();
    expect((await userById(stuckB.user.id))!.suspendedAt).toBeNull();
    expect(
      (await userById(ordinary.user.id))!.suspendedAt,
      "the user behind them was reached",
    ).toBeInstanceOf(Date);

    // Clean up: nobody is left at the threshold.
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect((await userById(stuckA.user.id))!.suspendedAt).toBeInstanceOf(Date);
  });

  it("a run looks at no more than 20 users per user it may suspend", async () => {
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    const made = [];
    for (let i = 0; i < 3; i++) {
      const created = await verifiedUser();
      for (let j = 0; j < STRIKES_TO_SUSPEND; j++) {
        await insert(testDb(), { userId: created.user.id, kind: "abuse" }, STRIKE_WINDOW_DAYS);
      }
      made.push(created);
    }
    // Every suspension fails: the run examines what there is — far fewer than its bound — and ends.
    const failing = failingSuspension(1000);
    const swept = await sweepStrikeThresholds(failing.deps, { limit: 1 });
    expect(swept.suspended).toBe(0);
    expect(swept.failed).toBe(swept.checked);
    expect(swept.checked).toBeGreaterThanOrEqual(3);
    expect(swept.checked).toBeLessThanOrEqual(20);
    await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    for (const user of made) expect((await userById(user.user.id))!.suspendedAt).toBeInstanceOf(Date);
  });

  it("banned and deletion-scheduled accounts at the threshold are suspended like any other, and leave the list", async () => {
    const { user: bannedUser } = await verifiedUser();
    const { user: leaving } = await verifiedUser();
    for (const id of [bannedUser.id, leaving.id]) {
      for (let i = 0; i < STRIKES_TO_SUSPEND; i++)
        await insert(testDb(), { userId: id, kind: "abuse" }, STRIKE_WINDOW_DAYS);
    }
    await testDb().update(userTable).set({ banned: true }).where(eq(userTable.id, bannedUser.id));
    await testDb()
      .update(userTable)
      .set({ deleteScheduledAt: new Date(Date.now() + 86_400_000) })
      .where(eq(userTable.id, leaving.id));
    expect(await atThreshold()).toEqual(expect.arrayContaining([bannedUser.id, leaving.id]));
    const swept = await settled((deps) => sweepStrikeThresholds(deps, { limit: 1000 }));
    expect(swept.failed).toBe(0);
    for (const id of [bannedUser.id, leaving.id]) {
      expect((await userById(id))!.suspendedAt).toBeInstanceOf(Date);
      expect(await atThreshold()).not.toContain(id);
    }
  });
});
