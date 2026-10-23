// Read-only (the operator's kill switch) against the account's own way out (R1 func-2, ruling Q5):
// the nightly purge keeps running under read-only, so "Cancel deletion" must keep working too — and
// so must accepting the current terms, without which the shell sends every page to the terms
// screen. Everything else that writes stays refused, and an impersonated session stays read-only.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pendingUserPurges, session, user } from "../../../src/worker/db/schema";
import { BASE_SETTINGS, newClient, send, testDb, userById, verifiedUser } from "../auth/helpers";

const READ_ONLY = { ...BASE_SETTINGS, readOnly: true };

/** A signed-in user whose deletion is due tomorrow, seen through a read-only Worker. */
async function scheduledUnderReadOnly() {
  const who = await verifiedUser();
  who.client.settings = READ_ONLY;
  const tomorrow = new Date(Date.now() + 86_400_000);
  await testDb().insert(pendingUserPurges).values({ userId: who.user.id, scheduledFor: tomorrow });
  await testDb().update(user).set({ deleteScheduledAt: tomorrow }).where(eq(user.id, who.user.id));
  return who;
}

const pendingRow = async (userId: string) =>
  (await testDb().select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId)))[0] ?? null;

describe("read-only leaves the account a way out", () => {
  it("Cancel deletion works under read-only: 200, the date and the pending row are gone", async () => {
    const { client, user: row } = await scheduledUnderReadOnly();
    const cancelled = await send(client, "/api/account/deletion/cancel", { method: "POST" });
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.body).toEqual({ scheduledFor: null });
    expect((await userById(row.id))!.deleteScheduledAt).toBeNull();
    expect(await pendingRow(row.id)).toBeNull();
  });

  it("accepting the current terms works under read-only", async () => {
    const { client, user: row } = await verifiedUser();
    // New terms are out (2099 — far future) and the Worker is read-only.
    client.settings = { ...READ_ONLY, termsVersion: "2099-01" };
    const gated = await send(client, "/api/account/profile", { method: "PATCH", json: { name: "x" } });
    expect(gated.status).toBe(403);
    const accepted = await send(client, "/api/account/accept-terms", { json: { version: "2099-01" } });
    expect(accepted.status, accepted.text).toBe(200);
    expect((await userById(row.id))!.termsVersion).toBe("2099-01");
  });

  it("everything else under /api/account still answers 503 read_only — the exemption is two exact paths", async () => {
    const { client } = await scheduledUnderReadOnly();
    for (const [method, path, json] of [
      ["PATCH", "/api/account/profile", { name: "Changed" }],
      ["POST", "/api/account/deletion", undefined],
      ["POST", "/api/account/sessions/revoke-others", undefined],
    ] as const) {
      const answer = await send(client, path, { method, ...(json ? { json } : {}) });
      expect([path, answer.status]).toEqual([path, 503]);
      expect(answer.body).toMatchObject({ error: "read_only" });
    }
  });

  it("an impersonated session is still refused both, read-only or not", async () => {
    const { client, user: row } = await scheduledUnderReadOnly();
    const admin = await verifiedUser();
    await testDb().update(session).set({ impersonatedBy: admin.user.id }).where(eq(session.userId, row.id));
    const cancel = await send(client, "/api/account/deletion/cancel", { method: "POST" });
    expect(cancel.status).toBe(403);
    expect(cancel.body).toMatchObject({ details: { reason: "impersonation_read_only" } });
    const accept = await send(client, "/api/account/accept-terms", {
      json: { version: BASE_SETTINGS.termsVersion },
    });
    expect(accept.status).toBe(403);
    expect((await userById(row.id))!.deleteScheduledAt).not.toBeNull();
    expect(await pendingRow(row.id)).not.toBeNull();
  });

  it("signed out, the exempt paths are still 401 (the exemption is the kill switch's alone)", async () => {
    const anonymous = newClient({ settings: READ_ONLY });
    const cancel = await send(anonymous, "/api/account/deletion/cancel", { method: "POST" });
    expect(cancel.status).toBe(401);
  });
});
