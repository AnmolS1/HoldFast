// R1 secsrv-n3: the console's own writes (/api/admin/*, every method but GET and HEAD) spend the
// operator's RL_ADMIN bucket (60 a minute, keyed by the admin's user id) as well as RL_API — the
// same bucket as the Better Auth admin plugin. Reads stay under RL_API alone: the console loads
// several lists at once on every page, and its polls must not use up the budget for acting.
//
// Proven with stand-in bindings (the binding's own `limit({ key })` interface), as in
// admin-plugin-budget.test.ts: which limiter is asked, under which key, and what a refusal becomes.
import { describe, expect, it } from "vitest";
import { admin, adminCall } from "../admin/helpers";

type Limiter = "RL_ADMIN" | "RL_API";

function limiters(refuse: (limiter: Limiter, key: string) => boolean = () => false) {
  const asked: { limiter: Limiter; key: string }[] = [];
  const binding = (limiter: Limiter) => ({
    limit: async ({ key }: { key: string }) => {
      asked.push({ limiter, key });
      return { success: !refuse(limiter, key) };
    },
  });
  return {
    env: { RL_ADMIN: binding("RL_ADMIN"), RL_API: binding("RL_API") },
    keysOf: (limiter: Limiter) => asked.filter((one) => one.limiter === limiter).map((one) => one.key),
  };
}

/** A user id nobody has (Better Auth's shape): the write is refused by the route, changing nothing. */
const NOBODY = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL";

describe("the admin console's writes spend RL_ADMIN", () => {
  it("a write under /api/admin/* asks RL_ADMIN once, keyed by the admin's user id (and RL_API)", async () => {
    const who = await admin();
    const fake = limiters();
    const sent = await adminCall(who.as, "POST", `/users/${NOBODY}/suspend`, {
      body: { reason: "made up for a test" },
      env: fake.env,
    });
    expect(sent.status).not.toBe(429);
    expect(fake.keysOf("RL_ADMIN")).toEqual([`u:${who.id}`]);
    expect(fake.keysOf("RL_API")).toEqual([`u:${who.id}`]);
  });

  it("RL_ADMIN refusing is our 429 rate_limited with Retry-After 60", async () => {
    const who = await admin();
    const fake = limiters((limiter) => limiter === "RL_ADMIN");
    const sent = await adminCall(who.as, "POST", `/users/${NOBODY}/suspend`, {
      body: { reason: "made up for a test" },
      env: fake.env,
    });
    expect(sent.status).toBe(429);
    expect(sent.body).toMatchObject({ error: "rate_limited" });
    expect(sent.headers.get("retry-after")).toBe("60");
  });

  it("a read under /api/admin/* never asks RL_ADMIN", async () => {
    const who = await admin();
    const fake = limiters((limiter) => limiter === "RL_ADMIN");
    const sent = await adminCall(who.as, "GET", "/users", { env: fake.env });
    expect(sent.status).toBe(200);
    expect(fake.keysOf("RL_ADMIN")).toEqual([]);
    expect(fake.keysOf("RL_API")).toEqual([`u:${who.id}`]);
  });
});
