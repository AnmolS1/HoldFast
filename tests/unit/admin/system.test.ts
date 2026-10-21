// The System screen's API (task §11): the panel, "Check scanner" (T20's `scannerHealth`, on
// demand only, R-e) and the pause switch's audited two-step action (R-b). The switch object lives
// in THIS file's bucket (isolated per test file); it is removed after every test.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { AdminSystemDto, ScannerCheckResponse } from "../../../src/shared/schemas/admin";
import { jobs } from "../../../src/worker/jobs/index";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { scannerProbe } from "../../../src/worker/routes/admin";
import type { ScannerStub } from "../../../src/worker/scan/container";
import { adminCall, admin, auditOf, baId, member, rand } from "./helpers";

afterEach(async () => {
  scannerProbe.deps = null;
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});

const switchOn = async () => (await env.FILES.head(DESTROY_PAUSED_KEY)) !== null;

/** The pause action's audit rows written for THIS reason (the table is shared by every file). */
const pauseRows = async (reason: string) =>
  [
    ...(await auditOf("admin.destroy_pause_set", "destroy_pause")),
    ...(await auditOf("admin.destroy_pause_cleared", "destroy_pause")),
  ].filter((row) => (row.meta as { reason?: string } | null)?.reason === reason);

const HEALTH = {
  ready: true,
  clamd: "up",
  engine: "ClamAV 1.4.1",
  dbVersion: "27432",
  dbAgeHours: 5,
  freshclam: "ok",
  busy: false,
};

describe("GET /admin/system", () => {
  it("the panel parses as the contract: every registry job with guarded/streamed, the switch and the detector", async () => {
    const who = await admin();
    const answer = await adminCall(who.as, "GET", "/system");
    expect(answer.status).toBe(200);
    const body = AdminSystemDto.parse(answer.body);
    expect(body.jobs.map((job) => job.name)).toEqual(jobs.map((job) => job.name));
    expect(body.jobs.find((job) => job.name === "purge")).toMatchObject({ guarded: true, streamed: false });
    expect(body.jobs.find((job) => job.name === "backup")).toMatchObject({ streamed: true });
    expect(body.detector.pauseSwitch).toBe("off");
    expect(body.database.ok).toBe(true);
    await env.FILES.put(DESTROY_PAUSED_KEY, "on");
    expect((await adminCall(who.as, "GET", "/system")).body.detector.pauseSwitch).toBe("on");
  });

  it("a switch that cannot be read shows as `unreadable`", async () => {
    const who = await admin();
    const broken = new Proxy(env.FILES, {
      get: (target, name) =>
        name === "get"
          ? async (key: string, options?: R2GetOptions) => {
              if (key === DESTROY_PAUSED_KEY) throw new Error("R2 is unavailable");
              return target.get(key, options);
            }
          : (Reflect.get(target, name, target) as () => unknown).bind(target),
    });
    const answer = await adminCall(who.as, "GET", "/system", { env: { FILES: broken } });
    expect(answer.body.detector.pauseSwitch).toBe("unreadable");
  });
});

describe('"Check scanner"', () => {
  it("where containers are off (SCAN_STUB=1): not available, no instance asked", async () => {
    const who = await admin();
    let asked = 0;
    scannerProbe.deps = {
      stub: () =>
        ({
          fetch: async () => {
            asked += 1;
            return Response.json(HEALTH);
          },
        }) as unknown as ScannerStub,
    };
    const answer = await adminCall(who.as, "POST", "/system/scanner-check", { env: { SCAN_STUB: "1" } });
    expect(answer.body).toEqual({ available: false, instances: [] });
    expect(asked).toBe(0);
  });

  it("both instances answer /health: ready, dbVersion, dbAgeHours, freshclam; one audit row per call", async () => {
    const who = await admin();
    const asked: string[] = [];
    scannerProbe.deps = {
      stub: (name) =>
        ({
          fetch: async (input: RequestInfo) => {
            asked.push(`${name} ${new URL(typeof input === "string" ? input : input.url).pathname}`);
            return Response.json(HEALTH);
          },
        }) as unknown as ScannerStub,
    };
    const before = (await auditOf("admin.scanner_checked", "scanner")).filter(
      (r) => r.actorUserId === who.id,
    );
    const answer = await adminCall(who.as, "POST", "/system/scanner-check", { env: { SCAN_STUB: "0" } });
    expect(answer.status).toBe(200);
    const body = ScannerCheckResponse.parse(answer.body);
    expect(asked).toEqual(["scanner-0 /health", "scanner-1 /health"]);
    expect(body).toEqual({
      available: true,
      instances: ["scanner-0", "scanner-1"].map((name) => ({
        name,
        ok: true,
        ready: true,
        dbVersion: "27432",
        dbAgeHours: 5,
        freshclam: "ok",
        error: null,
      })),
    });
    const after = (await auditOf("admin.scanner_checked", "scanner")).filter((r) => r.actorUserId === who.id);
    expect(after.length - before.length).toBe(1);
  });

  it("an instance that fails: ok false, an error NAME only — no message text", async () => {
    const who = await admin();
    scannerProbe.deps = {
      stub: () =>
        ({
          fetch: async () => {
            throw new Error("made-up transport failure with detail");
          },
        }) as unknown as ScannerStub,
    };
    const answer = await adminCall(who.as, "POST", "/system/scanner-check", { env: { SCAN_STUB: "0" } });
    expect(answer.status).toBe(200);
    for (const instance of answer.body.instances) {
      expect(instance).toMatchObject({ ok: false, ready: null });
      expect(typeof instance.error).toBe("string");
    }
    expect(answer.text).not.toContain("made-up transport failure");
  });
});

describe("the pause switch: POST /admin/system/destroy-pause", () => {
  it("preview changes nothing (no object, no audit row); confirm ON puts it, confirm OFF removes it — each audited with the reason", async () => {
    const who = await admin();
    const reason = `test ${rand()}`;
    const preview = await adminCall(who.as, "POST", "/system/destroy-pause", { body: { on: true, reason } });
    expect([preview.status, preview.body]).toEqual([
      200,
      { confirmed: false, before: "off", after: "on", changed: true },
    ]);
    expect(await switchOn()).toBe(false);
    expect(await pauseRows(reason)).toEqual([]);

    const on = await adminCall(who.as, "POST", "/system/destroy-pause", {
      body: { on: true, reason, confirm: true },
    });
    expect(on.body).toEqual({ confirmed: true, before: "off", after: "on", changed: true });
    expect(await switchOn()).toBe(true);
    // An OFF preview leaves it on.
    await adminCall(who.as, "POST", "/system/destroy-pause", { body: { on: false, reason } });
    expect(await switchOn()).toBe(true);
    const off = await adminCall(who.as, "POST", "/system/destroy-pause", {
      body: { on: false, reason, confirm: true },
    });
    expect(off.body).toEqual({ confirmed: true, before: "on", after: "off", changed: true });
    expect(await switchOn()).toBe(false);
    const rows = await pauseRows(reason);
    expect(rows.map((row) => row.action)).toEqual(["admin.destroy_pause_set", "admin.destroy_pause_cleared"]);
    for (const row of rows) expect(row).toMatchObject({ actorUserId: who.id, actorType: "admin" });
  });

  it("refused without a reason (400), without a fresh second factor, under impersonation, for a non-admin — the switch unchanged", async () => {
    const who = await admin();
    const someone = await member();
    const confirmOn = (reason: string) => ({ body: { on: true, reason, confirm: true } });
    expect((await adminCall(who.as, "POST", "/system/destroy-pause", confirmOn(""))).status).toBe(400);
    expect(
      (await adminCall(who.as, "POST", "/system/destroy-pause", { body: { on: true, confirm: true } }))
        .status,
    ).toBe(400);
    const stale = await adminCall(
      { ...who.as, secondFactorAt: null },
      "POST",
      "/system/destroy-pause",
      confirmOn("x"),
    );
    expect(stale.body.error).toBe("admin_requires_2fa");
    const impersonated = await adminCall(
      { ...who.as, impersonatedBy: baId() },
      "POST",
      "/system/destroy-pause",
      confirmOn("x"),
    );
    expect(impersonated.status).toBe(403);
    expect((await adminCall(someone.as, "POST", "/system/destroy-pause", confirmOn("x"))).status).toBe(403);
    expect(await switchOn()).toBe(false);
  });
});
