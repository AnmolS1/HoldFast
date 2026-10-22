// Q-B1 (T26B SEAM 2): an operator's Better Auth admin-plugin calls (/api/auth/admin/*) spend a
// bucket of their own — RL_ADMIN, 60 a minute, keyed by the admin's user id — never the address's
// sign-in budget (RL_AUTH, 20 a minute by address), so bulk moderation cannot lock the operator
// out of signing in. Sign-in, sign-up and the password routes keep their per-address limit.
import { describe, expect, it } from "vitest";
import { CAPTCHA, PASSWORD, newClient, promoteToAdmin, send, signIn, verifiedUser } from "../auth/helpers";

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

describe("Better Auth's admin plugin has a limiter bucket of its own", () => {
  it("25 plugin calls, then a sign-in from the same address still succeeds", async () => {
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

  it("the admin bucket refuses at ITS limit: 60 calls pass, the 61st is 429 rate_limited — keyed by the admin, not the address", async () => {
    const { client } = await anAdmin();
    for (let n = 0; n < 60; n++) {
      const call = CALLS[n % CALLS.length]!;
      const sent = await send(client, call.path, { json: call.json });
      expect(sent.status, `call ${n + 1}: ${sent.text}`).not.toBe(429);
    }
    // Fixed 60 s windows: a run crossing a boundary is refused a little later than the 61st.
    let over = await send(client, CALLS[0]!.path, { json: CALLS[0]!.json });
    for (let extra = 0; extra < 30 && !isOurRefusal(over); extra++) {
      over = await send(client, CALLS[0]!.path, { json: CALLS[0]!.json });
    }
    expect(isOurRefusal(over), `${over.status} ${over.text}`).toBe(true);
    // Another admin at the same address has a budget of their own.
    const other = await anAdmin();
    other.client.ip = client.ip;
    const theirs = await send(other.client, CALLS[0]!.path, { json: CALLS[0]!.json });
    expect(theirs.status, theirs.text).not.toBe(429);
  });

  it("control: sign-in keeps its per-address limit — the 21st credential POST from one address is refused", async () => {
    const client = newClient();
    // The binding counts fixed 60 s windows: a run that crosses a boundary is refused later than the
    // 21st (CI: none by 21). So: never before the limit, and refused within ~1.5× of it.
    let refusedAt = 0;
    for (let n = 1; n <= 32 && refusedAt === 0; n++) {
      const sent = await send(client, "/api/auth/sign-in/email", {
        json: { email: `nobody-${n}@holdfast-test.example`, password: PASSWORD },
        headers: CAPTCHA,
      });
      if (isOurRefusal(sent)) refusedAt = n;
    }
    expect(refusedAt).toBeGreaterThanOrEqual(21);
    expect(refusedAt).toBeLessThanOrEqual(32);
  });
});
