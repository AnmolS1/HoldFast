// Every mutating route of the admin console writes an `audit_log` row with the admin as actor
// and a target (task Steps 3 / acceptance 1). The test ITERATES the router: a mutating route
// with no scenario below fails the first test, so a route added later must bring its own.
//
// Each two-step route is called with `confirm: true` (the preview writes nothing, by design).
// Two routes write the shared `settings` table and are proven in the table-wide files instead
// (PLAN §6 rule 16): PATCH /admin/settings (settings.tablewide.test.ts, `admin.settings_changed`)
// and POST /admin/system/generation (generation.tablewide.test.ts, `admin.generation_accepted`).
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { auditLog, strikes, uploads } from "../../../src/worker/db/schema";
import { uuidv7 } from "../../../src/worker/db/ids";
import { jobs } from "../../../src/worker/jobs/index";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { router } from "../../../src/worker/routes/admin";
import { keyFor } from "../../../src/worker/services/storage";
import { generationInStep } from "../trash/helpers";
import {
  admin,
  adminCall,
  auditAbout,
  lockedFile,
  madeUpSha,
  makeFile,
  makeFolder,
  makeLink,
  member,
  operators,
  rand,
  reported,
  testDb,
  type Answer,
} from "./helpers";

type Admin = Awaited<ReturnType<typeof admin>>;
/** One successful request of the route, and the target id its audit row must name (null: none by design). */
type Scenario = (who: Admin) => Promise<{ answer: Answer; targetId: string | null; action: string }>;

const REASON = { reason: "Checked with the account holder." };
const IN_TABLEWIDE = new Set(["PATCH /admin/settings", "POST /admin/system/generation"]);

const scenarios: Record<string, Scenario> = {
  "POST /admin/users/:userId/suspend": async (who) => {
    const target = await member();
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/suspend`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.user_suspended" };
  },
  "POST /admin/users/:userId/unsuspend": async (who) => {
    const target = await member({ suspendedAt: new Date(), suspendedReason: "by hand" });
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/unsuspend`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.user_unsuspended" };
  },
  "POST /admin/users/:userId/revoke-sessions": async (who) => {
    const target = await member();
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/revoke-sessions`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.sessions_revoked" };
  },
  "POST /admin/users/:userId/revoke-links": async (who) => {
    const target = await member();
    const file = await makeFile(target.id, null, { scanStatus: "clean" });
    await makeLink(file.id, target.id);
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/revoke-links`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.links_revoked" };
  },
  "PATCH /admin/users/:userId/quota": async (who) => {
    const target = await member();
    const answer = await adminCall(who.as, "PATCH", `/users/${target.id}/quota`, {
      body: { quotaBytes: 10_000_000_000 },
    });
    return { answer, targetId: target.id, action: "admin.quota_set" };
  },
  // T10's own row is the strike's record (one row: a duplicate writes none — users.test.ts).
  "POST /admin/users/:userId/strikes": async (who) => {
    const target = await member();
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/strikes`, {
      body: { userId: target.id, kind: "abuse", note: "By hand." },
    });
    return { answer, targetId: target.id, action: "strike.added" };
  },
  "POST /admin/strikes/:strikeId/lift": async (who) => {
    const target = await member();
    const [strike] = await testDb().insert(strikes).values({ userId: target.id, kind: "abuse" }).returning();
    const answer = await adminCall(who.as, "POST", `/strikes/${strike!.id}/lift`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.strike_lifted" };
  },
  "POST /admin/users/:userId/legal-hold": async (who) => {
    const target = await member();
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, {
      body: { held: true, note: "Preservation request." },
    });
    return { answer, targetId: target.id, action: "admin.legal_hold_set" };
  },
  "POST /admin/users/:userId/deletion": async (who) => {
    const target = await member();
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/deletion`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.deletion_scheduled" };
  },
  "POST /admin/users/:userId/deletion/cancel": async (who) => {
    const target = await member();
    await adminCall(who.as, "POST", `/users/${target.id}/deletion`, { body: REASON });
    const answer = await adminCall(who.as, "POST", `/users/${target.id}/deletion/cancel`, { body: REASON });
    return { answer, targetId: target.id, action: "admin.deletion_cancelled" };
  },
  "POST /admin/quarantine/:nodeId": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "infected", sha256: madeUpSha() });
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, {
      body: { action: "release", note: "A false positive." },
    });
    return { answer, targetId: file.id, action: "admin.false_positive" };
  },
  "POST /admin/kept-uploads/:uploadId/resolve": async (who) => {
    const owner = await member();
    const nodeId = uuidv7();
    const versionId = uuidv7();
    const name = `kept-${rand()}.bin`;
    const [session] = await testDb()
      .insert(uploads)
      .values({
        ownerId: owner.id,
        uploaderId: owner.id,
        parentId: null,
        nodeId,
        versionId,
        name,
        nameKey: name,
        size: 10,
        r2Key: keyFor(owner.id, nodeId, versionId),
        expiresAt: new Date(Date.now() + 3_600_000),
        status: "completing",
        completingAt: new Date(Date.now() - 3 * 3_600_000),
        expectedSha256: madeUpSha(),
      })
      .returning();
    keptSessions.push(session!.id);
    await testDb().insert(auditLog).values({
      actorType: "system",
      action: "upload.csam_node_owed",
      targetType: "upload",
      targetId: session!.id,
    });
    const answer = await adminCall(who.as, "POST", `/kept-uploads/${session!.id}/resolve`, {
      body: { resolution: "relist", reason: "Listed again on purpose.", confirm: true },
    });
    return { answer, targetId: session!.id, action: "admin.kept_upload_relisted" };
  },
  "POST /admin/reports/:id/assign": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const reportId = await reported(file.id, owner.id, "spam");
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/assign`, {
      body: { assignToMe: true },
    });
    return { answer, targetId: reportId, action: "admin.report_assigned" };
  },
  "POST /admin/reports/:id/action": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const reportId = await reported(file.id, owner.id, "spam");
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "dismiss", resolution: "Not spam." },
    });
    return { answer, targetId: reportId, action: "admin.report_dismissed" };
  },
  "POST /admin/reports/:id/ncmec/start": async (who) => {
    const { reportId } = await lockedFile();
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/start`);
    return { answer, targetId: reportId, action: "admin.ncmec_started" };
  },
  "POST /admin/reports/:id/ncmec/evidence": async (who) => {
    const { reportId } = await lockedFile();
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/evidence`);
    return { answer, targetId: reportId, action: "admin.ncmec_evidence_opened" };
  },
  "POST /admin/reports/:id/ncmec/filed": async (who) => {
    const { reportId } = await lockedFile();
    await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/start`);
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/filed`, {
      body: { reportId: "123456789", filedAt: new Date().toISOString() },
    });
    return { answer, targetId: reportId, action: "admin.ncmec_filed" };
  },
  "POST /admin/reports/:id/release-holds": async (who) => {
    const { reportId } = await lockedFile();
    await adminCall(who.as, "POST", `/reports/${reportId}/clear-lock`, {
      body: { reason: "Listed in error.", confirm: true },
    });
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/release-holds`, {
      body: { reason: "Dismissed, never filed.", confirm: true },
    });
    return { answer, targetId: reportId, action: "admin.csam_holds_released" };
  },
  "POST /admin/reports/:id/clear-lock": async (who) => {
    const { reportId, file } = await lockedFile();
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/clear-lock`, {
      body: { reason: "Listed in error.", confirm: true },
    });
    return { answer, targetId: file.id, action: "admin.csam_lock_cleared" };
  },
  "POST /admin/moderation/lock-csam": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
    const answer = await adminCall(who.as, "POST", "/moderation/lock-csam", {
      body: { reference: file.id, reason: "An outside notice.", confirm: true },
      env: operators().env,
    });
    return { answer, targetId: file.id, action: "admin.csam_lock_manual" };
  },
  "POST /admin/dmca": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const answer = await adminCall(who.as, "POST", "/dmca", { body: notice([file.id]) });
    return { answer, targetId: answer.body?.notices?.[0]?.id ?? null, action: "admin.dmca_notice_created" };
  },
  "POST /admin/dmca/:id/action": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await adminCall(who.as, "POST", "/dmca", { body: notice([file.id]) });
    const id = made.body.notices[0].id as string;
    const answer = await adminCall(who.as, "POST", `/dmca/${id}/action`, {
      body: { action: "mark_incomplete" },
    });
    return { answer, targetId: id, action: "admin.dmca_mark_incomplete" };
  },
  "POST /admin/dmca/:id/counter": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const made = await adminCall(who.as, "POST", "/dmca", { body: notice([file.id]) });
    const id = made.body.notices[0].id as string;
    await adminCall(who.as, "POST", `/dmca/${id}/action`, { body: { action: "takedown" } });
    const answer = await adminCall(who.as, "POST", `/dmca/${id}/counter`, {
      body: {
        counterName: "The Uploader",
        counterAddress: "2 Example Road",
        counterEmail: "uploader@example.test",
        counterStatement: "Removed by mistake.",
        counterConsentJurisdiction: true,
        counterSignature: "The Uploader",
      },
    });
    return { answer, targetId: id, action: "admin.dmca_counter_received" };
  },
  "POST /admin/links/:id": async (who) => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, owner.id);
    const answer = await adminCall(who.as, "POST", `/links/${link.id}`, { body: { action: "lock" } });
    return { answer, targetId: link.id, action: "admin.link_locked" };
  },
  "POST /admin/links/:id/anomaly": async (who) => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const link = await makeLink(folder.id, owner.id);
    const answer = await adminCall(who.as, "POST", `/links/${link.id}/anomaly`, {
      body: { paused: true, reason: "Traffic from one network." },
    });
    return { answer, targetId: link.id, action: "admin.link_anomaly_paused" };
  },
  // Invite codes are credentials of a sort: the row names the target type, never the code.
  "POST /admin/invites": async (who) => {
    const answer = await adminCall(who.as, "POST", "/invites", {
      body: { count: 1, note: `audit ${rand()}` },
    });
    return { answer, targetId: null, action: "admin.invites_created" };
  },
  "POST /admin/invites/:code/revoke": async (who) => {
    const made = await adminCall(who.as, "POST", "/invites", { body: { count: 1 } });
    const answer = await adminCall(who.as, "POST", `/invites/${made.body.invites[0].code}/revoke`);
    return { answer, targetId: null, action: "admin.invite_revoked" };
  },
  "POST /admin/system/scanner-check": async (who) => {
    const answer = await adminCall(who.as, "POST", "/system/scanner-check");
    return { answer, targetId: "scanner", action: "admin.scanner_checked" };
  },
  "POST /admin/system/destroy-pause": async (who) => {
    const answer = await adminCall(who.as, "POST", "/system/destroy-pause", {
      body: { on: true, reason: "A drill.", confirm: true },
    });
    await env.FILES.delete(DESTROY_PAUSED_KEY);
    return { answer, targetId: "destroy_pause", action: "admin.destroy_pause_set" };
  },
  "POST /admin/jobs/:name/run": async (who) => {
    const answer = await adminCall(who.as, "POST", "/jobs/backup/run");
    return { answer, targetId: "backup", action: "admin.job_run" };
  },
};

function notice(nodeIds: string[]) {
  return {
    receivedVia: "email",
    complainantName: "A. Rights-Holder",
    complainantEmail: "legal@example.test",
    workDescription: "A photograph.",
    infringingDescription: "The named file.",
    statementGoodFaith: true,
    statementAccuracy: true,
    signature: "A. Rights-Holder",
    nodeIds,
  };
}

/** A route path without its parameters' patterns: `/users/:userId{[A-Za-z0-9]{32}}` → `/users/:userId`. */
function bare(path: string): string {
  let out = "";
  let depth = 0;
  for (const ch of path) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (depth === 0) out += ch;
  }
  return out;
}

const mutating = () => [
  ...new Set(
    router.routes
      .filter((route) => ["POST", "PATCH", "PUT", "DELETE"].includes(route.method))
      .map((route) => `${route.method} ${bare(route.path)}`),
  ),
];

// `backup` is a placeholder here (T27's): its run must not touch other files' rows anyway.
const backup = jobs.find((job) => job.name === "backup")!;
const realRun = backup.run;
beforeAll(async () => {
  await generationInStep();
  backup.run = async () => ({ done: true });
});
/** Owed sessions made here, ended in `afterAll` (left `completing`, the repair sweep would act on them). */
const keptSessions: string[] = [];
afterAll(async () => {
  backup.run = realRun;
  if (keptSessions.length > 0) {
    await testDb()
      .update(uploads)
      .set({ status: "aborted", completedAt: new Date() })
      .where(inArray(uploads.id, keptSessions));
  }
});

describe("every mutating admin route writes an audit row with the admin as actor and a target", () => {
  it("there is a scenario for every mutating route the router declares (or it is proven table-wide)", () => {
    const routes = mutating();
    expect(routes.length).toBeGreaterThan(25);
    expect(routes.filter((key) => !IN_TABLEWIDE.has(key)).sort()).toEqual(Object.keys(scenarios).sort());
  });

  it.each(Object.keys(scenarios))("%s", async (key) => {
    const who = await admin();
    const started = new Date(Date.now() - 1000);
    const { answer, targetId, action } = await scenarios[key]!(who);
    expect(answer.status, answer.text.slice(0, 300)).toBe(200);
    const rows = (
      targetId === null
        ? await testDb().select().from(auditLog).where(eq(auditLog.actorUserId, who.id))
        : await auditAbout(targetId)
    )
      // A shared target (the scanner instances) is also audited by other files running at the same
      // time (system.test.ts' scanner-check), so only this admin's rows are this scenario's.
      .filter((row) => row.action === action && row.at >= started && row.actorUserId === who.id);
    expect(rows.length, `${action} for ${key}`).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.actorUserId).toBe(who.id);
      expect(row.actorType).toBe("admin");
      expect(row.targetType).not.toBeNull();
      if (targetId !== null) expect(row.targetId).toBe(targetId);
    }
  });
});
