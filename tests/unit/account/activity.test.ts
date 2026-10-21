// GET /api/account/activity: the account's own sign-in history — an allow-list of auth events
// ABOUT the account, the newest 20, and never a node event (a held "delete forever" writes no
// `node.purge`, an unheld one does).
import { beforeAll, describe, expect, it } from "vitest";
import { generationInStep } from "../trash/helpers";
import { insertAudit, type AuditRow } from "../../../src/worker/db/queries/audit";
import { CAPTCHA, newClient, send, verifiedUser } from "../auth/helpers";
import { api, impersonated, makeFile, person, testDb } from "../nodes/helpers";

// "Delete forever" asks the rollback detector first (PLAN §6 rule 17): this file's own bucket gets
// the database's generation, so an unheld purge really purges whatever other files counted.
beforeAll(generationInStep);

type Activity = Array<{
  id: string;
  at: string;
  action: string;
  outcome: string;
  uaLabel: string | null;
  country: string | null;
}>;

const row = (userId: string, action: string, overrides: Partial<AuditRow> = {}): AuditRow => ({
  actorUserId: userId,
  actorType: "user",
  action,
  targetType: "user",
  targetId: userId,
  ipHashDaily: "made-up-hash",
  ua: "Firefox",
  country: "FR",
  requestId: "made-up-request",
  meta: null,
  ...overrides,
});

describe("sign-in activity", () => {
  it("real events: the sign-in, and a failed sign-in by somebody else — with the device label and country only", async () => {
    const { client, email, user } = await verifiedUser();
    // A stranger tries the account's address with a wrong password (no actor, the account as target).
    const stranger = newClient({ cf: { country: "BR" } });
    const failed = await send(stranger, "/api/auth/sign-in/email", {
      json: { email, password: "not the password at all" },
      headers: CAPTCHA,
    });
    expect(failed.status).toBe(401);
    const answer = await send(client, "/api/account/activity");
    expect(answer.status).toBe(200);
    const rows = answer.body as Activity;
    expect(rows.map((item) => [item.action, item.outcome])).toEqual([
      ["auth.failed", "failed"],
      ["auth.sign_in", "ok"],
    ]);
    expect(rows[0]!.country).toBe("BR");
    for (const item of rows) {
      expect(Object.keys(item).sort()).toEqual(["action", "at", "country", "id", "outcome", "uaLabel"]);
    }
    expect(answer.text).not.toMatch(/ipHash|requestId|meta|password/);
    expect(user.id).toBeTruthy();
  });

  it("is an allow-list: no node event, no account event, no operator event — and the newest 20 only", async () => {
    const me = await person();
    const db = testDb();
    for (let i = 0; i < 25; i += 1) {
      await insertAudit(
        db,
        row(me.id, "auth.sign_in", { meta: { method: "password", uaFamily: "Firefox on Linux" } }),
      );
    }
    await insertAudit(db, row(me.id, "auth.passkey_added"));
    for (const action of [
      "account.export",
      "account.deletion_scheduled",
      "auth.impersonation_started",
      "auth.admin_granted",
      "node.purge",
      "node.purge_requested",
      "made.up_action",
    ]) {
      await insertAudit(db, row(me.id, action));
    }
    const rows = (await api(me.as, "GET", "/account/activity")).body as Activity;
    expect(rows).toHaveLength(20);
    expect(rows[0]!.action).toBe("auth.passkey_added");
    expect(new Set(rows.map((item) => item.action))).toEqual(new Set(["auth.passkey_added", "auth.sign_in"]));
    expect(rows[1]).toMatchObject({ uaLabel: "Firefox on Linux", country: "FR", outcome: "ok" });
    // The passkey row carries no device label of its own: the browser family of the request.
    expect(rows[0]).toMatchObject({ uaLabel: "Firefox" });
  });

  it("someone else's events are not mine, even when I was the actor", async () => {
    const me = await person();
    const other = await person();
    await insertAudit(testDb(), row(me.id, "auth.sign_in", { targetId: other.id }));
    expect((await api(me.as, "GET", "/account/activity")).body).toEqual([]);
  });

  it("a held and an unheld account have the same activity after deleting a file for good", async () => {
    async function deleteForGood(legalHold: boolean) {
      const who = await person({ legalHold });
      const file = await makeFile(who.id, null, { scanStatus: "clean" });
      await insertAudit(testDb(), row(who.id, "auth.sign_in"));
      expect((await api(who.as, "POST", `/nodes/${file.id}/trash`)).status).toBe(200);
      expect((await api(who.as, "DELETE", `/nodes/${file.id}`)).status).toBe(204);
      return ((await api(who.as, "GET", "/account/activity")).body as Activity).map((item) => item.action);
    }
    const held = await deleteForGood(true);
    const free = await deleteForGood(false);
    expect(held).toEqual(["auth.sign_in"]);
    expect(held).toEqual(free);
  });

  it("is refused under impersonation (403)", async () => {
    const me = await person();
    expect((await api(impersonated(me), "GET", "/account/activity")).status).toBe(403);
  });
});
