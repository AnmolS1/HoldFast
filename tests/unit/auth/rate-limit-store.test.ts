// Better Auth's per-address limiter through our own store (auth/rate-limit-store.ts): the rows it
// wrote before — keyed by the raw address, `<ip>|<path>` — are still in the table when the store
// goes live (they go with the retention job two days later). A client's count there is taken over,
// not forgotten: a deploy must not hand an address that is at its limit a fresh window.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { storedAuthLimitKey } from "../../../src/worker/auth/rate-limit-store";
import { rateLimit } from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import { freshEmail, newClient, signIn, testDb, type Client } from "./helpers";

const PATH = "/sign-in/email";
const MAX = 5; // create-auth.ts customRules["/sign-in/email"]
const HOUR = 3_600_000;
const keys = createKeys(env.FILES_TOKEN_SECRET);
const WRONG = "made-up wrong password 1!";

async function legacyRow(client: Client, count: number, lastRequest: number) {
  await testDb().execute(
    sql`INSERT INTO rate_limit (id, key, count, last_request)
        VALUES (gen_random_uuid()::text, ${`${client.ip}|${PATH}`}, ${count}, ${lastRequest})`,
  );
}
const row = async (key: string) => (await testDb().select().from(rateLimit).where(eq(rateLimit.key, key)))[0];

describe("a row Better Auth wrote under the raw address before the store went live", () => {
  it("at its limit inside its window: the next request is refused (no fresh window), and the row stays until it ends", async () => {
    const client = newClient();
    await legacyRow(client, MAX, Date.now());
    const sent = await signIn(client, freshEmail(), WRONG);
    expect(sent.status).toBe(429);
    expect(Number(sent.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(await row(await storedAuthLimitKey(keys, `${client.ip}|${PATH}`))).toBeUndefined();
    expect(await row(`${client.ip}|${PATH}`)).toMatchObject({ count: MAX });
  });

  it("under its limit: the count carries on under the hashed key, and the raw-address row is gone", async () => {
    const client = newClient();
    await legacyRow(client, 2, Date.now());
    expect((await signIn(client, freshEmail(), WRONG)).status).toBe(401);
    expect(await row(await storedAuthLimitKey(keys, `${client.ip}|${PATH}`))).toMatchObject({ count: 3 });
    expect(await row(`${client.ip}|${PATH}`)).toBeUndefined();
    // …and the limit is the same limit: two more, then refused.
    for (let i = 4; i <= MAX; i++)
      expect((await signIn(client, freshEmail(), WRONG)).status, `#${i}`).toBe(401);
    expect((await signIn(client, freshEmail(), WRONG)).status).toBe(429);
  });

  it("past its window: counts for nothing — a new window starts at 1 — and the raw-address row is gone", async () => {
    const client = newClient();
    await legacyRow(client, MAX, Date.now() - HOUR);
    expect((await signIn(client, freshEmail(), WRONG)).status).toBe(401);
    expect(await row(await storedAuthLimitKey(keys, `${client.ip}|${PATH}`))).toMatchObject({ count: 1 });
    expect(await row(`${client.ip}|${PATH}`)).toBeUndefined();
  });
});
