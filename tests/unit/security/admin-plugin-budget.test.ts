// Q-B1 (T26B SEAM 2): an operator's Better Auth admin-plugin calls (/api/auth/admin/*) spend a
// bucket of their own — RL_ADMIN, 60 a minute, keyed by the admin's user id — never the address's
// sign-in budget (RL_AUTH, 20 a minute by address), so bulk moderation cannot lock the operator
// out of signing in. Sign-in, sign-up and the password routes keep their per-address limit.
//
// The behaviour is proven with stand-in bindings (the binding's own `limit({ key })` interface)
// given to each request: which limiter is asked, under which key, and what a refusal becomes.
// The real bindings count FIXED 60 s windows, so a count of real requests that should be refused
// is refused later when the run crosses a boundary — no fixed count is deterministic against them.
// The one real-binding test below asserts only what a window crossing cannot break (it can only
// reset a count, never add to one). The limits themselves (60 / 20) are wrangler.jsonc's.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { user } from "../../../src/worker/db/schema";
import {
  CAPTCHA,
  PASSWORD,
  newClient,
  promoteToAdmin,
  send,
  signIn,
  testDb,
  verifiedUser,
} from "../auth/helpers";

/** A made-up user id (Better Auth's shape): every call is refused for it, and changes nothing. */
const NOBODY = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL";
/** Three of the console's plugin calls, in turn: Better Auth's own limiter counts per path (30 a minute). */
const CALLS = [
  { path: "/api/auth/admin/unban-user", json: { userId: NOBODY } },
  { path: "/api/auth/admin/set-role", json: { userId: NOBODY, role: "user" } },
  { path: "/api/auth/admin/ban-user", json: { userId: NOBODY, banReason: "made up for a test" } },
];

async function anAdmin() {
  const made = await verifiedUser();
  await promoteToAdmin(made.user.id);
  return made;
}

const isOurRefusal = (sent: { status: number; body: unknown; headers: Headers }) =>
  sent.status === 429 &&
  (sent.body as { error?: string } | null)?.error === "rate_limited" &&
  sent.headers.get("retry-after") === "60";

type Limiter = "RL_AUTH" | "RL_ADMIN" | "RL_API";

/**
 * Stand-ins for the three limiters a request under /api/auth/* can reach: each records the key
 * it is asked about, and allows it unless `refuse(limiter, key)` says otherwise.
 */
function limiters(refuse: (limiter: Limiter, key: string) => boolean = () => false) {
  const asked: { limiter: Limiter; key: string }[] = [];
  const binding = (limiter: Limiter) => ({
    limit: async ({ key }: { key: string }) => {
      asked.push({ limiter, key });
      return { success: !refuse(limiter, key) };
    },
  });
  return {
    env: { RL_AUTH: binding("RL_AUTH"), RL_ADMIN: binding("RL_ADMIN"), RL_API: binding("RL_API") },
    keysOf: (limiter: Limiter) => asked.filter((one) => one.limiter === limiter).map((one) => one.key),
    reset: () => void asked.splice(0),
  };
}

const isBanned = async (userId: string) =>
  (await testDb().select({ banned: user.banned }).from(user).where(eq(user.id, userId)))[0]?.banned;

describe("Better Auth's admin plugin has a limiter bucket of its own", () => {
  it("every plugin call asks RL_ADMIN once, keyed by the admin's user id — and never RL_AUTH", async () => {
    const { client, user: admin } = await anAdmin();
    const fake = limiters();
    for (const call of CALLS) {
      fake.reset();
      const sent = await send(client, call.path, { json: call.json, env: fake.env });
      expect(sent.status, `${call.path}: ${sent.text}`).not.toBe(429);
      expect(fake.keysOf("RL_ADMIN"), call.path).toEqual([`u:${admin.id}`]);
      expect(fake.keysOf("RL_AUTH"), call.path).toEqual([]);
    }
    // Signed out, the plugin's gate refuses the call anyway: the bucket is then the address's.
    const stranger = newClient();
    fake.reset();
    const refused = await send(stranger, CALLS[0]!.path, { json: CALLS[0]!.json, env: fake.env });
    expect(refused.status, refused.text).not.toBe(429);
    expect(fake.keysOf("RL_ADMIN")).toEqual([`ip:${stranger.ip}`]);
    expect(fake.keysOf("RL_AUTH")).toEqual([]);
  });

  it("RL_ADMIN refusing is our 429 rate_limited with Retry-After 60, before the plugin acts — for that admin only", async () => {
    const { client, user: admin } = await anAdmin();
    const target = await verifiedUser();
    const fake = limiters((limiter, key) => limiter === "RL_ADMIN" && key === `u:${admin.id}`);
    const ban = { userId: target.user.id, banReason: "made up for a test" };

    const over = await send(client, "/api/auth/admin/ban-user", { json: ban, env: fake.env });
    expect(isOurRefusal(over), `${over.status} ${over.text}`).toBe(true);
    expect(await isBanned(target.user.id)).toBe(false);

    // Another admin at the same address has a budget of their own: the same ban goes through.
    const other = await anAdmin();
    other.client.ip = client.ip;
    const theirs = await send(other.client, "/api/auth/admin/ban-user", { json: ban, env: fake.env });
    expect(theirs.status, theirs.text).toBe(200);
    expect(await isBanned(target.user.id)).toBe(true);
  });

  it("control: sign-in still asks RL_AUTH by address (never RL_ADMIN), and RL_AUTH refusing is our 429", async () => {
    const client = newClient();
    const attempt = { email: "nobody@holdfast-test.example", password: PASSWORD };
    const fake = limiters();
    await send(client, "/api/auth/sign-in/email", { json: attempt, headers: CAPTCHA, env: fake.env });
    expect(fake.keysOf("RL_AUTH")).toEqual([`ip:${client.ip}`]);
    expect(fake.keysOf("RL_ADMIN")).toEqual([]);

    const full = limiters((limiter, key) => limiter === "RL_AUTH" && key === `ip:${client.ip}`);
    const over = await send(client, "/api/auth/sign-in/email", {
      json: attempt,
      headers: CAPTCHA,
      env: full.env,
    });
    expect(isOurRefusal(over), `${over.status} ${over.text}`).toBe(true);
  });

  // The real bindings. 25 plugin calls are more than RL_AUTH's 20, so had they spent the
  // address's sign-in budget, the sign-in after them would be refused. A window crossing can only
  // reset a count, and the calls rotate over three paths (under Better Auth's 30 a path): nothing
  // here can be refused because of when the run happens.
  it("smoke, real bindings: 25 plugin calls, then a sign-in from the same address still succeeds", async () => {
    const { client, email } = await anAdmin();
    for (let n = 0; n < 25; n++) {
      const call = CALLS[n % CALLS.length]!;
      const sent = await send(client, call.path, { json: call.json });
      expect(sent.status, `call ${n + 1}: ${sent.text}`).not.toBe(429);
    }
    const again = newClient({ ip: client.ip });
    const signedIn = await signIn(again, email);
    expect(signedIn.status, signedIn.text).toBe(200);
  });
});
