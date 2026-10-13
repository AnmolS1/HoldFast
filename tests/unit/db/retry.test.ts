import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { Db, Executor, Tx } from "../../../src/worker/db/client";
import { DEADLOCK_ATTEMPTS, isTransaction, retryOnDeadlock } from "../../../src/worker/db/retry";
import { user } from "../../../src/worker/db/schema";
import { makeUser, openDb, rejection } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

/** An error as the driver reports a failed statement: a SQLSTATE and a severity. */
const pgFailure = (code: string) => Object.assign(new Error(`failed: ${code}`), { code, severity: "ERROR" });
const nameOf = async (id: string) =>
  (await db.select({ name: user.name }).from(user).where(eq(user.id, id)))[0]!.name;

describe("retryOnDeadlock", () => {
  it.each(["40P01", "40001"])(
    "runs the whole transaction again after %s, and what the failed attempt wrote is gone",
    async (code) => {
      const id = await makeUser(db, { name: "before" });
      let runs = 0;
      const result = await retryOnDeadlock(db, async (tx) => {
        runs += 1;
        await tx
          .update(user)
          .set({ name: `attempt ${runs}` })
          .where(eq(user.id, id));
        if (runs === 1) throw pgFailure(code);
        return runs;
      });
      expect(result).toBe(2);
      expect(runs).toBe(2);
      expect(await nameOf(id)).toBe("attempt 2");
    },
  );

  it("does not run again after any other failure — a unique violation, a statement timeout, a plain error", async () => {
    for (const failure of [pgFailure("23505"), pgFailure("57014"), new Error("mine")]) {
      const id = await makeUser(db, { name: "before" });
      let runs = 0;
      const error = await rejection(
        retryOnDeadlock(db, async (tx) => {
          runs += 1;
          await tx.update(user).set({ name: "written" }).where(eq(user.id, id));
          throw failure;
        }),
      );
      expect(error).toBe(failure);
      expect(runs).toBe(1);
      expect(await nameOf(id)).toBe("before");
    }
  });

  it("is bounded: the default number of attempts, or the caller's, then the error is thrown", async () => {
    for (const [opts, expected] of [
      [undefined, DEADLOCK_ATTEMPTS],
      [{ attempts: 2 }, 2],
      [{ attempts: 1 }, 1],
      [{ attempts: 0 }, 1],
    ] as const) {
      let runs = 0;
      const failure = pgFailure("40P01");
      const error = await rejection(
        retryOnDeadlock(
          db,
          async () => {
            runs += 1;
            throw failure;
          },
          opts,
        ),
      );
      expect(error).toBe(failure);
      expect(runs, JSON.stringify(opts)).toBe(expected);
    }
    expect(DEADLOCK_ATTEMPTS).toBe(4);
  });

  it("inside a caller's transaction it runs once: the failure is the caller's", async () => {
    let runs = 0;
    const failure = pgFailure("40P01");
    const error = await rejection(
      db.transaction(async (outer) => {
        expect(isTransaction(outer)).toBe(true);
        return retryOnDeadlock(outer, async () => {
          runs += 1;
          throw failure;
        });
      }),
    );
    expect(error).toBe(failure);
    expect(runs).toBe(1);
    expect(isTransaction(db)).toBe(false);
    // …and a success inside a transaction is part of it (a savepoint), undone with it.
    const id = await makeUser(db, { name: "before" });
    await rejection(
      db.transaction(async (outer) => {
        await retryOnDeadlock(outer, (tx) => tx.update(user).set({ name: "inner" }).where(eq(user.id, id)));
        throw new Error("undo");
      }),
    );
    expect(await nameOf(id)).toBe("before");
  });

  it("hands its callback a Tx, and a callback written for any Executor is still accepted (checked by tsc)", () => {
    type Callback = Parameters<typeof retryOnDeadlock<void>>[1];
    expectTypeOf<Parameters<Callback>[0]>().toEqualTypeOf<Tx>();
    expectTypeOf<(tx: Executor) => Promise<void>>().toExtend<Callback>();
    // A Tx is an Executor, never the other way round: that is what the narrower type adds.
    expectTypeOf<Tx>().toExtend<Executor>();
    expectTypeOf<Executor>().not.toExtend<Tx>();
    // That the services which insist on a real transaction take it as `{ tx }` is checked where
    // they compile: tests/unit/services-core/retry-tx.test.ts (the Workers project).
    expect(isTransaction(db)).toBe(false);
  });
});
