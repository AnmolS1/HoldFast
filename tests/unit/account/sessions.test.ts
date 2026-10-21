// GET /api/account/sessions, DELETE /api/account/sessions/:id, POST /api/account/sessions/revoke-others
// — with real sessions, made by real sign-ins (the stand-in auth's session is not a row).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { session } from "../../../src/worker/db/schema";
import {
  auditRows,
  newClient,
  send,
  sessionsOf,
  signIn,
  testDb,
  verifiedUser,
  type Client,
} from "../auth/helpers";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** A second browser signed in to the same account. */
async function secondBrowser(email: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = newClient({ headers, cf: { country: "DE" } });
  const sent = await signIn(client, email);
  if (sent.status !== 200) throw new Error(`sign-in failed: ${sent.status} ${sent.text}`);
  return client;
}

type Listed = Array<{ id: string; current: boolean; uaLabel: string; country: string | null }>;

describe("Better Auth's own session list", () => {
  it("is switched off: GET /api/auth/list-sessions answers 404 and hands out no token and no address", async () => {
    const { client, user } = await verifiedUser();
    const answer = await send(client, "/api/auth/list-sessions");
    expect(answer.status).toBe(404);
    for (const row of await sessionsOf(user.id)) expect(answer.text).not.toContain(row.token);
    // The account's own list is ours.
    expect((await send(client, "/api/account/sessions")).status).toBe(200);
  });
});

describe("the session list", () => {
  it("lists the caller's own sessions, marks the current one, and carries no token and no address", async () => {
    const { client, email, user } = await verifiedUser();
    const other = await secondBrowser(email, { "user-agent": CHROME_MAC });
    const listed = await send(client, "/api/account/sessions");
    expect(listed.status).toBe(200);
    const rows = listed.body as Listed;
    const ids = (await sessionsOf(user.id)).map((row) => row.id).sort();
    expect(rows.map((row) => row.id).sort()).toEqual(ids);
    expect(rows.filter((row) => row.current)).toHaveLength(1);
    // The second browser's row: the coarse label and the country, nothing finer.
    const theirs = (await send(other, "/api/account/sessions")).body as Listed;
    const mine = theirs.find((row) => row.current)!;
    expect(mine).toMatchObject({ uaLabel: "Chrome on macOS", country: "DE" });
    expect(Object.keys(mine).sort()).toEqual(
      ["country", "createdAt", "current", "expiresAt", "id", "lastActiveAt", "uaLabel"].sort(),
    );
    const tokens = (await sessionsOf(user.id)).map((row) => row.token);
    for (const token of tokens) expect(listed.text).not.toContain(token);
    expect(listed.text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("is refused to an impersonated session (403) and to nobody (401)", async () => {
    const { client, user } = await verifiedUser();
    const [row] = await sessionsOf(user.id);
    await testDb()
      .update(session)
      .set({ impersonatedBy: "A".repeat(32) })
      .where(eq(session.id, row!.id));
    const refused = await send(client, "/api/account/sessions");
    expect(refused.status).toBe(403);
    expect((await send(newClient(), "/api/account/sessions")).status).toBe(401);
  });
});

describe("revoking", () => {
  it("one of the caller's own sessions: that browser is signed out at its next request", async () => {
    const { client, email, user } = await verifiedUser();
    const other = await secondBrowser(email);
    const rows = (await send(client, "/api/account/sessions")).body as Listed;
    const target = rows.find((row) => !row.current)!;
    const revoked = await send(client, `/api/account/sessions/${target.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect((await sessionsOf(user.id)).map((row) => row.id)).not.toContain(target.id);
    const after = await send(other, "/api/auth/get-session");
    expect(after.body).toBeNull();
    expect((await send(client, "/api/auth/get-session")).body).toMatchObject({ user: { id: user.id } });
    expect(await auditRows({ action: "account.session_revoked", targetId: user.id })).toHaveLength(1);
  });

  it("another account's session id is 404 and that session lives on — as is an id that is no session", async () => {
    const mine = await verifiedUser();
    const theirs = await verifiedUser();
    const [their] = await sessionsOf(theirs.user.id);
    const refused = await send(mine.client, `/api/account/sessions/${their!.id}`, { method: "DELETE" });
    expect(refused.status).toBe(404);
    expect((await sessionsOf(theirs.user.id)).map((row) => row.id)).toContain(their!.id);
    const nothing = await send(mine.client, `/api/account/sessions/${"Z".repeat(32)}`, { method: "DELETE" });
    expect(nothing.status).toBe(404);
    expect(nothing.body).toEqual({
      ...(refused.body as Record<string, unknown>),
      requestId: (nothing.body as { requestId: string }).requestId,
    });
    expect(await auditRows({ action: "account.session_revoked", targetId: mine.user.id })).toHaveLength(0);
  });

  it("an operator's impersonation session of the account is not the caller's to list or revoke", async () => {
    const { client, email, user } = await verifiedUser();
    const other = await secondBrowser(email);
    const otherRow = (await send(other, "/api/account/sessions")).body as Listed;
    const otherId = otherRow.find((row) => row.current)!.id;
    await testDb()
      .update(session)
      .set({ impersonatedBy: "A".repeat(32) })
      .where(eq(session.id, otherId));
    const listed = (await send(client, "/api/account/sessions")).body as Listed;
    expect(listed.map((row) => row.id)).not.toContain(otherId);
    expect((await send(client, `/api/account/sessions/${otherId}`, { method: "DELETE" })).status).toBe(404);
    await send(client, "/api/account/sessions/revoke-others", { method: "POST" });
    expect((await sessionsOf(user.id)).map((row) => row.id)).toContain(otherId);
  });

  it("revoke-others ends every other session of the caller's and keeps the current one", async () => {
    const { client, email, user } = await verifiedUser();
    const second = await secondBrowser(email);
    const third = await secondBrowser(email);
    const bystander = await verifiedUser();
    const answer = await send(client, "/api/account/sessions/revoke-others", { method: "POST" });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ revoked: 2 });
    expect(await sessionsOf(user.id)).toHaveLength(1);
    expect((await send(client, "/api/auth/get-session")).body).toMatchObject({ user: { id: user.id } });
    expect((await send(second, "/api/auth/get-session")).body).toBeNull();
    expect((await send(third, "/api/auth/get-session")).body).toBeNull();
    // Nobody else's sessions.
    expect(await sessionsOf(bystander.user.id)).toHaveLength(1);
    expect(await auditRows({ action: "account.session_revoked", targetId: user.id })).toHaveLength(1);
  });
});
