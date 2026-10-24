// What the console may do to an account, from the account's side (R1 secsrv-1, secsrv-2 / func-4;
// rulings Q4 and Q6):
//   - an admin cannot suspend, or schedule the deletion of, their OWN account (400 self_action) —
//     a sole admin who did either was locked out with only SQL to get back in;
//   - a deletion an ADMIN scheduled is not the holder's to cancel (409 deletion_admin_scheduled);
//     an admin can, and once it is cancelled the holder's own requests work as before;
//   - acting on ANOTHER admin stays allowed (the last-admin refusal: last-admin.tablewide.test.ts).
// Requests go through the real app host with the console's session stand-in (tests/unit/admin).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pendingUserPurges, verification } from "../../../src/worker/db/schema";
import { purgeAuthRows, revokeAllAccess, scheduleDeletion } from "../../../src/worker/services/account-state";
import { endStandingProofs } from "../../../src/worker/auth/second-factor";
import { admin, adminCall, call, member, serviceDeps, testDb, userRowOf } from "../admin/helpers";

const pendingRow = async (userId: string) =>
  (await testDb().select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId)))[0] ?? null;

const markers = async (userId: string) =>
  testDb()
    .select()
    .from(verification)
    .where(eq(verification.identifier, `admin-deletion:${userId}`));

const consoleDelete = (who: Awaited<ReturnType<typeof admin>>, targetId: string) =>
  adminCall(who.as, "POST", `/users/${targetId}/deletion`, { body: { reason: "test" } });
const consoleCancel = (who: Awaited<ReturnType<typeof admin>>, targetId: string) =>
  adminCall(who.as, "POST", `/users/${targetId}/deletion/cancel`, { body: { reason: "test" } });
const ownCancel = (who: Awaited<ReturnType<typeof member>>) =>
  call(who.as, "POST", "/account/deletion/cancel");

describe("an admin acting on their own account", () => {
  it("cannot suspend it: 400 self_action, nothing changes", async () => {
    const me = await admin();
    const answer = await adminCall(me.as, "POST", `/users/${me.id}/suspend`, { body: { reason: "test" } });
    expect(answer.status, answer.text).toBe(400);
    expect(answer.body).toMatchObject({ error: "self_action" });
    expect((await userRowOf(me.id))!.suspendedAt).toBeNull();
  });

  it("cannot schedule its deletion from the console: 400 self_action, nothing scheduled", async () => {
    const me = await admin();
    const answer = await consoleDelete(me, me.id);
    expect(answer.status, answer.text).toBe(400);
    expect(answer.body).toMatchObject({ error: "self_action" });
    expect((await userRowOf(me.id))!.deleteScheduledAt).toBeNull();
    expect(await pendingRow(me.id)).toBeNull();
    expect(await markers(me.id)).toHaveLength(0);
  });

  it("can still suspend another admin, and schedule another admin's deletion", async () => {
    const me = await admin();
    const peer = await admin();
    const other = await admin();
    expect(
      (await adminCall(me.as, "POST", `/users/${peer.id}/suspend`, { body: { reason: "test" } })).status,
    ).toBe(200);
    expect((await userRowOf(peer.id))!.suspendedAt).not.toBeNull();
    expect((await consoleDelete(me, other.id)).status).toBe(200);
    expect((await userRowOf(other.id))!.deleteScheduledAt).not.toBeNull();
  });
});

describe("a deletion an admin scheduled", () => {
  it("the holder cannot cancel it (409 deletion_admin_scheduled); an admin can, and then the holder's own cancel works again", async () => {
    const operator = await admin();
    const holder = await member();
    expect((await consoleDelete(operator, holder.id)).status).toBe(200);
    expect(await markers(holder.id)).toHaveLength(1);

    const refused = await ownCancel(holder);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body).toMatchObject({ error: "deletion_admin_scheduled" });
    expect((await userRowOf(holder.id))!.deleteScheduledAt).not.toBeNull();
    expect(await pendingRow(holder.id)).not.toBeNull();

    const lifted = await consoleCancel(operator, holder.id);
    expect(lifted.status, lifted.text).toBe(200);
    expect((await userRowOf(holder.id))!.deleteScheduledAt).toBeNull();
    expect(await markers(holder.id)).toHaveLength(0);

    // The holder asks for deletion themself now (the same service Better Auth's link reaches) and
    // changes their mind: theirs to cancel.
    await scheduleDeletion(serviceDeps().deps, holder.id);
    const own = await ownCancel(holder);
    expect(own.status, own.text).toBe(200);
    expect((await userRowOf(holder.id))!.deleteScheduledAt).toBeNull();
  });

  it("an admin whose deletion another admin ordered cannot cancel it either — not from the console, not from the banner", async () => {
    const operator = await admin();
    const subject = await admin();
    expect((await consoleDelete(operator, subject.id)).status).toBe(200);
    const fromConsole = await consoleCancel(subject, subject.id);
    expect(fromConsole.status, fromConsole.text).toBe(409);
    expect(fromConsole.body).toMatchObject({ error: "deletion_admin_scheduled" });
    const fromBanner = await call(subject.as, "POST", "/account/deletion/cancel");
    expect(fromBanner.status).toBe(409);
    expect((await userRowOf(subject.id))!.deleteScheduledAt).not.toBeNull();
    expect(await markers(subject.id)).toHaveLength(1);
  });

  it("the mark survives the holder's password change and a suspension lifted (every other cleanup of verification rows)", async () => {
    const operator = await admin();
    const holder = await member();
    expect((await consoleDelete(operator, holder.id)).status).toBe(200);
    const { deps } = serviceDeps();
    await revokeAllAccess(deps, holder.id);
    await endStandingProofs(testDb(), holder.id);
    expect(await markers(holder.id)).toHaveLength(1);
    expect((await ownCancel(holder)).status).toBe(409);
  });

  it("the console's Delete on a deletion the holder already asked for makes it the admin's: same date, changed false, the holder can no longer cancel", async () => {
    const operator = await admin();
    const holder = await member();
    const own = await scheduleDeletion(serviceDeps().deps, holder.id);
    const answer = await consoleDelete(operator, holder.id);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ scheduledFor: own.scheduledFor!.toISOString(), changed: false });
    const refused = await ownCancel(holder);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "deletion_admin_scheduled" });
    expect((await userRowOf(holder.id))!.deleteScheduledAt).not.toBeNull();
  });

  it("a deletion the holder asked for is still theirs to cancel (no mark)", async () => {
    const holder = await member();
    await scheduleDeletion(serviceDeps().deps, holder.id);
    expect(await markers(holder.id)).toHaveLength(0);
    const own = await ownCancel(holder);
    expect(own.status, own.text).toBe(200);
    expect(await pendingRow(holder.id)).toBeNull();
  });

  it("the mark goes with the account's auth rows at the purge, and no other account's cleanup touches it", async () => {
    const operator = await admin();
    const holder = await member();
    const bystander = await member();
    expect((await consoleDelete(operator, holder.id)).status).toBe(200);
    expect((await consoleDelete(operator, bystander.id)).status).toBe(200);
    // The operator's own verification rows going (their account purged) leaves both marks alone.
    expect(await purgeAuthRows(testDb(), operator.id)).toBe(true);
    expect(await markers(holder.id)).toHaveLength(1);
    expect(await purgeAuthRows(testDb(), holder.id)).toBe(true);
    expect(await markers(holder.id)).toHaveLength(0);
    expect(await markers(bystander.id)).toHaveLength(1);
  });
});
