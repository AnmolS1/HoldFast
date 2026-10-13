// Lock order between transactions that touch one owner: the `user` row first, then node rows
// (and, for scheduled deletion, the `user` row first, then the pending row).
//
// Every test here runs TWO real transactions on two connections against the local Postgres and
// controls the interleaving: one side takes its first lock and stops, the test waits until
// Postgres reports the other side as waiting for a lock (pg_stat_activity), then lets the first
// side go on. With the two sides locking in opposite orders that is a deadlock — Postgres aborts
// one of them with 40P01 — and which one it aborts is the whole problem.
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db, Tx } from "../../../src/worker/db/client";
import { LegalHoldError, pgError, QueryError } from "../../../src/worker/db/errors";
import { lookup } from "../../../src/worker/db/queries/blocklist";
import {
  clearSuspectedCsam,
  lockSuspectedCsam,
  setUserLegalHold,
} from "../../../src/worker/db/queries/moderation";
import { getNode, replaceVersion } from "../../../src/worker/db/queries/nodes";
import { deleteSubtreeRows } from "../../../src/worker/db/queries/trash";
import { cancel, schedule } from "../../../src/worker/db/queries/user-purge";
import { userState } from "../../../src/worker/db/queries/users";
import {
  nodes,
  pendingUserPurges,
  reports,
  shareLinks,
  uploadIps,
  user,
} from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeLink, makeUser, openDb, rand } from "./_helpers";

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

/** Resolves once backend `pid` is blocked by backend `blocker` — by that one, not by an earlier one. */
async function untilBlockedBy(pid: number, blocker: number, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await watch.db.execute<{ blocked: boolean }>(
      sql`SELECT ${blocker}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked`,
    );
    if (result.rows[0]?.blocked === true) return;
    if (Date.now() > deadline) throw new Error(`${label}: the backend was never blocked by ${blocker}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** A promise with its resolver, so a transaction can be held open until the test says so. */
// Each test opens `ownerRowHeld` once the first transaction has its lock and the second waits for it
// before starting: two transactions begun together otherwise race for the row, and when the second
// wins it never queues — the first then waits for a lock wait that cannot happen (seen on CI).
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
    const ownerRowHeld = gate();

    const purge = settle(
      a.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, owner)).for("update");
        ownerRowHeld.open();
        await untilWaitingForLock(await csamPid.opened, "csam lock");
        return deleteSubtreeRows(tx, folder.id);
      }),
    );
    const csam = settle(
      b.db.transaction(async (tx) => {
        await ownerRowHeld.opened;
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

describe("the CSAM lock holds every uploader: user rows lowest id first, then the node", () => {
  const lockUserRow = (tx: Tx, id: string) =>
    tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for("update");
  const held = async (ids: string[]) =>
    (await watch.db.select({ id: user.id, held: user.legalHold }).from(user).where(inArray(user.id, ids)))
      .filter((u) => u.held)
      .map((u) => u.id)
      .sort();
  const address = (nodeId: string, uploaderId: string) =>
    watch.db.insert(uploadIps).values({
      nodeId,
      versionId: `v-${rand()}`,
      uploaderId,
      ipEncrypted: Buffer.from("c"),
      iv: Buffer.from("i"),
      keyVersion: 1,
    });

  // Two files whose owner and uploader are the other way round. One lock has taken its first
  // user row (the lower id) and stops; the other starts. Owner-first, the second would take ITS
  // owner (the higher id) and wait for the lower one, the first would then wait for the higher:
  // a deadlock. Lowest-first, the second waits at its first row holding nothing.
  it("two locks on files with owner and uploader swapped never deadlock", async () => {
    const [lo, hi] = [await makeUser(a.db), await makeUser(a.db)].sort() as [string, string];
    const fileOfLo = await makeFile(a.db, lo, null, `lo-${rand()}.jpg`, { createdBy: hi });
    const fileOfHi = await makeFile(a.db, hi, null, `hi-${rand()}.jpg`, { createdBy: lo });
    const secondPid = gate<number>();
    const firstRowHeld = gate();

    const first = settle(
      a.db.transaction(async (tx) => {
        // Where the lock on `fileOfLo` stands after its first step.
        await lockUserRow(tx, lo);
        firstRowHeld.open();
        await untilWaitingForLock(await secondPid.opened, "the second lock");
        return lockSuspectedCsam(tx, fileOfLo.id, { source: "photodna" });
      }),
    );
    const second = settle(
      b.db.transaction(async (tx) => {
        await firstRowHeld.opened;
        secondPid.open(await pidOf(tx));
        return lockSuspectedCsam(tx, fileOfHi.id, { source: "photodna" });
      }),
    );
    const [one, two] = await Promise.all([first, second]);
    expect(sqlState(one), "the first lock was not a deadlock victim").toBeNull();
    expect(sqlState(two), "the second lock was not a deadlock victim").toBeNull();
    expect(one).toMatchObject({ ok: true, value: { ownerId: lo } });
    expect(two).toMatchObject({ ok: true, value: { ownerId: hi } });
    expect(await held([lo, hi])).toEqual([lo, hi]);
    for (const file of [fileOfLo, fileOfHi]) {
      expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    }
  });

  // The set of uploaders is read before any lock. While the lock waits for the owner's row, a new
  // uploader's version is recorded: the locked re-read sees it, the locks are released and taken
  // again for the larger set, and the newcomer is held.
  it("an uploader who appears while the lock is waiting is held too", async () => {
    const owner = await makeUser(a.db);
    const newcomer = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `grow-${rand()}.jpg`);
    const lockPid = gate<number>();
    const ownerRowHeld = gate();

    const blocker = settle(
      a.db.transaction(async (tx) => {
        await lockUserRow(tx, owner);
        ownerRowHeld.open();
        await untilWaitingForLock(await lockPid.opened, "csam lock");
        await address(file.id, newcomer);
      }),
    );
    const lock = settle(
      b.db.transaction(async (tx) => {
        await ownerRowHeld.opened;
        lockPid.open(await pidOf(tx));
        return lockSuspectedCsam(tx, file.id, { source: "system" });
      }),
    );
    const [blocked, locked] = await Promise.all([blocker, lock]);
    expect(blocked.ok).toBe(true);
    expect(locked).toMatchObject({ ok: true, value: { ownerId: owner } });
    expect(await held([owner, newcomer])).toEqual([owner, newcomer].sort());
    expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
  });

  // It retries ONCE. A set that grows again while the second attempt waits fails the whole
  // transaction — nothing is written — and the next call (a redelivery) locks all of them.
  it("a set that grows twice fails the lock with nothing written; the next call holds everyone", async () => {
    const c = openDb();
    try {
      const owner = await makeUser(a.db);
      const [n1, n2] = [await makeUser(a.db), await makeUser(a.db)];
      const file = await makeFile(a.db, owner, null, `twice-${rand()}.jpg`);
      const lockPid = gate<number>();
      const ownerRowHeld = gate();
      const n1RowHeld = gate<number>();
      const releaseN1 = gate();

      const holdsN1 = settle(
        c.db.transaction(async (tx) => {
          await lockUserRow(tx, n1);
          n1RowHeld.open(await pidOf(tx));
          await releaseN1.opened;
        }),
      );
      const holdsOwner = settle(
        a.db.transaction(async (tx) => {
          await lockUserRow(tx, owner);
          ownerRowHeld.open();
          await untilWaitingForLock(await lockPid.opened, "csam lock, first attempt");
          await address(file.id, n1);
        }),
      );
      const lock = settle(
        b.db.transaction(async (tx) => {
          await ownerRowHeld.opened;
          await n1RowHeld.opened;
          lockPid.open(await pidOf(tx));
          return lockSuspectedCsam(tx, file.id, { source: "system" });
        }),
      );
      expect((await holdsOwner).ok).toBe(true);
      // The second attempt now wants n1's row as well, and waits for it.
      await untilBlockedBy(await lockPid.opened, await n1RowHeld.opened, "csam lock, second attempt");
      await address(file.id, n2);
      releaseN1.open();
      expect((await holdsN1).ok).toBe(true);

      const locked = await lock;
      expect(locked.ok).toBe(false);
      expect(sqlState(locked)).toBeNull();
      expect(String(locked.ok ? "" : locked.error)).toContain("grew twice");
      expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "clean", legalHold: false });
      expect(await held([owner, n1, n2])).toEqual([]);
      expect(await a.db.select().from(reports).where(eq(reports.nodeId, file.id))).toEqual([]);

      // The redelivery: nothing is moving any more.
      expect(await lockSuspectedCsam(a.db, file.id, { source: "system" })).toMatchObject({ ownerId: owner });
      expect(await held([owner, n1, n2])).toEqual([owner, n1, n2].sort());
    } finally {
      await c.close();
    }
  });
});

describe("the CSAM lock is not lost to a deadlock", () => {
  const lockUserRow = (tx: Tx, id: string) =>
    tx.select({ id: user.id }).from(user).where(eq(user.id, id)).for("update");
  const lockNodeRow = (tx: Tx, id: string) =>
    tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, id)).for("update");
  const isHeld = async (id: string) =>
    (await watch.db.select({ held: user.legalHold }).from(user).where(eq(user.id, id)))[0]!.held;
  /** Resolves once some backend is blocked by `blocker` (a lock taken on a pooled connection has no pid to ask for). */
  async function untilSomeoneBlockedBy(blocker: number, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const result = await watch.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND ${blocker}::int = ANY(pg_blocking_pids(pid))`);
      if (Number(result.rows[0]?.n) > 0) return;
      if (Date.now() > deadline) throw new Error(`${label}: nobody was ever blocked by ${blocker}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  // A transaction that takes the NODE first and the owner's row second — the opposite order.
  // The CSAM lock has the owner's row and waits for the node; then the other asks for the
  // owner's row: a cycle. WHO DIES IS FIXED HERE: Postgres ends the transaction whose backend
  // runs the deadlock check, and the other side's check is put off (`deadlock_timeout` 20 s in
  // that transaction only), so it is always the lock's — after its own second of waiting.
  // Called on the database handle, the lock runs again and locks the node: the handle's
  // `transaction` is entered TWICE (the test's only seam), and the other side is never ended.
  it("as the deadlock victim it runs again: the node ends locked and the owner held", async () => {
    const owner = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `victim-${rand()}.jpg`);
    const nodeHeld = gate<number>();

    const other = settle(
      a.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL deadlock_timeout = '20s'`);
        await lockNodeRow(tx, file.id);
        const pid = await pidOf(tx);
        nodeHeld.open(pid);
        await untilSomeoneBlockedBy(pid, "the csam lock");
        await lockUserRow(tx, owner);
      }),
    );
    await nodeHeld.opened;
    const attempts = vi.spyOn(b.db, "transaction");
    let locked: Outcome<{ reportId: string; ownerId: string } | null>;
    let ran: number;
    try {
      locked = await settle(lockSuspectedCsam(b.db, file.id, { source: "photodna" }));
      ran = attempts.mock.calls.length;
    } finally {
      attempts.mockRestore();
    }
    const othered = await other;

    expect(sqlState(othered), "the other side was not the one ended").toBeNull();
    expect(ran, "the lock's whole transaction ran twice: ended once as the victim, then again").toBe(2);
    expect(sqlState(locked), "the lock did not surface the deadlock").toBeNull();
    expect(locked).toMatchObject({ ok: true, value: { ownerId: owner } });
    expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await isHeld(owner)).toBe(true);
    expect(await watch.db.select().from(reports).where(eq(reports.nodeId, file.id))).toHaveLength(1);
  });

  // The same cycle with the other side waiting longest, so that IT is normally the one Postgres
  // ends: the lock (holding the lower user row, held up at the higher one) then just goes on.
  // (This direction cannot be pinned — the lock runs on a pooled connection whose settings a
  // test cannot reach — so the test asserts what must hold whichever side is ended.)
  it("whichever side is ended in the other order, the call resolves with the node locked", async () => {
    const [lo, hi] = [await makeUser(a.db), await makeUser(a.db)].sort() as [string, string];
    const file = await makeFile(a.db, lo, null, `other-${rand()}.jpg`, { createdBy: hi });
    const c = openDb();
    try {
      const nodeHeld = gate<number>();
      const hiHeld = gate<number>();
      const releaseHi = gate();
      const holdsHi = settle(
        c.db.transaction(async (tx) => {
          await lockUserRow(tx, hi);
          hiHeld.open(await pidOf(tx));
          await releaseHi.opened;
        }),
      );
      const other = settle(
        a.db.transaction(async (tx) => {
          await lockNodeRow(tx, file.id);
          nodeHeld.open(await pidOf(tx));
          // Once the lock holds `lo` and is held up at `hi`, ask for `lo`: this side waits first.
          await untilSomeoneBlockedBy(await hiHeld.opened, "the csam lock");
          await lockUserRow(tx, lo);
        }),
      );
      const otherPid = await nodeHeld.opened;
      await hiHeld.opened;
      const lock = settle(lockSuspectedCsam(b.db, file.id, { source: "photodna" }));
      await untilWaitingForLock(otherPid, "the node-first transaction");
      releaseHi.open();
      const [locked, othered, heldHi] = await Promise.all([lock, other, holdsHi]);

      expect(heldHi.ok).toBe(true);
      expect(sqlState(locked)).toBeNull();
      expect(locked).toMatchObject({ ok: true, value: { ownerId: lo } });
      expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
      expect(await isHeld(lo)).toBe(true);
      expect(await isHeld(hi)).toBe(true);
      expect([null, "40P01"]).toContain(sqlState(othered));
    } finally {
      await c.close();
    }
  });

  // Inside a caller's transaction there is nothing to run again: the failure is the caller's.
  it("inside a caller's transaction the deadlock is the caller's to retry: nothing is half-applied", async () => {
    const owner = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `inner-${rand()}.jpg`);
    const nodeHeld = gate<number>();
    const lockPid = gate<number>();

    const other = settle(
      a.db.transaction(async (tx) => {
        await lockNodeRow(tx, file.id);
        nodeHeld.open(await pidOf(tx));
        await untilWaitingForLock(await lockPid.opened, "the csam lock");
        await lockUserRow(tx, owner);
      }),
    );
    const lock = settle(
      b.db.transaction(async (tx) => {
        await nodeHeld.opened;
        lockPid.open(await pidOf(tx));
        return lockSuspectedCsam(tx, file.id, { source: "photodna" });
      }),
    );
    const [othered, locked] = await Promise.all([other, lock]);
    // Exactly one of the two was ended; if it was the lock, nothing of it is left…
    expect([sqlState(othered), sqlState(locked)].filter((code) => code === "40P01")).toHaveLength(1);
    if (!locked.ok) {
      expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "clean", legalHold: false });
      expect(await isHeld(owner)).toBe(false);
    }
    // …and the caller's second try locks it.
    expect(await lockSuspectedCsam(b.db, file.id, { source: "photodna" })).toMatchObject({ ownerId: owner });
    expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
  });

  // A Replace holds the owner's row and the node, and then names the PREVIOUS uploader in the
  // version row it writes: the foreign-key check takes a KEY SHARE lock on that user's row. The
  // CSAM lock already has that row (it sorts below the owner) and waits for the owner's: with a
  // plain FOR UPDATE on user rows that is a deadlock.
  it("does not deadlock with a Replace that names an uploader the lock already holds", async () => {
    const [editor, owner] = [await makeUser(a.db), await makeUser(a.db)].sort() as [string, string];
    const replacer = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `fk-${rand()}.jpg`, { createdBy: editor });
    const lockPid = gate<number>();
    const ownerRowHeld = gate();

    const replace = settle(
      a.db.transaction(async (tx) => {
        // Where a Replace stands after its first step.
        await lockUserRow(tx, owner);
        ownerRowHeld.open();
        await untilWaitingForLock(await lockPid.opened, "the csam lock");
        return replaceVersion(tx, file.id, {
          r2Key: `u/${owner}/${file.id}/v2`,
          versionId: "v2",
          size: 5,
          sha256: null,
          createdBy: replacer,
        });
      }),
    );
    const lock = settle(
      b.db.transaction(async (tx) => {
        await ownerRowHeld.opened;
        lockPid.open(await pidOf(tx));
        return lockSuspectedCsam(tx, file.id, { source: "photodna" });
      }),
    );
    const [replaced, locked] = await Promise.all([replace, lock]);
    expect(sqlState(replaced), "the Replace was not a deadlock victim").toBeNull();
    expect(sqlState(locked), "the CSAM lock was not a deadlock victim").toBeNull();
    expect(replaced.ok).toBe(true);
    expect(locked).toMatchObject({ ok: true, value: { ownerId: owner } });
    // The Replace was first: the lock then held the owner, the previous uploader AND the new one.
    expect(await getNode(a.db, file.id)).toMatchObject({
      scanStatus: "suspected_csam",
      legalHold: true,
      createdBy: replacer,
    });
    for (const id of [owner, editor, replacer]) expect(await isHeld(id), id).toBe(true);
  });
});

describe("clearing a lock beside the filing of a report", () => {
  const linkOf = async (nodeId: string) =>
    (await watch.db.select().from(shareLinks).where(eq(shareLinks.nodeId, nodeId)))[0]!;

  // The filing has set the node's report `actioned` and has not committed; it did NOT take the
  // node's row (the rule for writers says it should — the clear must be safe without it). The
  // clear reads the reports it decides on FOR UPDATE: it waits for the filing and then refuses.
  // Reading them without a lock it sees `reviewing`, clears the node, and its own UPDATE of the
  // reports then skips the filed one: a cleared node with a filed report on it.
  it("a report filed while the clear runs: the clear waits, then refuses — nothing written", async () => {
    const owner = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `filed-${rand()}.jpg`);
    await makeLink(a.db, file.id, owner);
    const { reportId } = (await lockSuspectedCsam(a.db, file.id, { source: "photodna" }))!;
    await a.db.update(reports).set({ status: "reviewing" }).where(eq(reports.id, reportId));
    const clearPid = gate<number>();
    const filedNotCommitted = gate();

    const filing = settle(
      a.db.transaction(async (tx) => {
        await tx.update(reports).set({ status: "actioned" }).where(eq(reports.id, reportId));
        filedNotCommitted.open();
        await untilWaitingForLock(await clearPid.opened, "the clear");
      }),
    );
    const clear = settle(
      b.db.transaction(async (tx) => {
        await filedNotCommitted.opened;
        clearPid.open(await pidOf(tx));
        return clearSuspectedCsam(tx, file.id);
      }),
    );
    const [filed, cleared] = await Promise.all([filing, clear]);
    expect(filed.ok).toBe(true);
    expect(cleared).toMatchObject({
      ok: true,
      value: { cleared: false, refused: "reported", reportIds: [] },
    });
    expect(await getNode(a.db, file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect((await linkOf(file.id)).pauseReasons).toEqual(["moderation"]);
    expect(await lookup(a.db, file.sha256!)).toEqual({ reason: "csam", sourceNodeId: file.id });
    expect((await a.db.select().from(reports).where(eq(reports.id, reportId)))[0]!.status).toBe("actioned");
  });

  // The same for the hash: a csam report on ANOTHER node with the same content is being filed.
  // This node may be cleared, but the hash must stay blocklisted.
  it("a report on a twin filed while the clear runs: the node is cleared, the hash stays blocklisted", async () => {
    const owner = await makeUser(a.db);
    const sha256 = rand(32);
    const file = await makeFile(a.db, owner, null, `mine-${rand()}.jpg`, { sha256 });
    const twin = await makeFile(a.db, owner, null, `twin-${rand()}.jpg`, { sha256 });
    await lockSuspectedCsam(a.db, file.id, { source: "photodna" });
    const [twinReport] = await a.db
      .insert(reports)
      .values({ nodeId: twin.id, ownerId: owner, source: "admin", category: "csam" })
      .returning({ id: reports.id });
    const clearPid = gate<number>();
    const filedNotCommitted = gate();

    const filing = settle(
      a.db.transaction(async (tx) => {
        await tx.update(reports).set({ status: "actioned" }).where(eq(reports.id, twinReport!.id));
        filedNotCommitted.open();
        await untilWaitingForLock(await clearPid.opened, "the clear");
      }),
    );
    const clear = settle(
      b.db.transaction(async (tx) => {
        await filedNotCommitted.opened;
        clearPid.open(await pidOf(tx));
        return clearSuspectedCsam(tx, file.id);
      }),
    );
    const [filed, cleared] = await Promise.all([filing, clear]);
    expect(filed.ok).toBe(true);
    expect(cleared).toMatchObject({
      ok: true,
      value: { cleared: true, blocklistRemoved: false, blocklistKept: "reported" },
    });
    expect(await lookup(a.db, sha256)).toEqual({ reason: "csam", sourceNodeId: file.id });
  });
});

describe("Replace beside a legal hold on the account", () => {
  // The hold is being placed (its transaction has written the owner's row and not committed).
  // A Replace must wait for it and then refuse — not read the old value and go ahead.
  it("waits for a hold that is being placed, then refuses", async () => {
    const owner = await makeUser(a.db);
    const file = await makeFile(a.db, owner, null, `r-${rand()}.bin`);
    const replacePid = gate<number>();
    const ownerRowHeld = gate();
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
        ownerRowHeld.open();
        await untilWaitingForLock(await replacePid.opened, "replace");
      }),
    );
    const replace = settle(
      b.db.transaction(async (tx) => {
        await ownerRowHeld.opened;
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
    const ownerRowHeld = gate();
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
        ownerRowHeld.open();
        await untilWaitingForLock(await replacePid.opened, "replace");
        return deleteSubtreeRows(tx, file.id);
      }),
    );
    const replace = settle(
      b.db.transaction(async (tx) => {
        await ownerRowHeld.opened;
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
    const ownerRowHeld = gate();

    const reschedule = settle(
      a.db.transaction(async (tx) => {
        await tx.select({ id: user.id }).from(user).where(eq(user.id, owner)).for("update");
        ownerRowHeld.open();
        await untilWaitingForLock(await cancelPid.opened, "cancel");
        return schedule(tx, owner, moved);
      }),
    );
    const cancelled = settle(
      b.db.transaction(async (tx) => {
        await ownerRowHeld.opened;
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
