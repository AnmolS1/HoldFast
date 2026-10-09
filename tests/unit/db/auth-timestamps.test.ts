// Better Auth's tables keep dates in `timestamp` WITHOUT time zone columns, as UTC wall-clock
// time. This file proves an instant survives the round trip when the process is NOT in UTC —
// through Better Auth's adapter, through a plain Drizzle select, and through a raw `pg` query
// (the path the OID-1114 type parser in db/client.ts exists for).
//
// The zone is set here, before any Date is created, so the proof holds under a plain `npm test`
// and in CI. The first test fails if the process is in UTC after all: a UTC run would compare
// nothing.

import { vi } from "vitest";

vi.hoisted(() => {
  process.env.TZ = "America/Chicago";
});

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionAdditionalFields, userAdditionalFields } from "../../../src/worker/auth/config";
// Importing the client module is what registers the type parser.
import { type Db } from "../../../src/worker/db/client";
import * as schema from "../../../src/worker/db/schema";
import { schedule } from "../../../src/worker/db/queries/user-purge";
import { userState } from "../../../src/worker/db/queries/users";
import { localDbUrl } from "../../setup/local-env";
import { openDb, rand } from "./_helpers";

/** 2026-01-15 18:30:45.123 UTC — 12:30 in Chicago, so a local-time reading is six hours off. */
const INSTANT = new Date(Date.UTC(2026, 0, 15, 18, 30, 45, 123));
const UTC_WALL_CLOCK = "2026-01-15 18:30:45.123";

let db: Db;
let close: () => Promise<void>;
let raw: Pool;

beforeAll(() => {
  ({ db, close } = openDb());
  raw = new Pool({ connectionString: localDbUrl(), max: 2 });
});

afterAll(async () => {
  await raw.end();
  await close();
});

function makeAuth() {
  return betterAuth({
    baseURL: "http://localhost",
    secret: "test-secret-test-secret-test-secret-test",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    user: { additionalFields: userAdditionalFields },
    session: { additionalFields: sessionAdditionalFields },
  });
}

async function createUserThroughBetterAuth() {
  const ctx = await makeAuth().$context;
  const created = await ctx.internalAdapter.createUser(
    { name: "Time Zone", email: `tz-${rand()}@example.test`, emailVerified: true },
    { method: "email-password" },
  );
  await ctx.internalAdapter.updateUser(created.id, { deleteScheduledAt: INSTANT });
  return { ctx, id: created.id };
}

describe("auth timestamps outside UTC", () => {
  it("runs in a zone that is not UTC", () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).not.toBe(0);
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(360);
  });

  it("adapter path: Better Auth writes and reads the same instant, stored as UTC wall-clock time", async () => {
    const before = Date.now();
    const { ctx, id } = await createUserThroughBetterAuth();
    const after = Date.now();

    const read = (await ctx.internalAdapter.findUserById(id)) as Record<string, unknown> | null;
    expect(read).not.toBeNull();
    const deleteScheduledAt = read!.deleteScheduledAt as Date;
    const createdAt = read!.createdAt as Date;
    expect(deleteScheduledAt).toBeInstanceOf(Date);
    expect(deleteScheduledAt.getTime()).toBe(INSTANT.getTime());
    // `createdAt` is "now": the same instant, not one shifted by the zone offset.
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(createdAt.getTime()).toBeLessThanOrEqual(after + 1000);

    const text = await db.execute<{ scheduled: string; created: string }>(
      sql`SELECT delete_scheduled_at::text AS scheduled, created_at::text AS created FROM "user" WHERE id = ${id}`,
    );
    expect(text.rows[0]!.scheduled).toBe(UTC_WALL_CLOCK);
    const storedCreated = new Date(text.rows[0]!.created.replace(" ", "T") + "Z").getTime();
    expect(Math.abs(storedCreated - createdAt.getTime())).toBeLessThan(2);
  });

  it("Drizzle path: a plain db.select() of the same row yields the same instant", async () => {
    const { id } = await createUserThroughBetterAuth();
    const [row] = await db
      .select({ deleteScheduledAt: schema.user.deleteScheduledAt, createdAt: schema.user.createdAt })
      .from(schema.user)
      .where(eq(schema.user.id, id));
    expect(row!.deleteScheduledAt!.getTime()).toBe(INSTANT.getTime());
    expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    // And through a query helper that hands the column on.
    expect((await userState(db, id))!.deleteScheduledAt!.getTime()).toBe(INSTANT.getTime());
  });

  it("raw path: a plain pg query of the column yields the same instant (the OID-1114 parser)", async () => {
    const { id } = await createUserThroughBetterAuth();
    const result = await raw.query<{ delete_scheduled_at: Date }>(
      'SELECT delete_scheduled_at FROM "user" WHERE id = $1',
      [id],
    );
    const value = result.rows[0]!.delete_scheduled_at;
    expect(value).toBeInstanceOf(Date);
    expect(value.getTime()).toBe(INSTANT.getTime());
  });

  it("write path: a query helper stores an instant as UTC wall-clock time", async () => {
    const { id } = await createUserThroughBetterAuth();
    const later = new Date(Date.UTC(2026, 6, 4, 3, 0, 0, 0));
    expect(await schedule(db, id, later)).toBe(true);
    const text = await db.execute<{ scheduled: string }>(
      sql`SELECT delete_scheduled_at::text AS scheduled FROM "user" WHERE id = ${id}`,
    );
    expect(text.rows[0]!.scheduled).toBe("2026-07-04 03:00:00");
    expect((await userState(db, id))!.deleteScheduledAt!.getTime()).toBe(later.getTime());
  });

  it("our own columns are timestamptz and round-trip regardless of the zone", async () => {
    const { id } = await createUserThroughBetterAuth();
    await schedule(db, id, INSTANT);
    const [row] = await db
      .select({ scheduledFor: schema.pendingUserPurges.scheduledFor })
      .from(schema.pendingUserPurges)
      .where(eq(schema.pendingUserPurges.userId, id));
    expect(row!.scheduledFor.getTime()).toBe(INSTANT.getTime());
    const viaRaw = await raw.query<{ scheduled_for: Date }>(
      "SELECT scheduled_for FROM pending_user_purges WHERE user_id = $1",
      [id],
    );
    expect(viaRaw.rows[0]!.scheduled_for.getTime()).toBe(INSTANT.getTime());
  });
});
