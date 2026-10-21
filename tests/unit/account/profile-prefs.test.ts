// GET/PATCH /api/account/profile and /api/account/prefs: where each setting is stored, the strict
// bodies, and that nothing tells a held account from another.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { user, userPrefs } from "../../../src/worker/db/schema";
import { api, auditRows, comparable, impersonated, person, testDb } from "../nodes/helpers";

const userRow = async (id: string) => (await testDb().select().from(user).where(eq(user.id, id)))[0]!;
const prefsRow = async (id: string) =>
  (await testDb().select().from(userPrefs).where(eq(userPrefs.userId, id)))[0] ?? null;

describe("profile", () => {
  it("GET answers the caller's own profile: name, address, zone, locale, no avatar — and nothing else", async () => {
    const me = await person({ timezone: "Europe/Berlin" });
    const got = await api(me.as, "GET", "/account/profile");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      displayName: me.row.name,
      email: me.row.email,
      timezone: "Europe/Berlin",
      locale: "en",
      avatar: null,
    });
  });

  it("PATCH writes the time zone, name and locale on `user` and answers the new profile", async () => {
    const me = await person();
    const patched = await api(me.as, "PATCH", "/account/profile", {
      body: { timezone: "America/New_York", displayName: "  Ada Lovelace ", locale: "en-gb" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      displayName: "Ada Lovelace",
      timezone: "America/New_York",
      locale: "en-GB",
    });
    const row = await userRow(me.id);
    expect([row.timezone, row.name, row.locale]).toEqual(["America/New_York", "Ada Lovelace", "en-GB"]);
    // No time zone in the preferences table — it has no such column, and nothing is written there.
    expect(Object.keys((await prefsRow(me.id)) ?? {})).not.toContain("timezone");
    expect(await auditRows({ action: "account.profile_updated", targetId: me.id })).toHaveLength(1);
  });

  it.each([
    ["quotaBytes", { quotaBytes: 1e15 }],
    ["legalHold", { legalHold: false }],
    ["usedBytes", { usedBytes: 0 }],
    ["role", { role: "admin" }],
    ["deleteScheduledAt", { deleteScheduledAt: null }],
    ["a field beside a valid one", { displayName: "X", suspendedAt: null }],
  ])("a body carrying %s is 400 validation and changes nothing", async (_name, body) => {
    const me = await person({ quotaBytes: 5_000_000_000, legalHold: true });
    const before = await userRow(me.id);
    const answer = await api(me.as, "PATCH", "/account/profile", { body });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("validation");
    expect(await userRow(me.id)).toEqual(before);
    expect(await auditRows({ action: "account.profile_updated", targetId: me.id })).toHaveLength(0);
  });

  it.each([
    ["an unknown time zone", { timezone: "Mars/Olympus_Mons" }],
    ["a name of a control character only", { displayName: "\u0007" }],
    ["a name with a line separator", { displayName: "Ada Lovelace" }],
    ["a name of spaces", { displayName: "   " }],
    ["a locale that is no tag", { locale: "not a tag!" }],
  ])("%s is 400 validation", async (_name, body) => {
    const me = await person();
    const answer = await api(me.as, "PATCH", "/account/profile", { body });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("validation");
    expect((await userRow(me.id)).timezone).toBeNull();
  });

  it("needs a session (401) and is read-only under impersonation (403)", async () => {
    const me = await person();
    expect((await api(null, "GET", "/account/profile")).status).toBe(401);
    const answer = await api(impersonated(me), "PATCH", "/account/profile", { body: { timezone: "UTC" } });
    expect(answer.status).toBe(403);
    expect((await userRow(me.id)).timezone).toBeNull();
  });

  it("a held account's profile is the same answer as an unheld one's — no hold field, nothing that differs", async () => {
    const held = await person({ name: "Same Name", legalHold: true, timezone: "UTC" });
    const free = await person({ name: "Same Name", legalHold: false, timezone: "UTC" });
    const a = await api(held.as, "GET", "/account/profile");
    const b = await api(free.as, "GET", "/account/profile");
    expect(JSON.stringify(a.body)).not.toMatch(/hold/i);
    expect(comparable(a, { [held.row.email]: "EMAIL" })).toEqual(
      comparable(b, { [free.row.email]: "EMAIL" }),
    );
  });
});

describe("preferences", () => {
  it("GET answers the defaults for an account without a row, emailSecurity always true", async () => {
    const me = await person();
    const got = await api(me.as, "GET", "/account/prefs");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      density: "compact",
      theme: "system",
      viewMode: "list",
      emailShares: true,
      emailLinkDigest: true,
      emailSecurity: true,
    });
  });

  it("PATCH writes `user_prefs` (not `user`) and answers the new preferences", async () => {
    const me = await person();
    const answer = await api(me.as, "PATCH", "/account/prefs", {
      body: { theme: "dark", density: "comfortable", viewMode: "grid", emailShares: false },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      theme: "dark",
      density: "comfortable",
      viewMode: "grid",
      emailShares: false,
    });
    expect(await prefsRow(me.id)).toMatchObject({
      theme: "dark",
      density: "comfortable",
      viewMode: "grid",
      emailShares: false,
      emailSecurity: true,
    });
    // A preference is no security fact: no audit row (review m2; the profile keeps its rows).
    expect(await auditRows({ action: "account.prefs_updated", targetId: me.id })).toHaveLength(0);
    // A second write changes only what it names.
    await api(me.as, "PATCH", "/account/prefs", { body: { theme: "light" } });
    expect(await prefsRow(me.id)).toMatchObject({ theme: "light", density: "comfortable", viewMode: "grid" });
  });

  it.each([
    ["emailSecurity", { emailSecurity: false }],
    ["quotaBytes", { theme: "dark", quotaBytes: 1 }],
    ["legalHold", { legalHold: true }],
    ["timezone", { timezone: "UTC" }],
    ["an unknown theme", { theme: "neon" }],
    ["nothing", {}],
  ])("a body with %s is 400 validation and writes nothing", async (_name, body) => {
    const me = await person();
    const answer = await api(me.as, "PATCH", "/account/prefs", { body });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("validation");
    expect(await prefsRow(me.id)).toBeNull();
  });
});
