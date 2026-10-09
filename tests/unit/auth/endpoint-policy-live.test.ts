// auth/endpoint-policy.ts against the LIVE handler.
//
// The policy table (what a suspended, deleted or impersonated session may still reach under
// /api/auth/*) was written and tested before Better Auth was mounted, against a stand-in. Here:
//   1. the route table is read from the instance `createAuth` really builds — every endpoint it
//      serves must have a row, and every row an endpoint, methods included;
//   2. for each restricted state, EVERY endpoint is requested through the real pipeline and the
//      real handler: a denied one is refused with our envelope and leaves the account exactly as
//      it was; an allowed one is answered by Better Auth.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../../src/worker/auth/create-auth";
import {
  AUTH_ENDPOINTS,
  type AuthGateDecision,
  type AuthGateState,
} from "../../../src/worker/auth/endpoint-policy";
import { account, pendingUserPurges, user } from "../../../src/worker/db/schema";
import {
  linkIn,
  newClient,
  promoteToAdmin,
  send,
  sessionsOf,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

type Endpoint = { path?: string; options?: { method?: string | string[] } };
const COLUMN: Record<AuthGateState, 2 | 3 | 4> = { deleted: 2, suspended: 3, impersonating: 4 };
const DENIED: Record<AuthGateState, { status: number; error: string; reason?: string }> = {
  deleted: { status: 401, error: "unauthorized" },
  suspended: { status: 403, error: "forbidden", reason: "account_suspended" },
  impersonating: { status: 403, error: "forbidden", reason: "impersonation_read_only" },
};

/** `METHODS path` for every endpoint of the instance the Worker really serves. */
function liveRouteTable(): string[] {
  const auth = createAuth(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} });
  return Object.values(auth.api as unknown as Record<string, Endpoint>)
    .filter((endpoint) => typeof endpoint?.path === "string")
    .map(
      (endpoint) => `${([] as string[]).concat(endpoint.options?.method ?? []).join(",")} ${endpoint.path}`,
    )
    .sort();
}

const concrete = (path: string) => `/api/auth${path.replace(":id", "google").replace(":token", "abcdef")}`;

async function request(client: Client, row: (typeof AUTH_ENDPOINTS)[number]) {
  const method = row[0].split(",")[0]!;
  const path = concrete(row[1]);
  return method === "GET"
    ? send(client, `${path}?token=abcdef&callbackURL=%2F`)
    : send(client, path, {
        method,
        json: { userId: "x".repeat(32), newEmail: "moved@holdfast-test.example", password: "x" },
      });
}

function expectDecision(
  state: AuthGateState,
  decision: AuthGateDecision,
  sent: Awaited<ReturnType<typeof send>>,
  label: string,
) {
  const refusal = DENIED[state];
  const body = sent.body as { error?: string; details?: { reason?: string } } | null;
  const refusedByGate =
    sent.status === refusal.status &&
    body?.error === refusal.error &&
    body?.details?.reason === refusal.reason;
  if (decision === "deny") {
    expect(sent.status, label).toBe(refusal.status);
    expect(body, label).toMatchObject(
      refusal.reason
        ? { error: refusal.error, details: { reason: refusal.reason } }
        : { error: refusal.error },
    );
  } else if (decision === "signed_out") {
    expect(sent.status, label).toBe(200);
    expect(sent.text, label).toBe("null");
  } else {
    expect(refusedByGate, `${label} must reach Better Auth`).toBe(false);
  }
}

const passwordHash = async (userId: string) =>
  (await testDb().select({ password: account.password }).from(account).where(eq(account.userId, userId)))[0]
    ?.password;
const scheduled = async (userId: string) =>
  (await testDb().select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId))).length;

async function fingerprint(userId: string) {
  const row = await userById(userId);
  return {
    email: row!.email,
    name: row!.name,
    emailVerified: row!.emailVerified,
    role: row!.role,
    twoFactorEnabled: row!.twoFactorEnabled,
    banned: row!.banned,
    password: await passwordHash(userId),
    purges: await scheduled(userId),
  };
}

describe("the policy table and the live route table", () => {
  it("are the same list: every endpoint the real instance serves has a decision, and no row is stale", () => {
    const live = liveRouteTable();
    const policy = AUTH_ENDPOINTS.map((row) => `${row[0]} ${row[1]}`).sort();
    expect(live.length).toBeGreaterThanOrEqual(60);
    expect(
      live.filter((entry) => !policy.includes(entry)),
      "endpoints with no policy row",
    ).toEqual([]);
    expect(
      policy.filter((entry) => !live.includes(entry)),
      "policy rows with no endpoint",
    ).toEqual([]);
    expect(policy).toEqual(live);
    // No path appears twice (a second row would shadow the first).
    expect(new Set(AUTH_ENDPOINTS.map((row) => row[1])).size).toBe(AUTH_ENDPOINTS.length);
  });

  it("the comparison can fail: an endpoint without a row, or a row without an endpoint, is seen", () => {
    const live = liveRouteTable();
    const policy = AUTH_ENDPOINTS.map((row) => `${row[0]} ${row[1]}`);
    expect([...live, "POST /brand-new"].filter((entry) => !policy.includes(entry))).toEqual([
      "POST /brand-new",
    ]);
    expect([...policy, "GET /gone"].filter((entry) => !live.includes(entry))).toEqual(["GET /gone"]);
    expect(live.includes("GET /verify-email")).toBe(true);
    expect(live.includes("POST /verify-email")).toBe(false);
  });
});

describe("a SUSPENDED session against the real handler", () => {
  it("every denied endpoint is refused and changes nothing; the allowed ones answer", async () => {
    const { client, user: row, email } = await verifiedUser();
    // A real, live delete link — to show the callback cannot be used either.
    await send(client, "/api/auth/delete-user", { json: {} });
    const deleteLink = linkIn(await waitForMail(email, "deleteAccountVerification"));
    // Suspended with the session row still there: the cookie Better Auth would honour.
    await testDb()
      .update(user)
      .set({ suspendedAt: new Date(), suspendedReason: "test" })
      .where(eq(user.id, row.id));
    client.cookies.delete("hf.session_data");
    const before = await fingerprint(row.id);

    // The emailed delete link (a GET that would act on the account) is refused as well.
    const viaLink = await send(client, deleteLink);
    expect(viaLink.status).toBe(403);
    expect(viaLink.body).toMatchObject({ details: { reason: "account_suspended" } });

    const state: AuthGateState = "suspended";
    const rows = [...AUTH_ENDPOINTS].sort(
      (a, b) => Number(a[1] === "/sign-out") - Number(b[1] === "/sign-out"),
    );
    for (const policyRow of rows) {
      const sent = await request(client, policyRow);
      expectDecision(state, policyRow[COLUMN[state]], sent, `${policyRow[0]} ${policyRow[1]}`);
      if (policyRow[1] === "/list-sessions") expect(sent.text).not.toMatch(/"token"/);
      if (policyRow[1] !== "/sign-out") expect(await sessionsOf(row.id), policyRow[1]).toHaveLength(1);
    }
    expect(await fingerprint(row.id), "nothing about the account changed").toEqual(before);
    expect((await userById(row.id))!.deleteScheduledAt).toBeNull();
  });
});

describe("an IMPERSONATED session against the real handler", () => {
  it("every denied endpoint is refused and changes nothing about the target; stop-impersonating works", async () => {
    const admin = await verifiedUser();
    await promoteToAdmin(admin.user.id);
    admin.client.cookies.delete("hf.session_data");
    const target = await verifiedUser();
    const started = await send(admin.client, "/api/auth/admin/impersonate-user", {
      json: { userId: target.user.id },
    });
    expect(started.status, started.text).toBe(200);
    const client = admin.client;
    const before = await fingerprint(target.user.id);

    const state: AuthGateState = "impersonating";
    const last = ["/admin/stop-impersonating", "/sign-out"];
    const rows = AUTH_ENDPOINTS.filter((r) => !last.includes(r[1]));
    for (const policyRow of rows) {
      const sent = await request(client, policyRow);
      expectDecision(state, policyRow[COLUMN[state]], sent, `${policyRow[0]} ${policyRow[1]}`);
      if (policyRow[1] === "/list-sessions") expect(sent.text).not.toMatch(/"token"/);
    }
    expect(await fingerprint(target.user.id), "nothing about the target changed").toEqual(before);
    // The way out is reachable.
    const stopped = await send(client, "/api/auth/admin/stop-impersonating", { json: {} });
    expect(stopped.status, stopped.text).toBe(200);
    expect(((await send(client, "/api/auth/get-session")).body as { user: { id: string } }).user.id).toBe(
      admin.user.id,
    );
  });
});

describe("a session past its DELETION date against the real handler", () => {
  it("every endpoint: refused as 'no session' (or answered signed-out), nothing changes, and the session is revoked", async () => {
    const state: AuthGateState = "deleted";
    const check = async (policyRow: (typeof AUTH_ENDPOINTS)[number]) => {
      const { client, user: row } = await verifiedUser();
      const past = new Date(Date.now() - 60_000);
      await testDb().update(user).set({ deleteScheduledAt: past }).where(eq(user.id, row.id));
      client.cookies.delete("hf.session_data");
      const before = await fingerprint(row.id);
      const sent = await request(client, policyRow);
      expectDecision(state, policyRow[COLUMN[state]], sent, `${policyRow[0]} ${policyRow[1]}`);
      expect(await fingerprint(row.id), `${policyRow[1]}: nothing changed`).toEqual(before);
      // No answer hands the browser a working session again.
      expect(
        sent.setCookies.some((c) => /session_token=[^;]/.test(c) && !/max-age=0/i.test(c)),
        policyRow[1],
      ).toBe(false);
      expect(await sessionsOf(row.id), `${policyRow[1]}: the session was revoked on first sight`).toEqual([]);
    };
    // One fresh account per endpoint (the first request revokes the session), eight at a time.
    for (let i = 0; i < AUTH_ENDPOINTS.length; i += 8) {
      await Promise.all(AUTH_ENDPOINTS.slice(i, i + 8).map(check));
    }
  });
});

describe("how the real router reads a path", () => {
  it("no other spelling of an endpoint is served as that endpoint", async () => {
    const { client, user: row } = await verifiedUser();
    for (const spelling of [
      "/api/auth/sign-out/",
      "/api/auth/Sign-Out",
      "/api/auth//sign-out",
      "/api/auth/sign%2Dout",
      "/api/auth/sign-out;x=1",
      "/api/auth/sign-out/extra",
    ]) {
      const sent = await send(client, spelling, { json: {} });
      expect(sent.status, spelling).toBe(404);
      expect(await sessionsOf(row.id), spelling).toHaveLength(1);
    }
    // And a method-override header does not turn a GET into the POST endpoint.
    for (const header of ["x-http-method-override", "x-method-override", "x-http-method"]) {
      const sent = await send(client, "/api/auth/sign-out", { headers: { [header]: "POST" } });
      expect(sent.status, header).toBe(404);
      expect(await sessionsOf(row.id), header).toHaveLength(1);
    }
    expect((await send(client, "/api/auth/sign-out", { json: {} })).status).toBe(200);
    expect(await sessionsOf(row.id)).toEqual([]);
  });

  it("a restricted session cannot reach a session read under another spelling", async () => {
    const { client, user: row } = await verifiedUser();
    await testDb()
      .update(user)
      .set({ deleteScheduledAt: new Date(Date.now() - 60_000) })
      .where(eq(user.id, row.id));
    client.cookies.delete("hf.session_data");
    for (const spelling of [
      "/api/auth/get-session/",
      "/api/auth/GET-SESSION",
      "/api/auth//get-session",
      "/api/auth/get%2Dsession",
    ]) {
      const anew = newClient({ cookies: new Map(client.cookies), ip: client.ip });
      const sent = await send(anew, spelling);
      expect(sent.text, spelling).not.toContain(row.email);
    }
  });
});
