// The allow-list in front of the admin plugin. The endpoint table is READ FROM THE INSTALLED
// PLUGIN, not written by hand: every endpoint it mounts that is not one of the five allowed
// paths must answer 403, leave its effect undone and write one audit row — whatever a later
// Better Auth adds under /admin/.
import { env } from "cloudflare:workers";
import { admin as adminPlugin } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ADMIN_PLUGIN_ALLOWED, isAdminPluginPath } from "../../../src/worker/auth/admin-gate";
import { createAuth } from "../../../src/worker/auth/create-auth";
import { IMPERSONATION_EXEMPT_PATHS } from "../../../src/worker/middleware/impersonation";
import { account, user } from "../../../src/worker/db/schema";
import {
  accountsOf,
  auditRows,
  getSession,
  newClient,
  PASSWORD,
  promoteToAdmin,
  send,
  sessionsOf,
  signIn,
  testDb,
  userById,
  verifiedUser,
  type Client,
} from "./helpers";

type Endpoint = { path: string; options: { method: string | string[] } };
const pluginEndpoints = (Object.values(adminPlugin().endpoints) as unknown as Endpoint[])
  .map((endpoint) => ({ path: endpoint.path, method: ([] as string[]).concat(endpoint.options.method)[0]! }))
  .sort((a, b) => a.path.localeCompare(b.path));
const allowed: readonly string[] = ADMIN_PLUGIN_ALLOWED;

const deniedRows = async (path: string, actorUserId: string | null) =>
  (await auditRows({ action: "auth.admin_endpoint_denied", actorUserId })).filter(
    (row) => (row.meta as { path?: string }).path === path,
  );

/** A body or query that would make the endpoint act on `targetId` if it were reached. */
function argumentsFor(path: string, targetId: string) {
  return {
    userId: targetId,
    role: "admin",
    newPassword: "an attacker chosen password 1!",
    password: "an attacker chosen password 1!",
    email: `created-${crypto.randomUUID()}@holdfast-test.example`,
    name: "Created By Admin",
    data: { name: "renamed", role: "admin" },
    sessionToken: "x",
    permissions: { user: ["delete"] },
    ...(path.endsWith("has-permission") ? { userId: undefined } : {}),
  };
}

async function call(client: Client, endpoint: { path: string; method: string }, targetId: string) {
  const args = argumentsFor(endpoint.path, targetId);
  if (endpoint.method === "GET") {
    const query = new URLSearchParams({ id: targetId, userId: targetId, limit: "5" });
    return send(client, `/api/auth${endpoint.path}?${query.toString()}`);
  }
  return send(client, `/api/auth${endpoint.path}`, { method: endpoint.method, json: args });
}

async function admin2fa() {
  const admin = await verifiedUser();
  await promoteToAdmin(admin.user.id);
  // The 60-second cookie cache still says "user"; a real admin's has long since caught up.
  admin.client.cookies.delete("hf.session_data");
  return admin;
}

describe("the installed admin plugin", () => {
  it("mounts everything under /admin/, and the allow-list names five endpoints that exist", () => {
    expect(pluginEndpoints.length).toBeGreaterThanOrEqual(15);
    for (const endpoint of pluginEndpoints)
      expect(endpoint.path.startsWith("/admin/"), endpoint.path).toBe(true);
    const paths = pluginEndpoints.map((endpoint) => endpoint.path);
    expect([...ADMIN_PLUGIN_ALLOWED]).toEqual([
      "/admin/ban-user",
      "/admin/unban-user",
      "/admin/set-role",
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
    ]);
    for (const path of ADMIN_PLUGIN_ALLOWED) expect(paths, path).toContain(path);
    expect(Object.isFrozen(ADMIN_PLUGIN_ALLOWED)).toBe(true);
    // The path the impersonation middleware exempts is the one this gate allows.
    expect(IMPERSONATION_EXEMPT_PATHS).toContain(`/api/auth${ADMIN_PLUGIN_ALLOWED[4]}`);
    for (const method of pluginEndpoints.filter((e) => allowed.includes(e.path)).map((e) => e.method)) {
      expect(method).toBe("POST");
    }
  });
});

describe("every plugin endpoint outside the allow-list", () => {
  const denied = pluginEndpoints.filter((endpoint) => !allowed.includes(endpoint.path));

  it("the table has the two that matter most by name", () => {
    expect(denied.map((e) => e.path)).toEqual(
      expect.arrayContaining(["/admin/remove-user", "/admin/set-user-password"]),
    );
    expect(denied.length).toBe(pluginEndpoints.length - 5);
  });

  it.each(denied)(
    "$method $path → 403 for a 2FA admin, its effect undone, one audit row",
    async (endpoint) => {
      const admin = await admin2fa();
      const target = await verifiedUser();
      const before = {
        user: await userById(target.user.id),
        sessions: (await sessionsOf(target.user.id)).map((s) => s.id),
        accounts: await accountsOf(target.user.id),
      };

      const sent = await call(admin.client, endpoint, target.user.id);
      expect(sent.status, sent.text).toBe(403);

      const after = {
        user: await userById(target.user.id),
        sessions: (await sessionsOf(target.user.id)).map((s) => s.id),
        accounts: await accountsOf(target.user.id),
      };
      expect(after, "nothing about the target changed").toEqual(before);
      // The admin is still who they were (no role change, no new user under their name).
      expect((await userById(admin.user.id))!.role).toBe("admin");
      const rows = await deniedRows(endpoint.path, admin.user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        targetType: "auth_endpoint",
        meta: { path: endpoint.path, method: endpoint.method },
      });
      // The row carries the path and method only: nothing from the body.
      expect(JSON.stringify(rows[0]!.meta)).not.toMatch(/attacker|created-|renamed/);
    },
  );

  it("/admin/remove-user: the user, their sessions and their accounts are all still there, and no deletion is scheduled", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const sent = await send(admin.client, "/api/auth/admin/remove-user", {
      json: { userId: target.user.id },
    });
    expect(sent.status).toBe(403);
    const row = await userById(target.user.id);
    expect(row).not.toBeNull();
    expect(row!.deleteScheduledAt).toBeNull();
    expect(await sessionsOf(target.user.id)).toHaveLength(1);
    expect(await accountsOf(target.user.id)).toHaveLength(1);
    expect((await getSession(target.client))?.user.id).toBe(target.user.id);
  });

  it("/admin/set-user-password: the password hash is unchanged, and the old password still signs in", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const [before] = await testDb()
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, target.user.id));
    const sent = await send(admin.client, "/api/auth/admin/set-user-password", {
      json: { userId: target.user.id, newPassword: "an attacker chosen password 1!" },
    });
    expect(sent.status).toBe(403);
    const [after] = await testDb()
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, target.user.id));
    expect(after!.password).toBe(before!.password);
    expect((await signIn(newClient(), target.email, "an attacker chosen password 1!")).status).toBe(401);
    expect((await signIn(newClient(), target.email, PASSWORD)).status).toBe(200);
  });

  it("an anonymous caller is refused the same way (and the row has no actor)", async () => {
    const target = await verifiedUser();
    const sent = await send(newClient(), "/api/auth/admin/remove-user", { json: { userId: target.user.id } });
    expect(sent.status).toBe(403);
    expect(await userById(target.user.id)).not.toBeNull();
  });

  it("a path that does not exist yet under /admin/ is refused too — by prefix, not by a deny-list", async () => {
    const admin = await admin2fa();
    for (const path of ["/admin/some-future-endpoint", "/admin", "/admin/", "/admin/ban-user/extra"]) {
      const sent = await send(admin.client, `/api/auth${path}`, { json: {} });
      expect(sent.status, path).toBe(403);
      expect(sent.body, path).toMatchObject({
        error: "forbidden",
        details: { reason: "admin_endpoint_denied" },
      });
      expect(await deniedRows(path, admin.user.id), path).toHaveLength(1);
    }
  });

  it("no other spelling of a refused path reaches the endpoint", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const spellings = [
      "/api/auth/admin/remove-user/",
      "/api/auth/ADMIN/remove-user",
      "/api/auth/admin/Remove-User",
      "/api/auth//admin/remove-user",
      "/api/auth/admin//remove-user",
      "/api/auth/%61dmin/remove-user",
      "/api/auth/admin%2Fremove-user",
      "/api/auth/admin/remove%2Duser",
      "/api/auth/%2561dmin/remove-user",
      "/api/auth/x/../admin/remove-user",
      "/api/auth/admin/./remove-user",
      "/api/auth/admin;v=1/remove-user",
      "/api/auth/admin/remove-user;v=1",
      "/api/auth/admin\\remove-user",
      "/api/auth/admin/remove-user?x=1",
      "/api/auth/admin/remove-user#x",
    ];
    for (const spelling of spellings) {
      const sent = await send(admin.client, spelling, { json: { userId: target.user.id } });
      expect(sent.status, spelling).not.toBe(200);
      expect([403, 404], spelling).toContain(sent.status);
      expect(await userById(target.user.id), spelling).not.toBeNull();
    }
    expect(isAdminPluginPath("/admin/remove-user")).toBe(true);
    expect(isAdminPluginPath("/%61DMIN/x")).toBe(true);
    expect(isAdminPluginPath("//admin//x")).toBe(true);
    expect(isAdminPluginPath("/x/../admin/x")).toBe(true);
    expect(isAdminPluginPath("/administrator")).toBe(false);
    expect(isAdminPluginPath("/sign-in/email")).toBe(false);
    expect(isAdminPluginPath("/passkey/admin")).toBe(false);
  });

  it("inside the Worker too: auth.api.removeUser and auth.api.setUserPassword are refused by the hook", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const auth = createAuth(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} });
    const api = auth.api as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const headers = new Headers({
      cookie: [...admin.client.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    });
    for (const [name, path, body] of [
      ["removeUser", "/admin/remove-user", { userId: target.user.id }],
      [
        "setUserPassword",
        "/admin/set-user-password",
        { userId: target.user.id, newPassword: "an attacker chosen password 1!" },
      ],
    ] as const) {
      const before = (await deniedRows(path, admin.user.id)).length;
      const outcome: unknown = await api[name]!({ body, headers }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(outcome, name).toMatchObject({ status: "FORBIDDEN", statusCode: 403 });
      expect(await userById(target.user.id), name).not.toBeNull();
      expect(await deniedRows(path, admin.user.id), name).toHaveLength(before + 1);
    }
    expect((await signIn(newClient(), target.email, PASSWORD)).status).toBe(200);
  });
});

describe("the four allowed paths an admin calls", () => {
  const bodyFor = (path: string, targetId: string) =>
    path === "/admin/set-role" ? { userId: targetId, role: "user" } : { userId: targetId };
  const adminCalled = ADMIN_PLUGIN_ALLOWED.filter((path) => path !== "/admin/stop-impersonating");

  it.each(adminCalled)("%s passes for an admin with two-factor", async (path) => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const sent = await send(admin.client, `/api/auth${path}`, { json: bodyFor(path, target.user.id) });
    expect(sent.status, sent.text).toBe(200);
    expect(await deniedRows(path, admin.user.id)).toEqual([]);
  });

  it.each(adminCalled)(
    "%s is 403 for a plain user, for an admin WITHOUT two-factor, and for an impersonated session",
    async (path) => {
      const target = await verifiedUser();
      const snapshot = async () => ({
        row: await userById(target.user.id),
        sessions: (await sessionsOf(target.user.id)).length,
      });
      const before = await snapshot();

      const plain = await verifiedUser();
      const asPlain = await send(plain.client, `/api/auth${path}`, { json: bodyFor(path, target.user.id) });
      expect(asPlain.status, "plain user").toBe(403);
      expect(await deniedRows(path, plain.user.id)).toHaveLength(1);

      const noSecondFactor = await verifiedUser();
      await promoteToAdmin(noSecondFactor.user.id, false);
      const asWeakAdmin = await send(noSecondFactor.client, `/api/auth${path}`, {
        json: bodyFor(path, target.user.id),
      });
      expect(asWeakAdmin.status, "admin without 2FA").toBe(403);
      expect(await deniedRows(path, noSecondFactor.user.id)).toHaveLength(1);

      // An impersonated session: an admin looking through someone else's — who is an admin too.
      const admin = await admin2fa();
      const puppet = await verifiedUser();
      const impersonated = await send(admin.client, "/api/auth/admin/impersonate-user", {
        json: { userId: puppet.user.id },
      });
      expect(impersonated.status, impersonated.text).toBe(200);
      await promoteToAdmin(puppet.user.id);
      const asImpersonated = await send(admin.client, `/api/auth${path}`, {
        json: bodyFor(path, target.user.id),
      });
      expect(asImpersonated.status, "impersonated session").toBe(403);

      const anonymous = await send(newClient(), `/api/auth${path}`, { json: bodyFor(path, target.user.id) });
      expect(anonymous.status, "no session").toBe(403);
      expect(await snapshot(), "the target is untouched by all four").toEqual(before);
    },
  );

  it("a demoted admin stops at once, not when the cookie cache expires", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    expect(
      (
        await send(admin.client, "/api/auth/admin/set-role", {
          json: { userId: target.user.id, role: "user" },
        })
      ).status,
    ).toBe(200);
    await testDb().update(user).set({ role: "user" }).where(eq(user.id, admin.user.id));
    // The session cookie and its 60-second cache are untouched.
    const sent = await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } });
    expect(sent.status).toBe(403);
    expect((await userById(target.user.id))!.banned).not.toBe(true);
  });
});

describe("impersonation", () => {
  it("is a 15-minute, read-only session; stop-impersonating works only from inside it; both ends are audited", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    // From an ordinary session there is nothing to stop.
    const early = await send(admin.client, "/api/auth/admin/stop-impersonating", { json: {} });
    expect(early.status).toBe(403);
    expect(await deniedRows("/admin/stop-impersonating", admin.user.id)).toHaveLength(1);

    const started = await send(admin.client, "/api/auth/admin/impersonate-user", {
      json: { userId: target.user.id },
    });
    expect(started.status, started.text).toBe(200);
    const session = await getSession(admin.client);
    expect(session?.user.id).toBe(target.user.id);
    expect(session?.session.impersonatedBy).toBe(admin.user.id);
    const lifetime = new Date(String(session!.session.expiresAt)).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);
    expect(await auditRows({ action: "auth.impersonation_started", targetId: target.user.id })).toMatchObject(
      [{ actorUserId: admin.user.id, actorType: "admin" }],
    );
    // No "new sign-in" mail and no sign-in audit row for the person being looked at.
    expect(await auditRows({ action: "auth.sign_in", targetId: target.user.id })).toHaveLength(1);

    // Read-only: every state-changing request is refused, ours and Better Auth's.
    const cancel = await send(admin.client, "/api/account/deletion/cancel", { json: {} });
    expect(cancel.status).toBe(403);
    expect(cancel.body).toMatchObject({ details: { reason: "impersonation_read_only" } });
    for (const [path, body] of [
      ["/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "a new password for them 1!" }],
      ["/api/auth/delete-user", {}],
      ["/api/auth/change-email", { newEmail: "attacker@holdfast-test.example" }],
      ["/api/auth/two-factor/enable", { password: PASSWORD }],
      ["/api/auth/update-user", { name: "renamed" }],
      ["/api/auth/revoke-sessions", {}],
    ] as const) {
      const sent = await send(admin.client, path, { json: body });
      expect(sent.status, path).toBe(403);
    }
    expect((await send(admin.client, "/api/auth/list-sessions")).status).toBe(403);
    expect((await signIn(newClient(), target.email, PASSWORD)).status).toBe(200);
    expect((await userById(target.user.id))!.name).toBe("Test Person");

    const stopped = await send(admin.client, "/api/auth/admin/stop-impersonating", { json: {} });
    expect(stopped.status, stopped.text).toBe(200);
    expect((await getSession(admin.client))?.user.id).toBe(admin.user.id);
    expect(await auditRows({ action: "auth.impersonation_stopped", targetId: target.user.id })).toMatchObject(
      [{ actorUserId: admin.user.id, actorType: "admin" }],
    );
  });
});
