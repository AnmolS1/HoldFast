// R2 auth-2 (last admin): a strike never locks out the last admin who can act (ruling Q4).
//   - By hand: a strike that would reach the threshold on the last admin who can act is
//     `409 last_admin` and NOTHING is written — decided in the strike's own transaction, after
//     every admin row is locked (before, the strike was saved and then refused, and the sweep
//     suspended the account within the hour).
//   - A report's Strike: the same, the report left open.
//   - The hourly strike sweep (and every other threshold check, system actor): an admin at the
//     threshold who is the last one who can act is NOT suspended (reported instead); with
//     another admin who can act, they are.
//
// TABLE-WIDE: "the admins that are left" is a question about every `user` row, so this file runs
// alone and, for its own duration, takes the admin role away from every admin other tests left
// behind — given back afterwards, row by row (last-admin.tablewide.test.ts's technique).
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strikes, user } from "../../../src/worker/db/schema";
import { scheduleDeletion } from "../../../src/worker/services/account-state";
import { enforceStrikeThreshold, sweepStrikeThresholds } from "../../../src/worker/services/strikes";
import {
  admin,
  adminCall,
  makeFile,
  reported,
  reportRowOf,
  serviceDeps,
  strikesOfUser,
  testDb,
  userRowOf,
} from "../admin/helpers";

let parked: Array<{ id: string; role: string | null }> = [];

beforeAll(async () => {
  parked = await testDb()
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(like(user.role, "%admin%"));
  if (parked.length > 0) {
    await testDb()
      .update(user)
      .set({ role: "user" })
      .where(
        inArray(
          user.id,
          parked.map((row) => row.id),
        ),
      );
  }
});

afterAll(async () => {
  for (const row of parked) await testDb().update(user).set({ role: row.role }).where(eq(user.id, row.id));
});

/** Ends the test's admins (so the next test starts with none that can act). */
async function retire(...ids: string[]) {
  if (ids.length > 0) await testDb().update(user).set({ role: "user" }).where(inArray(user.id, ids));
}

/** `n` unlifted strikes on the account, written straight (made up for the test). */
async function strikesOn(userId: string, n: number) {
  for (let i = 0; i < n; i++)
    await testDb().insert(strikes).values({ userId, kind: "abuse", note: "made up" });
}

/** An admin who is leaving (their deletion scheduled) and the one other admin: the last who can act. */
async function leavingAndLast() {
  const leaving = await admin();
  const last = await admin();
  await scheduleDeletion(serviceDeps().deps, leaving.id);
  return { leaving, last };
}

describe("a strike never suspends the last admin who can act", () => {
  it("by hand: the third strike on the last admin → 409 last_admin, NOT written; the first two are allowed", async () => {
    const { leaving, last } = await leavingAndLast();
    const strike = () =>
      adminCall(leaving.as, "POST", `/users/${last.id}/strikes`, {
        body: { userId: last.id, kind: "abuse", note: "By hand." },
      });
    expect((await strike()).status).toBe(200);
    expect((await strike()).status).toBe(200);
    const third = await strike();
    expect([third.status, third.body.error], third.text).toEqual([409, "last_admin"]);
    expect(await strikesOfUser(last.id)).toHaveLength(2);
    expect((await userRowOf(last.id))!.suspendedAt).toBeNull();
    await retire(leaving.id, last.id);
  });

  it("a report's Strike that would be the last admin's third → 409 last_admin: no strike, the report still open", async () => {
    const { leaving, last } = await leavingAndLast();
    await strikesOn(last.id, 2);
    const file = await makeFile(last.id, null, { scanStatus: "clean", createdBy: last.id });
    const reportId = await reported(file.id, last.id);
    const answer = await adminCall(leaving.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "strike", resolution: "Abuse confirmed." },
    });
    expect([answer.status, answer.body.error], answer.text).toEqual([409, "last_admin"]);
    expect(await strikesOfUser(last.id)).toHaveLength(2);
    expect((await reportRowOf(reportId))!.status).toBe("open");
    await retire(leaving.id, last.id);
  });

  it("the hourly sweep and the threshold check leave the last admin at three strikes unsuspended; control: with another admin who can act, the sweep suspends", async () => {
    const { leaving, last } = await leavingAndLast();
    await strikesOn(last.id, 3);
    const { deps, settle } = serviceDeps();
    await sweepStrikeThresholds(deps, { limit: 1_000 });
    await expect(enforceStrikeThreshold(deps, last.id)).resolves.toMatchObject({ suspended: false });
    await settle();
    expect((await userRowOf(last.id))!.suspendedAt).toBeNull();

    const third = await admin();
    const again = serviceDeps();
    await sweepStrikeThresholds(again.deps, { limit: 1_000 });
    await again.settle();
    expect((await userRowOf(last.id))!.suspendedAt).not.toBeNull();
    await retire(leaving.id, last.id, third.id);
  });
});
