// R2 auth-2 (self): the console does not strike its own admin (ruling Q4: no console action on
// your own account). Refused BEFORE anything is written — before, the strike was saved and the
// answer was `400 self_action` (the suspension's guard, after the commit), and the hourly sweep
// then suspended the account anyway. A report's strike on the admin's own upload likewise.
// (The last-admin half needs every admin row: last-admin-strike.tablewide.test.ts.)
import { describe, expect, it } from "vitest";
import { admin, adminCall, makeFile, member, reportRowOf, reported, strikesOfUser } from "./helpers";

describe("a strike on your own account", () => {
  it("by hand → 400 self_action and NO strike written; control: the same strike on another account → 200, written", async () => {
    const who = await admin();
    const answer = await adminCall(who.as, "POST", `/users/${who.id}/strikes`, {
      body: { userId: who.id, kind: "abuse", note: "By hand." },
    });
    expect([answer.status, answer.body.error], answer.text).toEqual([400, "self_action"]);
    expect(await strikesOfUser(who.id)).toEqual([]);

    const other = await member();
    const control = await adminCall(who.as, "POST", `/users/${other.id}/strikes`, {
      body: { userId: other.id, kind: "abuse", note: "By hand." },
    });
    expect(control.status, control.text).toBe(200);
    expect(await strikesOfUser(other.id)).toHaveLength(1);
  });

  it("a report's Strike on a file the admin uploaded → 400 self_action: no strike, the report still open", async () => {
    const who = await admin();
    const file = await makeFile(who.id, null, { scanStatus: "clean", createdBy: who.id });
    const reportId = await reported(file.id, who.id);
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "strike", resolution: "Abuse confirmed." },
    });
    expect([answer.status, answer.body.error], answer.text).toEqual([400, "self_action"]);
    expect(await strikesOfUser(who.id)).toEqual([]);
    expect((await reportRowOf(reportId))!.status).toBe("open");
  });
});
