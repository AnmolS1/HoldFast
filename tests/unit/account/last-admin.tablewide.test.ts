// The last admin who can act is not suspended or scheduled for deletion from the console
// (R1 secsrv-2 / func-4, ruling Q4): 409 last_admin. The actor is an admin who can act, so this
// bites when the actor is leaving too (their own deletion is scheduled) or when two admins act on
// each other at the same moment — the check locks every admin row in id order first, so the
// second of the two sees the first's change.
//
// TABLE-WIDE: "the admins that are left" is a question about every `user` row, so this file
// runs alone (`*.tablewide.test.ts`) and, for its own duration, takes the admin role away from
// every admin other tests left behind — given back afterwards, row by row.
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "../../../src/worker/db/schema";
import { scheduleDeletion } from "../../../src/worker/services/account-state";
import { admin, adminCall, serviceDeps, testDb, userRowOf } from "../admin/helpers";

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

const suspend = (who: Awaited<ReturnType<typeof admin>>, targetId: string) =>
  adminCall(who.as, "POST", `/users/${targetId}/suspend`, { body: { reason: "test" } });
const consoleDelete = (who: Awaited<ReturnType<typeof admin>>, targetId: string) =>
  adminCall(who.as, "POST", `/users/${targetId}/deletion`, { body: { reason: "test" } });

describe("the last admin who can act", () => {
  it("an admin whose own deletion is scheduled cannot suspend, or schedule the deletion of, the only other admin", async () => {
    const leaving = await admin();
    const other = await admin();
    await scheduleDeletion(serviceDeps().deps, leaving.id);

    const suspended = await suspend(leaving, other.id);
    expect(suspended.status, suspended.text).toBe(409);
    expect(suspended.body).toMatchObject({ error: "last_admin" });
    expect((await userRowOf(other.id))!.suspendedAt).toBeNull();

    const deleted = await consoleDelete(leaving, other.id);
    expect(deleted.status, deleted.text).toBe(409);
    expect(deleted.body).toMatchObject({ error: "last_admin" });
    expect((await userRowOf(other.id))!.deleteScheduledAt).toBeNull();
    await retire(leaving.id, other.id);
  });

  it("with a third admin who can act the suspension is allowed — and then the third is the last", async () => {
    const leaving = await admin();
    const other = await admin();
    const third = await admin();
    await scheduleDeletion(serviceDeps().deps, leaving.id);
    expect((await suspend(leaving, other.id)).status).toBe(200);
    expect((await consoleDelete(leaving, third.id)).status).toBe(409);
    await retire(leaving.id, other.id, third.id);
  });

  it("two admins suspending each other at the same moment: exactly one succeeds, the other is 409 last_admin", async () => {
    const a = await admin();
    const b = await admin();
    const answers = await Promise.all([suspend(a, b.id), suspend(b, a.id)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body).toMatchObject({ error: "last_admin" });
    const rows = [await userRowOf(a.id), await userRowOf(b.id)];
    expect(rows.filter((row) => row!.suspendedAt === null)).toHaveLength(1);
    await retire(a.id, b.id);
  });

  it("an admin who cannot act already (suspended) is no one's last: suspending them again is the usual no-op", async () => {
    const leaving = await admin();
    const gone = await admin({ suspendedAt: new Date(), suspendedReason: "test" });
    await scheduleDeletion(serviceDeps().deps, leaving.id);
    const again = await suspend(leaving, gone.id);
    expect(again.status, again.text).toBe(200);
    await retire(leaving.id, gone.id);
  });
});
