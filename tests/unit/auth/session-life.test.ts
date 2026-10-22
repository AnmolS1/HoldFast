// What the privacy text says about a session's life: it slides with use, ends at sign-out, and its
// address is deleted a day after it expired (the deletion itself: trash/retention-ip-fields).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { SESSION_EXPIRES_IN_S, SESSION_UPDATE_AGE_S } from "../../../src/worker/auth/create-auth";
import { session as sessionTable } from "../../../src/worker/db/schema";
import { getSession, send, sessionsOf, testDb, verifiedUser } from "./helpers";

const DAY = 86_400_000;

describe("a session's life", () => {
  it("is 14 days and renews with use at most once a day", async () => {
    expect(SESSION_EXPIRES_IN_S).toBe(14 * 86_400);
    expect(SESSION_UPDATE_AGE_S).toBe(86_400);
    const { client, user } = await verifiedUser();
    const [row] = await sessionsOf(user.id);
    // Last renewed 4 days ago: 10 days left.
    const tenLeft = new Date(Date.now() + 10 * DAY);
    await testDb().update(sessionTable).set({ expiresAt: tenLeft }).where(eq(sessionTable.id, row!.id));
    expect(await getSession(client)).not.toBeNull();
    const [renewed] = await sessionsOf(user.id);
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13.9 * DAY);
    // Used again within a day of the renewal: not renewed again.
    const thirteenAndAHalf = new Date(Date.now() + 13.5 * DAY);
    await testDb()
      .update(sessionTable)
      .set({ expiresAt: thirteenAndAHalf })
      .where(eq(sessionTable.id, row!.id));
    await getSession(client);
    const [same] = await sessionsOf(user.id);
    expect(same!.expiresAt.getTime()).toBe(thirteenAndAHalf.getTime());
  });

  it("signing out deletes the row at once, with its address and agent", async () => {
    const { client, user } = await verifiedUser();
    expect(await sessionsOf(user.id)).toHaveLength(1);
    expect((await send(client, "/api/auth/sign-out", { json: {} })).status).toBe(200);
    expect(await sessionsOf(user.id)).toEqual([]);
  });
});
