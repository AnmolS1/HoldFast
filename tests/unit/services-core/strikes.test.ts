// Strikes: counted against the uploader, suspension at the third — through the auth layer's
// suspendUser, after the commit, exactly once.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../../src/shared/constants";
import { countActive } from "../../../src/worker/db/queries/strikes";
import { strikes } from "../../../src/worker/db/schema";
import { AppError } from "../../../src/worker/services/errors";
import { addStrike, liftStrike } from "../../../src/worker/services/strikes";
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
    expect(first).toMatchObject({ activeStrikes: 1, suspended: false, applySuspension: null });
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
