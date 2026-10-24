// The Settings screen's API (T25 section 3) against the REAL settings table — so this file is
// table-wide (PLAN §6 rule 16, brief R-d): it runs serially, snapshots every key it writes in
// `beforeAll` and puts each back (or removes it) in `afterAll`.
//   - a row wins over its var; a terms bump must name a new version, says how many accounts it
//     asks again, and from then an existing user's next mutation is `403 terms_required`;
//   - `readOnly` → a mutation through the real pipeline answers `503 read_only`; off → restored;
//   - `linksEnabled` off → `requireSwitch('linksEnabled')` on a test-local route answers
//     `503 feature_disabled` (the real link-creation route is T24's);
//   - every PATCH is audited with each key's value before and after.
import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../../src/worker/app";
import type { Auth } from "../../../src/worker/auth/types";
import { clearSettingsCache } from "../../../src/worker/db/queries/settings";
import { auditLog, settings as settingsTable } from "../../../src/worker/db/schema";
import { requireSwitch } from "../../../src/worker/middleware/kill-switch";
import type { AppEnv, CoreDeps } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { realCore } from "../auth/helpers";
import { admin, adminCall, call, member, rand, testDb } from "./helpers";

const KEYS = [
  "signupMode",
  "uploadsEnabled",
  "linksEnabled",
  "readOnly",
  "orphanDeleteEnabled",
  "ceilings",
  "termsVersion",
] as const;

let saved: (typeof settingsTable.$inferSelect)[] = [];
beforeAll(async () => {
  saved = await testDb()
    .select()
    .from(settingsTable)
    .where(inArray(settingsTable.key, [...KEYS]));
});
afterAll(async () => {
  await testDb()
    .delete(settingsTable)
    .where(inArray(settingsTable.key, [...KEYS]));
  if (saved.length > 0) await testDb().insert(settingsTable).values(saved);
  clearSettingsCache();
});

const TABLE = { tableSettings: true } as const;

/**
 * An admin who has accepted the terms the table names now: T07's terms gate refuses an admin's
 * mutations too (also under /api/admin) once the version has moved past theirs.
 */
async function operator() {
  const probe = await admin();
  const answer = await adminCall(probe.as, "GET", "/settings", TABLE);
  return admin({ termsVersion: answer.body.settings.termsVersion });
}

async function current(who: Awaited<ReturnType<typeof admin>>) {
  const answer = await adminCall(who.as, "GET", "/settings", TABLE);
  expect(answer.status).toBe(200);
  return answer.body;
}

/** A member who has accepted the terms the table names now (so the terms gate lets them through). */
async function upToDate(who: Awaited<ReturnType<typeof admin>>) {
  return member({ termsVersion: (await current(who)).settings.termsVersion });
}

const newFolder = (user: Awaited<ReturnType<typeof member>>) =>
  call(user.as, "POST", "/nodes/folder", { ...TABLE, body: { parentId: null, name: `f-${rand()}` } });

describe("settings: the table over the vars", () => {
  it("GET answers the table's row over the var, with the ceiling defaults and the account count", async () => {
    const who = await operator();
    const version = `t25-${rand()}`;
    const patched = await adminCall(who.as, "PATCH", "/settings", {
      ...TABLE,
      body: { termsVersion: version },
    });
    expect(patched.status).toBe(200);
    const body = await current(who);
    expect(body.settings.termsVersion).toBe(version);
    expect(version).not.toBe(env.TERMS_VERSION);
    expect(body.ceilingDefaults.CEIL_LINKS_DAY).toBe(Number(env.CEIL_LINKS_DAY));
    expect(body.ceilingDefaults.signupIpDay).toBe(3);
    expect(Number.isInteger(body.termsAccounts) && body.termsAccounts > 0).toBe(true);
  });

  it("a terms bump must name a NEW version (400 terms_unchanged); after one, an existing user's next mutation is 403 terms_required", async () => {
    const who = await operator();
    const before = (await current(who)).settings.termsVersion;
    const same = await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { termsVersion: before } });
    expect(same.status).toBe(400);
    expect(same.body.details.reason).toBe("terms_unchanged");

    const user = await upToDate(who);
    expect((await newFolder(user)).status).toBe(200);
    const bumped = `t25-${rand()}`;
    expect(
      (await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { termsVersion: bumped } })).status,
    ).toBe(200);
    const refused = await newFolder(user);
    expect([refused.status, refused.body.error]).toEqual([403, "terms_required"]);
  });

  it("every change is audited with its value before and after", async () => {
    const who = await operator();
    const before = (await current(who)).settings;
    const ceilings = { CEIL_LINKS_DAY: 7 };
    const answer = await adminCall(who.as, "PATCH", "/settings", {
      ...TABLE,
      body: { ceilings, orphanDeleteEnabled: !before.orphanDeleteEnabled },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.settings.ceilings).toEqual(ceilings);
    expect(answer.body.settings.orphanDeleteEnabled).toBe(!before.orphanDeleteEnabled);
    const mine = (await testDb().select().from(auditLog).where(eq(auditLog.actorUserId, who.id))).filter(
      (row) => row.action === "admin.settings_changed",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.meta).toEqual({
      changes: {
        ceilings: { from: before.ceilings, to: ceilings },
        orphanDeleteEnabled: { from: before.orphanDeleteEnabled, to: !before.orphanDeleteEnabled },
      },
    });
  });
});

describe("the kill switches take effect through the real pipeline", () => {
  it("readOnly on → a mutation answers 503 read_only (the admin API stays reachable to switch it back); off → restored", async () => {
    const who = await operator();
    const user = await upToDate(who);
    expect(
      (await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { readOnly: true } })).status,
    ).toBe(200);
    const refused = await newFolder(user);
    expect([refused.status, refused.body.error]).toEqual([503, "read_only"]);
    expect(
      (await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { readOnly: false } })).status,
    ).toBe(200);
    expect((await newFolder(user)).status).toBe(200);
  });

  it("linksEnabled off → requireSwitch('linksEnabled') answers 503 feature_disabled on a test-local route; on → it passes", async () => {
    const who = await operator();
    const user = await upToDate(who);
    const probe = new Hono<AppEnv>();
    probe.get("/_t25/links-probe", requireSwitch("linksEnabled"), (c) => c.json({ reached: true }));
    const auth: Auth = {
      handler: async () => new Response(null, { status: 501 }),
      api: {
        getSession: async () => ({
          session: {
            id: "s".repeat(32),
            userId: user.id,
            token: "made-up-session-token",
            expiresAt: new Date(Date.now() + 3_600_000),
            createdAt: new Date(),
            updatedAt: new Date(),
            impersonatedBy: null,
            secondFactorAt: null,
          },
          user: user.as.user,
        }),
      },
    };
    const core: CoreDeps = { ...realCore, createAuth: () => auth };
    const app = createApp(core, { extraRouters: [probe] });
    const allow = { limit: async () => ({ success: true }) };
    const ask = async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext;
      const response = await app.fetch(
        new Request(`${TEST_APP_ORIGIN}/api/_t25/links-probe`),
        { ...env, RL_AUTH: allow, RL_API: allow, RL_FILES: allow, RL_LINKS: allow } as unknown as Env,
        ctx,
      );
      const body = (await response.json()) as { error?: string; details?: { reason?: string } };
      while (pending.length) await Promise.allSettled(pending.splice(0));
      return { status: response.status, body };
    };
    // On only with a row saying so (no row fails closed, R1 secsrv-n1).
    expect(
      (await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { linksEnabled: true } })).status,
    ).toBe(200);
    expect((await ask()).status).toBe(200);
    expect(
      (await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { linksEnabled: false } })).status,
    ).toBe(200);
    const off = await ask();
    expect([off.status, off.body.error, off.body.details?.reason]).toEqual([
      503,
      "feature_disabled",
      "links_disabled",
    ]);
    expect(
      (await adminCall(who.as, "PATCH", "/settings", { ...TABLE, body: { linksEnabled: true } })).status,
    ).toBe(200);
    expect((await ask()).status).toBe(200);
  });
});
