// The console's Ban and Set role reach Better Auth's admin plugin (/api/auth/admin/*), not our own
// routes — and they keep the console's two rules (ruling Q4, R1D auth-1): `400 self_action` on
// your own account, and `409 last_admin` when the change would leave no admin who can still act.
// The gate (auth/admin-gate.ts) checks AND writes the guarded field under the same admin-row lock
// as Suspend, so two admins acting on each other at the same moment leave exactly one.
//
// TABLE-WIDE: "the admins that are left" is a question about every `user` row, so this file
// runs alone (`*.tablewide.test.ts`) and, for its own duration, takes the admin role away from
// every admin other tests left behind — given back afterwards, row by row.
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { user } from "../../../src/worker/db/schema";
import { auditRows, promoteToAdmin, send, testDb, userById, verifiedUser } from "./helpers";

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

type Admin = Awaited<ReturnType<typeof verifiedUser>>;

/** Every account a test made: retired after it, whether it passed or not. */
let made: string[] = [];

async function admin(): Promise<Admin> {
  const one = await verifiedUser();
  made.push(one.user.id);
  await promoteToAdmin(one.user.id);
  return one;
}

afterEach(async () => {
  await retire(...made);
  made = [];
});

/** Ends the test's admins (so the next test starts with none that can act). */
async function retire(...ids: string[]) {
  if (ids.length > 0) {
    await testDb()
      .update(user)
      .set({
        role: "user",
        banned: false,
        banExpires: null,
        banReason: null,
        deleteScheduledAt: null,
        suspendedAt: null,
        suspendedReason: null,
      })
      .where(inArray(user.id, ids));
  }
}

/** An admin whose own deletion is scheduled: still signed in, no longer one who can act. */
const leave = (id: string) =>
  testDb()
    .update(user)
    .set({ deleteScheduledAt: new Date(Date.now() + 7 * 86_400_000) })
    .where(eq(user.id, id));

const ban = (who: Admin, userId: string, banExpiresIn?: number) =>
  send(who.client, "/api/auth/admin/ban-user", {
    json: { userId, banReason: "test", ...(banExpiresIn ? { banExpiresIn } : {}) },
  });
const setRole = (who: Admin, userId: string, role: "user" | "admin") =>
  send(who.client, "/api/auth/admin/set-role", { json: { userId, role } });
const suspend = (who: Admin, userId: string) =>
  send(who.client, `/api/admin/users/${userId}/suspend`, {
    json: { reason: "test" },
    headers: { "x-holdfast-user": who.user.id },
  });

const canAct = (row: Awaited<ReturnType<typeof userById>>) =>
  row !== null && row.role === "admin" && row.banned !== true && row.suspendedAt === null;

describe("Ban and Set role on your own account", () => {
  it("Set role on yourself — even the sole admin demoting themself — is 400 self_action; the role stays", async () => {
    const only = await admin();
    const demoted = await setRole(only, only.user.id, "user");
    expect(demoted.status, demoted.text).toBe(400);
    expect(demoted.body).toMatchObject({ error: "self_action" });
    expect((await userById(only.user.id))!.role).toBe("admin");
    // With a second admin it is still your own account: refused the same way.
    const other = await admin();
    expect((await setRole(only, only.user.id, "user")).body).toMatchObject({ error: "self_action" });
    expect((await userById(only.user.id))!.role).toBe("admin");
    await retire(only.user.id, other.user.id);
  });

  it("Ban on yourself is 400 self_action (the console's code, not the plugin's own)", async () => {
    const one = await admin();
    const other = await admin();
    const banned = await ban(one, one.user.id);
    expect(banned.status, banned.text).toBe(400);
    expect(banned.body).toMatchObject({ error: "self_action" });
    expect((await userById(one.user.id))!.banned).not.toBe(true);
    await retire(one.user.id, other.user.id);
  });
});

describe("Ban and Set role on the last admin who can act", () => {
  it("an admin whose own deletion is scheduled cannot ban, or demote, the only other admin: 409 last_admin", async () => {
    const leaving = await admin();
    const other = await admin();
    await leave(leaving.user.id);

    const banned = await ban(leaving, other.user.id);
    expect(banned.status, banned.text).toBe(409);
    expect(banned.body).toMatchObject({ error: "last_admin" });
    expect((await userById(other.user.id))!.banned).not.toBe(true);

    const timed = await ban(leaving, other.user.id, 3600);
    expect(timed.status, timed.text).toBe(409);
    expect((await userById(other.user.id))!.banned).not.toBe(true);

    const demoted = await setRole(leaving, other.user.id, "user");
    expect(demoted.status, demoted.text).toBe(409);
    expect(demoted.body).toMatchObject({ error: "last_admin" });
    expect((await userById(other.user.id))!.role).toBe("admin");
    // Nothing of the plugin's ran: no role-change audit row.
    expect(await auditRows({ action: "auth.role_changed", targetId: other.user.id })).toHaveLength(0);
    await retire(leaving.user.id, other.user.id);
  });

  it("CONTROL: with a third admin who can act, Ban and Set role go through exactly as before (sessions ended, audit from/to)", async () => {
    const leaving = await admin();
    const other = await admin();
    const third = await admin();
    await leave(leaving.user.id);

    const banned = await ban(leaving, other.user.id, 3600);
    expect(banned.status, banned.text).toBe(200);
    const row = (await userById(other.user.id))!;
    expect(row.banned).toBe(true);
    expect(row.banReason).toBe("test");
    expect(row.banExpires!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    expect(await auditRows({ action: "account.banned", targetId: other.user.id })).toHaveLength(1);

    // `third` is now the last admin who can act.
    expect((await setRole(leaving, third.user.id, "user")).status).toBe(409);
    expect((await ban(leaving, third.user.id)).status).toBe(409);
    // A promotion is never refused — and the role-change audit still says where it came from.
    const plain = await verifiedUser();
    made.push(plain.user.id);
    expect((await setRole(leaving, plain.user.id, "admin")).status).toBe(200);
    expect((await setRole(third, plain.user.id, "user")).status).toBe(200);
    const changes = await auditRows({ action: "auth.role_changed", targetId: plain.user.id });
    const moves = changes.map((change) => change.meta as { from?: string; to?: string });
    expect(moves.map((move) => `${move.from}→${move.to}`).sort()).toEqual(["admin→user", "user→admin"]);
    await retire(leaving.user.id, other.user.id, third.user.id, plain.user.id);
  });

  it("an admin who cannot act already (banned) is no one's last: banning or demoting them is allowed", async () => {
    const leaving = await admin();
    const gone = await admin();
    const third = await admin();
    expect((await ban(third, gone.user.id)).status).toBe(200);
    await leave(leaving.user.id);
    await retire(third.user.id);
    // `leaving` is the actor and is leaving; `gone` is banned: neither can act, and nothing is lost.
    const demoted = await setRole(leaving, gone.user.id, "user");
    expect(demoted.status, demoted.text).toBe(200);
    await retire(leaving.user.id, gone.user.id);
  });
});

describe("two admins acting on each other at the same moment leave exactly one who can act", () => {
  // Several rounds: each one is a fresh pair racing; one round with two 200s is the failure.
  const ROUNDS = 4;
  /** One 200; the other is 409 last_admin — or, when it arrives after the first is done, the
   *  refusal any banned / demoted / suspended admin gets (403, or 401 once the session is gone). */
  function oneWins(answers: Array<{ status: number; body: unknown; text: string }>) {
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses[0], answers.map((answer) => answer.text).join(" | ")).toBe(200);
    expect([401, 403, 409]).toContain(statuses[1]);
    const lost = answers.find((answer) => answer.status === 409);
    if (lost) expect(lost.body).toMatchObject({ error: "last_admin" });
  }

  it("Ban × Ban", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await admin();
      const b = await admin();
      oneWins(await Promise.all([ban(a, b.user.id), ban(b, a.user.id)]));
      const rows = [await userById(a.user.id), await userById(b.user.id)];
      expect(rows.filter(canAct)).toHaveLength(1);
      await retire(a.user.id, b.user.id);
    }
  });

  it("Set role × Set role", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await admin();
      const b = await admin();
      oneWins(await Promise.all([setRole(a, b.user.id, "user"), setRole(b, a.user.id, "user")]));
      const rows = [await userById(a.user.id), await userById(b.user.id)];
      expect(rows.filter(canAct)).toHaveLength(1);
      await retire(a.user.id, b.user.id);
    }
  });

  it("Suspend (our route) × Ban (the plugin): one lock, one order", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await admin();
      const b = await admin();
      oneWins(await Promise.all([suspend(a, b.user.id), ban(b, a.user.id)]));
      const rows = [await userById(a.user.id), await userById(b.user.id)];
      expect(rows.filter(canAct)).toHaveLength(1);
      await retire(a.user.id, b.user.id);
    }
  });
});
