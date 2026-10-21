// The console's reach into Better Auth's admin plugin (T25 section 2, ruling 6), with the REAL
// auth: the two refused paths an operator might reach for, and the ban — whose side effects T06's
// hook applies (sessions ended, links paused `owner_suspended`) whatever calls the endpoint.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { account } from "../../../src/worker/db/schema";
import { suspendUser, unsuspendUser, SYSTEM_ACTOR } from "../../../src/worker/services/account-state";
import {
  auditRows,
  makeLink,
  promoteToAdmin,
  send,
  serviceDeps,
  sessionsOf,
  testDb,
  userById,
  verifiedUser,
} from "../auth/helpers";
import { makeFile } from "../services-core/helpers";
import { linkRowOf } from "./helpers";

async function admin2fa() {
  const admin = await verifiedUser();
  await promoteToAdmin(admin.user.id);
  return admin;
}

/** A signed-in account with one live link. */
async function targetWithLink() {
  const target = await verifiedUser();
  const file = await makeFile(target.user.id, null, { scanStatus: "clean" });
  const link = await makeLink(file.id, target.user.id);
  return { target, link };
}

const denied = async (path: string, actorUserId: string) =>
  (await auditRows({ action: "auth.admin_endpoint_denied", actorUserId })).filter(
    (row) => (row.meta as { path?: string }).path === path,
  );

describe("the plugin paths the console must never reach", () => {
  it("remove-user from a 2FA admin: 403, the user row untouched, auth.admin_endpoint_denied", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const before = await userById(target.user.id);
    const sent = await send(admin.client, "/api/auth/admin/remove-user", {
      json: { userId: target.user.id },
    });
    expect(sent.status).toBe(403);
    expect(await userById(target.user.id)).toEqual(before);
    expect(await denied("/admin/remove-user", admin.user.id)).toHaveLength(1);
  });

  it("set-user-password from a 2FA admin: 403, the password hash untouched, auth.admin_endpoint_denied", async () => {
    const admin = await admin2fa();
    const target = await verifiedUser();
    const hash = async () =>
      (
        await testDb().select({ p: account.password }).from(account).where(eq(account.userId, target.user.id))
      )[0]!.p;
    const before = await hash();
    const sent = await send(admin.client, "/api/auth/admin/set-user-password", {
      json: { userId: target.user.id, newPassword: "made up for a test 12345!" },
    });
    expect(sent.status).toBe(403);
    expect(await hash()).toBe(before);
    expect(await denied("/admin/set-user-password", admin.user.id)).toHaveLength(1);
  });
});

describe("a ban through the plugin's allowed path", () => {
  it("ends every session and pauses the links with owner_suspended; the unban restores exactly that", async () => {
    const admin = await admin2fa();
    const { target, link } = await targetWithLink();
    expect(await sessionsOf(target.user.id)).toHaveLength(1);
    const banned = await send(admin.client, "/api/auth/admin/ban-user", {
      json: { userId: target.user.id, banReason: "made-up reason" },
    });
    expect(banned.status, banned.text).toBe(200);
    expect((await userById(target.user.id))!.banned).toBe(true);
    expect(await sessionsOf(target.user.id)).toEqual([]);
    expect((await linkRowOf(link.id)).pauseReasons).toEqual(["owner_suspended"]);

    const unbanned = await send(admin.client, "/api/auth/admin/unban-user", {
      json: { userId: target.user.id },
    });
    expect(unbanned.status, unbanned.text).toBe(200);
    expect((await linkRowOf(link.id)).pauseReasons).toEqual([]);
  });

  it("lifting the ban while the account is still suspended leaves the links paused — and the other way round", async () => {
    const admin = await admin2fa();
    const one = await targetWithLink();
    const service = serviceDeps();
    await suspendUser(service.deps, one.target.user.id, "test", SYSTEM_ACTOR);
    await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: one.target.user.id } });
    expect(
      (await send(admin.client, "/api/auth/admin/unban-user", { json: { userId: one.target.user.id } }))
        .status,
    ).toBe(200);
    expect((await linkRowOf(one.link.id)).pauseReasons).toEqual(["owner_suspended"]);

    const two = await targetWithLink();
    await send(admin.client, "/api/auth/admin/ban-user", { json: { userId: two.target.user.id } });
    await suspendUser(service.deps, two.target.user.id, "test", SYSTEM_ACTOR);
    expect(await unsuspendUser(service.deps, two.target.user.id, SYSTEM_ACTOR)).toBe(true);
    await service.settle();
    expect((await linkRowOf(two.link.id)).pauseReasons).toEqual(["owner_suspended"]);
  });
});
