// Brief Addendum 2, applied in the fix pass:
//  - a role change through Better Auth's admin plugin writes `auth.role_changed { from, to }`
//    (actor the admin, target the account) — with the REAL auth;
//  - /api/admin/* is exempt from the terms gate: an operator acts before accepting a new version.
import { describe, expect, it } from "vitest";
import { auditRows, eventually, promoteToAdmin, send, verifiedUser } from "../auth/helpers";
import { admin, adminCall, call, member } from "./helpers";

describe("a role change is audited with the value before and after", () => {
  it("set-role user → admin, then back: two auth.role_changed rows, {from, to}, actor the admin, target the account", async () => {
    const operator = await verifiedUser();
    await promoteToAdmin(operator.user.id);
    const target = await verifiedUser();
    const raised = await send(operator.client, "/api/auth/admin/set-role", {
      json: { userId: target.user.id, role: "admin" },
    });
    expect(raised.status).toBe(200);
    const lowered = await send(operator.client, "/api/auth/admin/set-role", {
      json: { userId: target.user.id, role: "user" },
    });
    expect(lowered.status).toBe(200);
    const rows = await eventually(async () => {
      const found = await auditRows({ action: "auth.role_changed", targetId: target.user.id });
      return found.length === 2 ? found : null;
    });
    const metas = rows
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((row) => [row.actorUserId, row.actorType, row.targetType, row.meta]);
    expect(metas).toEqual([
      [operator.user.id, "admin", "user", { from: "user", to: "admin" }],
      [operator.user.id, "admin", "user", { from: "admin", to: "user" }],
    ]);
  });
});

describe("the terms gate does not stand between an operator and the console", () => {
  it("an admin whose accepted terms are older: /api/admin mutations pass; control: their own non-admin mutation is 403 terms_required", async () => {
    const who = await admin({ termsVersion: "2001-01" });
    const target = await member();
    const settings = { termsVersion: "2099-01" };
    const revoked = await adminCall(who.as, "POST", `/users/${target.id}/revoke-sessions`, {
      body: { reason: "Incident." },
      settings,
    });
    expect([revoked.status, revoked.body?.error]).toEqual([200, undefined]);
    const own = await call(who.as, "POST", "/nodes/folder", {
      body: { name: "x", parentId: null },
      settings,
    });
    expect([own.status, own.body?.error]).toEqual([403, "terms_required"]);
  });
});
