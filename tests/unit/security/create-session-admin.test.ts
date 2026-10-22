// scripts/create-session.ts --role admin --two-factor (T26B SEAM 1): the session it seeds must
// pass the admin guard — two-factor on the account AND a second factor passed by THIS session
// (middleware/guards.ts requireAdmin). Seeded through the script's own module (scripts/lib/
// seed-session.ts), signed with this test environment's secret, and sent to the real Worker.
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { removeSeededUser, seedSession } from "../../../scripts/lib/seed-session";
import { newClient, send, testDb } from "../auth/helpers";
import { rand } from "../services-core/helpers";

const made: string[] = [];

async function seeded(twoFactor: boolean) {
  const email = `remote-spec-t26b-${rand(5).toLowerCase()}@holdfast-e2e.example`;
  made.push(email);
  const { cookie } = await seedSession(testDb(), {
    email,
    admin: true,
    twoFactor,
    ttlHours: 1,
    secret: env.BETTER_AUTH_SECRET,
    secure: false,
  });
  const client = newClient();
  client.cookies.set(cookie.name, cookie.value);
  return client;
}

afterAll(async () => {
  for (const email of made) await removeSeededUser(testDb(), email);
});

describe("create-session's admin session reaches the admin console", () => {
  it("--role admin --two-factor → an admin route answers 200", async () => {
    const answer = await send(await seeded(true), "/api/admin/invites");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  });

  it("control: --role admin without --two-factor → 403 admin_requires_2fa", async () => {
    const answer = await send(await seeded(false), "/api/admin/invites");
    expect([answer.status, (answer.body as { error?: string }).error]).toEqual([403, "admin_requires_2fa"]);
  });
});
