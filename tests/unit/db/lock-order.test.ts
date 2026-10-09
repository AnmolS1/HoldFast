// Lock order between transactions that touch one owner: the `user` row first, then node rows
// (and, for scheduled deletion, the `user` row first, then the pending row).
//
// Every test here runs TWO real transactions on two connections against the local Postgres and
// controls the interleaving: one side takes its first lock and stops, the test waits until
// Postgres reports the other side as waiting for a lock (pg_stat_activity), then lets the first
// side go on. With the two sides locking in opposite orders that is a deadlock — Postgres aborts
// one of them with 40P01 — and which one it aborts is the whole problem.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, Tx } from "../../../src/worker/db/client";
import { LegalHoldError, pgError, QueryError } from "../../../src/worker/db/errors";
import { lockSuspectedCsam, setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import { getNode, replaceVersion } from "../../../src/worker/db/queries/nodes";
import { deleteSubtreeRows } from "../../../src/worker/db/queries/trash";
import { cancel, schedule } from "../../../src/worker/db/queries/user-purge";
import { userState } from "../../../src/worker/db/queries/users";
import { nodes, pendingUserPurges, user } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeUser, openDb, rand } from "./_helpers";

// Three pools: the two sides, and an observer that is never inside either transaction.
let a: { db: Db; close: () => Promise<void> };
let b: { db: Db; close: () => Promise<void> };
let watch: { db: Db; close: () => Promise<void> };
beforeAll(() => {
  a = openDb();
  b = openDb();
  watch = openDb();
});
afterAll(async () => {
  await Promise.all([a.close(), b.close(), watch.close()]);
});

const pidOf = async (tx: Tx): Promise<number> =>
  Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);

/** Resolves once that backend is blocked on a lock. Throws if it never is (it did not block). */
async function untilWaitingForLock(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await watch.db.execute<{ waiting: boolean }>(
      sql`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`,
    );
    if (result.rows[0]?.waiting === true) return;
    if (Date.now() > deadline) throw new Error(`${label}: the backend never waited for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** A promise with its resolver, so a transaction can be held open until the test says so. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((resolve) => (open = resolve));
  return { opened, open };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const sqlState = (outcome: Outcome<unknown>) => (outcome.ok ? null : (pgError(outcome.error)?.code ?? null));

describe("the CSAM lock beside a purge of the same owner", () => {
  /** A trashed folder holding the file a scan is about to flag. */
  async function evidence() {
    const owner = await makeUser(a.db);
    const folder = await makeFolder(a.db, owner, null, `due-${rand()}`, {
      deletedAt: new Date(Date.now() - 1000),
      trashedRoot: true,
      purgeAfter: new Date(Date.now() - 1000),
    });
    const file = await makeFile(a.db, owner, folder.id, `evidence-${rand()}.jpg`);
    return { owner, folder, file };
  }

  // The purge has taken the owner's row (its first lock). The CSAM lock starts. Then the purge
  // goes for the node rows. With the CSAM lock taking node-then-owner this is a deadlock, the
  // CSAM transaction is the one Postgres aborts, and the purge deletes the file.
  it("never deadlocks: the CSAM lock waits for the purge instead of being aborted by it", async () => {
    const { owner, folder, file } = await evidence();
    const csamPid = gate<number>();

    const purge = settle(
      a.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, owner)).for("update");
        await untilWaitingForLock(await csamPid.opened, "csam lock");
        return deleteSubtreeRows(tx, folder.id);
      }),
    );
    const csam = settle(
      b.db.transaction(async (tx) => {
        csamPid.open(await pidOf(tx));
        return lockSuspectedCsam(tx, file.id, { source: "photodna" });
      }),
    );
    const [purged, locked] = await Promise.all([purge, csam]);

    expect(sqlState(purged), "the purge was not a deadlock victim").not.toBe("40P01");
    expect(sqlState(locked), "the CSAM lock was not a deadlock victim").not.toBe("40P01");
    expect(locked.ok, "the CSAM lock did not fail").toBe(true);
    // The purge held the owner's row first, so it is the earlier transaction: it deleted the
    // rows, and the CSAM lock — which waited — found no node and says so.
    expect(purged).toMatchObject({ ok: true, value: { ownerId: owner } });
    expect(locked).toEqual({ ok: true, value: null });
    expect(await getNode(a.db, file.id)).toBeNull();
    // Nothing was half-applied by a rolled-back lock: no hold on the account.
    expect((await a.db.select({ held: user.legalHold }).from(user).where(eq(user.id, owner)))[0]!.held).toBe(
      false,
    );
  });

  // The other order: the CSAM lock is the earlier transaction. The purge must then see the hold.
  it("a CSAM lock that got there first is seen by the purge: nothing is deleted", async () => {
    const { owner, folder, file } = await evidence();
    const purgePid = gate<number>();
    const csamHoldsItsLocks = gate();

    const csam = settle(
      b.db.transaction(async (tx) => {
        const result = await lockSuspectedCsam(tx, file.id, { source: "photodna" });
        csamHoldsItsLocks.open();
        // Stay open until the purge is queued behind this transaction's locks.
        await untilWaitingForLock(await purgePid.opened, "purge");
        return result;
      }),
    );
    const purge = settle(
      a.db.transaction(async (tx) => {
        await csamHoldsItsLocks.opened;
        purgePid.open(await pidOf(tx));
        return deleteSubtreeRows(tx, folder.id);
      }),
    );
    const [locked, purged] = await Promise.all([csam, purge]);

    expect(sqlState(locked)).toBeNull();
    expect(locked).toMatchObject({ ok: true, value: { ownerId: owner } });
    expect(purged.ok).toBe(false);
    expect(purged.ok ? null : purged.error).toBeInstanceOf(LegalHoldError);
    expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await getNode(a.db, folder.id)).not.toBeNull();
    expect((await a.db.select({ held: user.legalHold }).from(user).where(eq(user.id, owner)))[0]!.held).toBe(
      true,
    );
    await a.db.delete(nodes).where(eq(nodes.id, file.id));
    await a.db.delete(nodes).where(eq(nodes.id, folder.id));
  });
});

describe("Replace beside a legal hold on the account", () => {
  // The hold is being placed (its transaction has written the owner's row and not committed).
  // A Replace must wait for it and then refuse — not read the old value and go ahead.
  it("waits for a hold that is being placed, then refuses", async () => {
    const owner = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `r-${rand()}.bin`);
    const replacePid = gate<number>();
    const next = {
      r2Key: `u/${owner}/${file.id}/v2`,
      versionId: "v2",
      size: 5,
      sha256: null,
      createdBy: owner,
    };

    const hold = settle(
      a.db.transaction(async (tx) => {
        await setUserLegalHold(tx, owner, true);
        await untilWaitingForLock(await replacePid.opened, "replace");
      }),
    );
    const replace = settle(
      b.db.transaction(async (tx) => {
        replacePid.open(await pidOf(tx));
        return replaceVersion(tx, file.id, next);
      }),
    );
    const [held, replaced] = await Promise.all([hold, replace]);

    expect(held.ok, "the Replace waited for the hold (it took the owner's row lock)").toBe(true);
    expect(replaced.ok).toBe(false);
    expect(replaced.ok ? null : replaced.error).toBeInstanceOf(QueryError);
    expect((replaced as { error: QueryError }).error.code).toBe("not_found");
    expect(await getNode(a.db, file.id)).toMatchObject({ r2Key: file.r2Key, versionId: file.versionId });
  });

  // Replace now takes owner-then-node, like the purge. Beside a purge that holds the owner's row
  // it must queue, not deadlock.
  it("does not deadlock with a purge of the same owner", async () => {
    const owner = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `rp-${rand()}.bin`);
    const replacePid = gate<number>();
    const next = {
      r2Key: `u/${owner}/${file.id}/v2`,
      versionId: "v2",
      size: 5,
      sha256: null,
      createdBy: owner,
    };

    const purge = settle(
      a.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, owner)).for("update");
        await untilWaitingForLock(await replacePid.opened, "replace");
        return deleteSubtreeRows(tx, file.id);
      }),
    );
    const replace = settle(
      b.db.transaction(async (tx) => {
        replacePid.open(await pidOf(tx));
        return replaceVersion(tx, file.id, next);
      }),
    );
    const [purged, replaced] = await Promise.all([purge, replace]);
    expect(sqlState(purged)).toBeNull();
    expect(sqlState(replaced)).toBeNull();
    expect(purged.ok).toBe(true);
    expect((replaced as { error: QueryError }).error.code).toBe("not_found");
  });
});

describe("cancelling a scheduled deletion beside re-scheduling it", () => {
  // The re-schedule has taken the owner's row. The cancel starts. Then the re-schedule goes for
  // the pending row. With cancel taking pending-then-user this is a deadlock and one of the two
  // requests fails with a 500.
  it("never deadlocks: both finish, and the later one decides the outcome", async () => {
    const owner = await makeUser(a.db);
    const first = new Date(Date.now() + 7 * 86_400_000);
    const moved = new Date(Date.now() + 14 * 86_400_000);
    expect(await schedule(a.db, owner, first)).toBe(true);
    const cancelPid = gate<number>();

    const reschedule = settle(
      a.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, owner)).for("update");
        await untilWaitingForLock(await cancelPid.opened, "cancel");
        return schedule(tx, owner, moved);
      }),
    );
    const cancelled = settle(
      b.db.transaction(async (tx) => {
        cancelPid.open(await pidOf(tx));
        return cancel(tx, owner);
      }),
    );
    const [scheduled, undone] = await Promise.all([reschedule, cancelled]);

    expect(sqlState(scheduled)).toBeNull();
    expect(sqlState(undone)).toBeNull();
    expect(scheduled).toEqual({ ok: true, value: true });
    expect(undone).toEqual({ ok: true, value: true });
    // The cancel waited for the re-schedule, so it ran last: nothing is scheduled.
    expect((await userState(a.db, owner))!.deleteScheduledAt).toBeNull();
    expect(await a.db.select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, owner))).toEqual(
      [],
    );
  });
});
