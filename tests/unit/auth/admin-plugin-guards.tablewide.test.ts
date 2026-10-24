// The console's Ban and Set role reach Better Auth's admin plugin (/api/auth/admin/*), not our own
// routes — and they keep the console's two rules (ruling Q4, R1D auth-1): `400 self_action` on
// your own account, and `409 last_admin` when the change would leave no admin who can still act.
// The gate (auth/admin-gate.ts) checks AND writes the guarded field under the same admin-row lock
// as Suspend, so two admins acting on each other at the same moment leave exactly one.
//
// TABLE-WIDE: "the admins that are left" is a question about every `user` row, so this file
// runs alone (`*.tablewide.test.ts`) and, for its own duration, takes the admin role away from
// every admin other tests left behind — given back afterwards, row by row.
import { eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as lifecycle from "../../../src/worker/db/queries/auth-lifecycle";
import { user } from "../../../src/worker/db/schema";
import { auditRows, promoteToAdmin, send, sessionsOf, testDb, userById, verifiedUser } from "./helpers";

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

// Security review of the guard: the before-hook sees the body as JSON-parsed, NOT yet validated —
// the plugin's zod schema runs after it (better-auth api/dispatch.mjs) and COERCES `userId`
// (`z.coerce.string()`: `["id"]` becomes "id"). So the gate reads the body itself, strictly, and
// refuses (400 validation) what it cannot read exactly as the plugin will; and it writes nothing
// the plugin would then refuse.
describe("the gate reads the body exactly as the plugin will, and refuses what it cannot", () => {
  const post = (who: Admin, path: "ban-user" | "set-role", json: unknown) =>
    send(who.client, `/api/auth/admin/${path}`, { json });

  it.each([
    ["an array", (id: string) => [id]],
    ["an object", (id: string) => ({ id })],
    ["an empty object", () => ({})],
    ["true", () => true],
    ["a number", () => 12345],
    ["the id and a space", (id: string) => `${id} `],
    ["a space and the id", (id: string) => ` ${id}`],
  ] as const)(
    "userId as %s: 400 validation from the gate — the last admin is not banned or demoted through it",
    async (_what, shape) => {
      const leaving = await admin();
      const other = await admin();
      await leave(leaving.user.id);
      for (const path of ["ban-user", "set-role"] as const) {
        const answer = await post(leaving, path, {
          userId: shape(other.user.id),
          role: "user",
          banReason: "test",
        });
        expect(answer.status, `${path} ${answer.text}`).toBe(400);
        expect(answer.body).toMatchObject({ error: "validation" });
      }
      const row = (await userById(other.user.id))!;
      expect([row.banned === true, row.role]).toEqual([false, "admin"]);
    },
  );

  it("a duplicate userId key is read as the plugin reads it (the last one): the last admin's 409 stands", async () => {
    const leaving = await admin();
    const other = await admin();
    const plain = await verifiedUser();
    made.push(plain.user.id);
    await leave(leaving.user.id);
    const answer = await send(leaving.client, "/api/auth/admin/ban-user", {
      rawBody: `{"userId":"${plain.user.id}","userId":"${other.user.id}","banReason":"test"}`,
      headers: { "content-type": "application/json" },
    });
    expect(answer.status, answer.text).toBe(409);
    expect((await userById(other.user.id))!.banned).not.toBe(true);
    expect((await userById(plain.user.id))!.banned).not.toBe(true);
  });

  it.each([
    ["banExpiresIn as text", { banExpiresIn: "soon" }],
    ["banExpiresIn not finite", { banExpiresIn: "Infinity" }],
    ["banReason as a number", { banReason: 123 }],
  ] as const)(
    "a ban the plugin would refuse (%s): 400, nothing written, nothing audited",
    async (_what, extra) => {
      const one = await admin();
      const target = await verifiedUser();
      made.push(target.user.id);
      const answer = await post(one, "ban-user", { userId: target.user.id, ...extra });
      expect(answer.status, answer.text).toBe(400);
      const row = (await userById(target.user.id))!;
      expect([row.banned === true, row.banReason, row.banExpires]).toEqual([false, null, null]);
      expect(await auditRows({ action: "account.banned", targetId: target.user.id })).toHaveLength(0);
    },
  );

  it.each([
    ["a role nobody configured", "superuser"],
    ["a role list", ["user"]],
    ["a comma-joined pair", "admin,user"],
    ["no role", undefined],
  ] as const)("Set role to %s: 400, the role unchanged, no role-change audit", async (_what, role) => {
    const one = await admin();
    const target = await verifiedUser();
    made.push(target.user.id);
    const answer = await post(one, "set-role", { userId: target.user.id, role });
    expect(answer.status, answer.text).toBe(400);
    expect((await userById(target.user.id))!.role).toBe("user");
    expect(await auditRows({ action: "auth.role_changed", targetId: target.user.id })).toHaveLength(0);
  });
});

// The gate's write lands BEFORE the plugin's own (the adapter has no transaction). When the
// plugin then fails — here its own UPDATE of the account, refused by a test-only trigger that
// fires on exactly that second write — the request is a 5xx and NOTHING of it persists: the gate's
// write is put back (auth/create-auth.ts, after the handler), no session is ended, nothing audited.
describe("the plugin failing after the gate wrote", () => {
  /** Fails every UPDATE of `id` that writes the value the row already has (the plugin's repeat). */
  async function failPluginWrite(id: string) {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error("unexpected id");
    await testDb().execute(
      sql.raw(`CREATE OR REPLACE FUNCTION test_fail_plugin_write() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test: the plugin write fails'; END $$ LANGUAGE plpgsql`),
    );
    await testDb().execute(
      sql.raw(`CREATE TRIGGER test_fail_plugin_write BEFORE UPDATE ON "user" FOR EACH ROW
        WHEN (OLD.id = '${id}' AND ((OLD.banned AND NEW.banned) OR (OLD.role = 'user' AND NEW.role = 'user')))
        EXECUTE FUNCTION test_fail_plugin_write()`),
    );
  }
  afterEach(async () => {
    await testDb().execute(sql.raw(`DROP TRIGGER IF EXISTS test_fail_plugin_write ON "user"`));
  });

  it("Ban: 5xx, the target not banned, its sessions kept, no account.banned", async () => {
    const one = await admin();
    const target = await admin();
    const before = (await sessionsOf(target.user.id)).length;
    await failPluginWrite(target.user.id);
    const answer = await send(one.client, "/api/auth/admin/ban-user", {
      json: { userId: target.user.id, banReason: "test", banExpiresIn: 3600 },
    });
    expect(answer.status, answer.text).toBeGreaterThanOrEqual(500);
    const row = (await userById(target.user.id))!;
    expect([row.banned === true, row.banReason, row.banExpires]).toEqual([false, null, null]);
    expect((await sessionsOf(target.user.id)).length).toBe(before);
    expect(await auditRows({ action: "account.banned", targetId: target.user.id })).toHaveLength(0);
  });

  it("Set role (a demotion): 5xx, the role still admin, sessions kept, no role-change audit", async () => {
    const one = await admin();
    const target = await admin();
    const before = (await sessionsOf(target.user.id)).length;
    await failPluginWrite(target.user.id);
    const answer = await send(one.client, "/api/auth/admin/set-role", {
      json: { userId: target.user.id, role: "user" },
    });
    expect(answer.status, answer.text).toBeGreaterThanOrEqual(500);
    expect((await userById(target.user.id))!.role).toBe("admin");
    expect((await sessionsOf(target.user.id)).length).toBe(before);
    expect(await auditRows({ action: "auth.role_changed", targetId: target.user.id })).toHaveLength(0);
  });

  it("CONTROL: the same calls with no trigger go through (200)", async () => {
    const one = await admin();
    const target = await admin();
    expect(
      (await send(one.client, "/api/auth/admin/set-role", { json: { userId: target.user.id, role: "user" } }))
        .status,
    ).toBe(200);
    expect(
      (await send(one.client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } })).status,
    ).toBe(200);
  });

  it("a ban whose expiry is no date (banExpiresIn 1e300): 400 before anything is written", async () => {
    const one = await admin();
    const target = await verifiedUser();
    made.push(target.user.id);
    const answer = await send(one.client, "/api/auth/admin/ban-user", {
      json: { userId: target.user.id, banExpiresIn: 1e300 },
    });
    expect(answer.status, answer.text).toBe(400);
    expect((await userById(target.user.id))!.banned).not.toBe(true);
  });
});

/** The undo as the request runs it when its plugin write never landed (auth/admin-gate.ts). */
const undoA = (
  userId: string,
  change: lifecycle.AdminPluginChange,
  wrote: NonNullable<Awaited<ReturnType<typeof lifecycle.writeAdminPluginChange>>>,
) => lifecycle.undoAdminPluginChange(testDb(), userId, change, wrote);

describe("the undo puts back only its own write", () => {
  it("A writes a ban ahead of its plugin, B bans the same account with the SAME values, A's plugin fails: B's ban stays, nothing audited by the undo", async () => {
    const a = await admin();
    const b = await admin();
    const target = await admin();
    const change = { banned: true as const, banReason: "test", banExpires: null };
    // A's gate: the write ahead of the plugin (as keepAnAdmin makes it).
    const aWrote = await testDb().transaction((tx) =>
      lifecycle.writeAdminPluginChange(tx, target.user.id, change),
    );
    expect(aWrote).not.toBeNull();
    // B's whole request, the same ban.
    const bAnswer = await send(b.client, "/api/auth/admin/ban-user", {
      json: { userId: target.user.id, banReason: "test" },
    });
    expect(bAnswer.status, bAnswer.text).toBe(200);
    const auditedBefore = (await auditRows({ action: "account.unbanned", targetId: target.user.id })).length;
    // A's plugin failed: A's undo runs.
    await undoA(target.user.id, change, aWrote!);
    const row = (await userById(target.user.id))!;
    expect([row.banned, row.banReason]).toEqual([true, "test"]);
    // The undo itself is no account action: no audit row of any kind for it.
    expect((await auditRows({ action: "account.unbanned", targetId: target.user.id })).length).toBe(
      auditedBefore,
    );
    void a;
  });

  it("…and the same for a demotion: B's identical Set role between A's write and A's undo stays", async () => {
    const b = await admin();
    const target = await admin();
    const third = await admin();
    const change = { role: "user" };
    const aWrote = await testDb().transaction((tx) =>
      lifecycle.writeAdminPluginChange(tx, target.user.id, change),
    );
    // B demotes an account that is already "user" in the row: through the gate (a no-op guard) and the plugin.
    const bAnswer = await send(b.client, "/api/auth/admin/set-role", {
      json: { userId: target.user.id, role: "user" },
    });
    expect(bAnswer.status, bAnswer.text).toBe(200);
    await undoA(target.user.id, change, aWrote!);
    expect((await userById(target.user.id))!.role).toBe("user");
    void third;
  });

  it("CONTROL: with no write in between, A's undo puts the account back (and audits nothing)", async () => {
    const target = await admin();
    const change = { banned: true as const, banReason: "test", banExpires: null };
    const aWrote = await testDb().transaction((tx) =>
      lifecycle.writeAdminPluginChange(tx, target.user.id, change),
    );
    await undoA(target.user.id, change, aWrote!);
    const row = (await userById(target.user.id))!;
    expect([row.banned, row.banReason]).toEqual([false, null]);
    expect(await auditRows({ action: "account.unbanned", targetId: target.user.id })).toHaveLength(0);
    expect(await auditRows({ action: "account.banned", targetId: target.user.id })).toHaveLength(0);
  });
});
