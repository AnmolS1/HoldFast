// The admin console's API (T25). Paths are relative to /api; every route is under /admin/ and
// calls `requireAdmin(c)` FIRST — an admin role, two-factor on the account AND a session that
// passed a second factor within 12 hours, never an impersonated session (`403 forbidden`, or
// `403 admin_requires_2fa`, which the console answers with its step-up prompt). The guard is per
// route, not a `use()` on the path: a path this router does not declare falls through to the
// rest of the app as before.
//
// Ban, unban, set role and impersonation are NOT here: the console calls Better Auth's admin
// plugin for those, through exactly the five paths of `ADMIN_PLUGIN_ALLOWED` (auth/admin-gate.ts).
//
// What the routes do: parse, guard, call the owner of each state change (services/admin-actions.ts
// orchestrates the multi-step ones), map rows to the shared contracts, audit. Every node in an
// answer is mapped by the admin variant of the node mapper (`toAdminNodeDtos`); none of these
// answers carries a content URL, a link URL or a token.
//
//   GET  /admin/dashboard                            AdminDashboardDto
//   GET  /admin/users  ·  GET /admin/users/:userId   AdminUserPage · AdminUserDetailDto
//   POST /admin/users/:userId/{suspend,unsuspend,revoke-sessions,revoke-links,strikes,legal-hold,deletion,deletion/cancel}
//   PATCH /admin/users/:userId/quota  ·  POST /admin/strikes/:strikeId/lift
//   GET|PATCH /admin/settings
//   GET  /admin/quarantine  ·  GET|POST /admin/quarantine/:nodeId
//   GET  /admin/kept-uploads  ·  POST /admin/kept-uploads/:uploadId/resolve
//   GET  /admin/reports  ·  GET /admin/reports/:id  ·  POST /admin/reports/:id/{assign,action,ncmec/start,ncmec/evidence,ncmec/filed,release-holds,clear-lock}
//   POST /admin/moderation/lock-csam
//   GET|POST /admin/dmca  ·  GET /admin/dmca/:id  ·  POST /admin/dmca/:id/{action,counter}  ·  GET /admin/dmca/:id/export
//   GET  /admin/links  ·  POST /admin/links/:id  ·  POST /admin/links/:id/anomaly
//   GET|POST /admin/invites  ·  POST /admin/invites/:code/revoke  ·  GET /admin/invites/export
//   GET  /admin/audit  ·  GET /admin/audit/export
//   GET  /admin/system  ·  POST /admin/system/{scanner-check,generation,destroy-pause}  ·  POST /admin/jobs/:name/run

import { Hono, type Context } from "hono";
import { sql } from "drizzle-orm";
import { CEILING_KEYS, STRIKE_WINDOW_DAYS } from "../../shared/constants";
import { BA_ID_PARAM, UUID_PARAM } from "../../shared/ids";
import {
  AcceptGenerationBody,
  AddStrikeBody,
  AdminLinkActionBody,
  AdminLinkAnomalyBody,
  AdminLinkListQuery,
  AdminReasonBody,
  AdminReportListQuery,
  AdminUserListQuery,
  AuditQuery,
  CounterNoticeBody,
  CreateDmcaNoticeBody,
  CreateInvitesBody,
  DestroyPauseBody,
  DmcaActionBody,
  DmcaListQuery,
  InviteListQuery,
  LockCsamBody,
  NcmecFiledBody,
  PatchSettingsBody,
  QuarantineActionBody,
  QuarantineQuery,
  ReportActionBody,
  ReportAssignBody,
  ResolveKeptUploadBody,
  SetLegalHoldBody,
  SetQuotaBody,
  SuspendUserBody,
  TwoStepBody,
  type AdminDashboardDto,
  type AdminLinkDto,
  type AdminStrikeDto,
  type AdminSystemDto,
  type AdminUserDetailDto,
  type AdminUserDto,
  type AnalyticsTilesDto,
  type AuditEntryDto,
  type DmcaNoticeDto,
  type InviteDto,
  type KeptUploadDto,
  type QuarantineItemDto,
  type ReportDetailDto,
  type ReportDto,
  type ScannerCheckResponse,
  type SettingsDto,
} from "../../shared/schemas/admin";
import * as adminQ from "../db/queries/admin";
import { todayTotals } from "../db/queries/ledger";
import { pauseLinks, unpauseLinks } from "../db/queries/links";
import { deletedKeptBytes, keptBackstopReached, usageBreakdown } from "../db/queries/quota";
import { backlog } from "../db/queries/scan-jobs";
import { clearSettingsCache, setSetting, type Settings } from "../db/queries/settings";
import { revokeLink } from "../db/queries/sharing";
import { EXPIRED_NOTE } from "../db/queries/strikes";
import type { Node, Report, Strike } from "../db/schema";
import { jobNames, jobs, runJob, softDeadlineOf } from "../jobs/index";
import { readPauseSwitch, readsRolledBack } from "../jobs/reconcile";
import { buildMeta } from "../meta";
import { requireAdmin } from "../middleware/guards";
import { SCANNER_INSTANCES, scannerHealth, type ScannerDeps } from "../scan/container";
import { cancelDeletion, revokeSessions, scheduleDeletion, suspendUser } from "../services/account-state";
import * as actions from "../services/admin-actions";
import { audit, auditInTx } from "../services/audit";
import { DMCA_NOTICE_BODY_MAX_BYTES, jsonBody } from "../services/body";
import { effectiveLimits } from "../services/ceilings";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { toAdminNodeDtos } from "../services/node-dto";
import {
  coreOf,
  db,
  defer,
  deps,
  resolveSettings,
  runBackground,
  type AppEnv,
} from "../services/request-context";
import { analyticsTiles } from "../services/metrics-queries";
import { enqueueRescan } from "../services/scanning";
import { SIGNUP_VELOCITY_DEFAULTS } from "../services/signup-policy";
import { storage } from "../services/storage";
import { addStrike, liftStrike } from "../services/strikes";

export const router = new Hono<AppEnv>();

type C = Context<AppEnv>;

const USER = `:userId{${BA_ID_PARAM}}`;
const ID = `:id{${UUID_PARAM}}`;
const NODE = `:nodeId{${UUID_PARAM}}`;

const actor = (admin: { id: string }) => ({ userId: admin.id, type: "admin" as const });
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** The reason an existing body leaves optional: refused empty or absent (a route rule, R-c). */
function requiredReason(value: string | undefined): string {
  const reason = value?.trim();
  if (!reason) throw new AppError("validation", "Give a reason.", { reason: "reason_required" });
  return reason;
}

// ── the analytics tiles (T27's import point) ────────────────────────────────────────────────

/**
 * THE ANALYTICS-TILES SWAP (EXECUTION.md), done (T27B P-2): the request tiles come from T27's
 * `analyticsTiles` (one Analytics Engine SQL request). Without the account id, the token or a
 * known environment — or on any answer it cannot read — it is `{ available: false }`, and the
 * console shows the tiles as "Unavailable".
 */
export async function loadAnalyticsTiles(c: C): Promise<AnalyticsTilesDto> {
  return analyticsTiles(c.env);
}

// ── row → contract ──────────────────────────────────────────────────────────────────────────

function userDto(account: adminQ.AdminUserRow): AdminUserDto {
  return {
    id: account.id,
    email: account.email,
    displayName: account.name,
    role: (account.role ?? "").split(",").includes("admin") ? "admin" : "user",
    emailVerified: account.emailVerified,
    twoFactorEnabled: account.twoFactorEnabled === true,
    createdAt: account.createdAt.toISOString(),
    quotaBytes: account.quotaBytes,
    // The TRUE counter, from the account row (never a session user's: it carries none).
    usedBytes: account.usedBytes,
    banned: account.banned === true,
    banReason: account.banReason,
    suspendedAt: iso(account.suspendedAt),
    suspendedReason: account.suspendedReason,
    deleteScheduledAt: iso(account.deleteScheduledAt),
    legalHold: account.legalHold,
    activeStrikes: account.activeStrikes,
    lastActiveAt: iso(account.lastActiveAt),
  };
}

/**
 * The strike list's states. A lift with no author is "system" — T10's expiry when its note says
 * so, otherwise also what an admin's lift looks like after that admin's account is deleted (the
 * column is `ON DELETE SET NULL`): the list never names an author it cannot read.
 */
export function strikeDto(row: Strike, at: Date): AdminStrikeDto {
  const expired = at.getTime() - row.at.getTime() > STRIKE_WINDOW_DAYS * 86_400_000;
  const state: AdminStrikeDto["state"] =
    row.liftedAt === null
      ? expired
        ? "expired"
        : "active"
      : row.liftedBy !== null
        ? "lifted"
        : (row.note ?? "").includes(EXPIRED_NOTE)
          ? "lifted_expired"
          : "lifted_by_system";
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    reportId: row.reportId,
    nodeId: row.nodeId,
    contentSha256: row.contentSha256,
    issuedBy: row.issuedBy,
    at: row.at.toISOString(),
    note: row.note,
    liftedAt: iso(row.liftedAt),
    liftedBy: row.liftedBy,
    state,
  };
}

function linkDto(row: adminQ.AdminLinkRow): AdminLinkDto {
  return {
    id: row.id,
    nodeId: row.nodeId,
    node: { name: row.nodeName, kind: row.nodeKind },
    ownerId: row.createdBy,
    pauseReasons: [...row.pauseReasons],
    pausedAt: iso(row.pausedAt),
    lockedByAdmin: row.lockedByAdmin,
    revokedAt: iso(row.revokedAt),
    expiresAt: iso(row.expiresAt),
    hasPassword: row.passwordHash !== null,
    maxDownloads: row.maxDownloads,
    downloadCount: row.downloadCount,
    bytesServed: row.bytesServed,
    createdAt: row.createdAt.toISOString(),
    lastAccessAt: iso(row.lastAccessAt),
  };
}

async function reportDtos(c: C, rows: Report[]): Promise<ReportDto[]> {
  const nodeIds = [...new Set(rows.flatMap((row) => (row.nodeId ? [row.nodeId] : [])))];
  const nodes: Node[] = [];
  for (const id of nodeIds) {
    const node = await adminQ.nodeRow(db(c), id);
    if (node && node.system === null) nodes.push(node);
  }
  const mapped = await toAdminNodeDtos(db(c), nodes);
  const byId = new Map(mapped.map((dto) => [dto.id, dto]));
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.nodeId,
    linkId: row.linkId,
    ownerId: row.ownerId,
    category: row.category,
    source: row.source,
    reporterEmail: row.reporterEmail,
    reporterUserId: row.reporterUserId,
    details: row.details,
    status: row.status,
    assignedTo: row.assignedTo,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    ncmecStartedAt: iso(row.ncmecStartedAt),
    ncmecFiledAt: iso(row.ncmecFiledAt),
    ncmecReportId: row.ncmecReportId,
    node: (row.nodeId && byId.get(row.nodeId)) || null,
  }));
}

async function reportDto(c: C, row: Report): Promise<ReportDto> {
  return (await reportDtos(c, [row]))[0]!;
}

async function quarantineItems(c: C, rows: Node[]): Promise<QuarantineItemDto[]> {
  const mapped = await toAdminNodeDtos(db(c), rows);
  return rows.map((row, index) => ({
    node: mapped[index]!,
    uploader: mapped[index]!.createdBy,
    signatures: [...(row.scanDetail?.signatures ?? [])],
    scannedAt: iso(row.scannedAt),
  }));
}

function noticeDto(row: adminQ.NoticeWithNodes): DmcaNoticeDto {
  return {
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    receivedVia: row.receivedVia,
    complainantName: row.complainantName,
    complainantOrg: row.complainantOrg,
    complainantAddress: row.complainantAddress,
    complainantPhone: row.complainantPhone,
    complainantEmail: row.complainantEmail,
    workDescription: row.workDescription,
    infringingDescription: row.infringingDescription,
    statementGoodFaith: row.statementGoodFaith,
    statementAccuracy: row.statementAccuracy,
    signature: row.signature,
    rawText: row.rawText,
    checklist: row.checklist,
    status: row.status,
    handledBy: row.handledBy,
    takedownAt: iso(row.takedownAt),
    ownerNotifiedAt: iso(row.ownerNotifiedAt),
    strikeId: row.strikeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    counterReceivedAt: iso(row.counterReceivedAt),
    counterName: row.counterName,
    counterAddress: row.counterAddress,
    counterPhone: row.counterPhone,
    counterEmail: row.counterEmail,
    counterStatement: row.counterStatement,
    counterConsentJurisdiction: row.counterConsentJurisdiction,
    counterSignature: row.counterSignature,
    counterForwardedAt: iso(row.counterForwardedAt),
    restoreNotBefore: iso(row.restoreNotBefore),
    restoreNotAfter: iso(row.restoreNotAfter),
    lawsuitNoticeAt: iso(row.lawsuitNoticeAt),
    restoredAt: iso(row.restoredAt),
    restoredBy: row.restoredBy,
    nodes: row.nodes.map((node) => ({
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      sha256: node.sha256,
      tookDown: node.tookDown,
    })),
  };
}

function inviteDto(row: {
  code: string;
  createdBy: string | null;
  maxUses: number;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  note: string | null;
  createdAt: Date;
}): InviteDto {
  return {
    code: row.code,
    createdBy: row.createdBy,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function auditDto(row: adminQ.AuditViewRow): AuditEntryDto {
  return {
    id: row.id,
    at: row.at.toISOString(),
    actorUserId: row.actorUserId,
    actorType: row.actorType,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    ua: row.ua,
    country: row.country,
    requestId: row.requestId,
    meta: row.meta,
  };
}

function keptDto(row: adminQ.KeptUploadRow): KeptUploadDto {
  return {
    uploadId: row.id,
    ownerId: row.ownerId,
    uploaderId: row.uploaderId,
    name: row.name,
    size: row.size,
    sha256: row.expectedSha256,
    listedAs: row.listedAs,
    owedAt: row.owedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ── dashboard ───────────────────────────────────────────────────────────────────────────────

router.get("/admin/dashboard", async (c) => {
  requireAdmin(c);
  const counts = await adminQ.dashboardCounts(db(c));
  const scan = await backlog(db(c));
  const body: AdminDashboardDto = {
    ...counts,
    scanBacklog: { running: scan.running, oldestStartedAt: iso(scan.oldestStartedAt) },
    pauseSwitch: await readPauseSwitch(c.env),
    analytics: await loadAnalyticsTiles(c),
  };
  return c.json(body);
});

// ── users ───────────────────────────────────────────────────────────────────────────────────

router.get("/admin/users", async (c) => {
  requireAdmin(c);
  const query = AdminUserListQuery.parse(c.req.query());
  const page = await adminQ.listUsers(db(c), query);
  return c.json({ items: page.items.map(userDto), nextCursor: page.nextCursor });
});

/** The user detail: the TRUE counter and the operator's breakdown, never the holder's figure. */
async function userDetail(c: C, userId: string): Promise<AdminUserDetailDto> {
  const account = await adminQ.adminUser(db(c), userId);
  if (!account) throw new AppError("not_found");
  const egress = await todayTotals(db(c), "link_owner", userId);
  const stored = resolveSettings(c.env, await coreOf(c).getSettings(db(c), { fresh: true }));
  const cap = effectiveLimits(
    c.env,
    stored,
    "download_owner",
    { quotaBytes: account.quotaBytes, createdAt: account.createdAt },
    now(c),
  );
  const usage = await usageBreakdown(db(c), userId);
  const kept = await deletedKeptBytes(db(c), userId);
  const counts = await adminQ.userCounts(db(c), userId);
  const strikes = await adminQ.strikesOf(db(c), userId);
  const at = now(c);
  return {
    user: userDto(account),
    linkEgressToday: { bytes: egress.bytes, count: egress.count, capBytes: cap.bytes ?? 0 },
    usage: {
      usedBytes: account.usedBytes,
      filesBytes: usage?.filesBytes ?? 0,
      trashBytes: usage?.trashBytes ?? 0,
      versionsBytes: usage?.versionsBytes ?? 0,
      reservedBytes: usage?.reservedBytes ?? 0,
      keptDeletedBytes: kept.files + kept.versions,
      keptBackstopReached: await keptBackstopReached(db(c), userId),
    },
    strikes: strikes.map((strike) => strikeDto(strike, at)),
    sessions: counts.sessions,
    links: counts.links,
    shares: counts.shares,
    legalHoldByHand: await adminQ.legalHoldSetByHand(db(c), userId),
  };
}

router.get(`/admin/users/${USER}`, async (c) => {
  requireAdmin(c);
  return c.json(await userDetail(c, c.req.param("userId")));
});

async function knownUser(c: C, userId: string) {
  if (!(await adminQ.adminUser(db(c), userId))) throw new AppError("not_found");
}

router.post(`/admin/users/${USER}/suspend`, async (c) => {
  const admin = requireAdmin(c);
  const userId = c.req.param("userId");
  const { reason } = SuspendUserBody.parse(await jsonBody(c));
  await knownUser(c, userId);
  const changed = await suspendUser(deps(c), userId, reason, actor(admin));
  audit(c, "admin.user_suspended", { type: "user", id: userId }, { reason, changed });
  return c.json(await userDetail(c, userId));
});

router.post(`/admin/users/${USER}/unsuspend`, async (c) => {
  const admin = requireAdmin(c);
  const userId = c.req.param("userId");
  const { reason } = AdminReasonBody.parse(await jsonBody(c));
  await knownUser(c, userId);
  const changed = await actions.unsuspend(c, admin, userId);
  audit(c, "admin.user_unsuspended", { type: "user", id: userId }, { reason, changed });
  return c.json(await userDetail(c, userId));
});

router.post(`/admin/users/${USER}/revoke-sessions`, async (c) => {
  requireAdmin(c);
  const userId = c.req.param("userId");
  const { reason } = AdminReasonBody.parse(await jsonBody(c));
  await knownUser(c, userId);
  const revoked = await revokeSessions(deps(c), userId);
  audit(c, "admin.sessions_revoked", { type: "user", id: userId }, { reason, revoked });
  return c.json({ revoked });
});

/** Bulk revoke of the user's links — irreversible (the console's dialog states the count). */
router.post(`/admin/users/${USER}/revoke-links`, async (c) => {
  requireAdmin(c);
  const userId = c.req.param("userId");
  const { reason } = AdminReasonBody.parse(await jsonBody(c));
  await knownUser(c, userId);
  // The revokes and their audit row commit together (m4): none of them without the record.
  const revoked = await db(c).transaction(async (tx) => {
    let count = 0;
    for (const id of await adminQ.unrevokedLinkIds(tx, userId)) {
      if (await revokeLink(tx, id)) count += 1;
    }
    await auditInTx(tx, c, "admin.links_revoked", { type: "user", id: userId }, { reason, revoked: count });
    return count;
  });
  return c.json({ revoked });
});

router.patch(`/admin/users/${USER}/quota`, async (c) => {
  requireAdmin(c);
  const userId = c.req.param("userId");
  const { quotaBytes } = SetQuotaBody.parse(await jsonBody(c));
  const changed = await adminQ.setQuota(db(c), userId, quotaBytes);
  if (!changed) throw new AppError("not_found");
  audit(c, "admin.quota_set", { type: "user", id: userId }, { from: changed.before, to: changed.after });
  return c.json(await userDetail(c, userId));
});

/**
 * A strike by hand. For a node that already has an unlifted strike of that kind T10 returns the
 * existing one (`created: false`): `200` with it, and no second strike audit row (T10's
 * `strike.added` is the row; this route writes none of its own).
 */
router.post(`/admin/users/${USER}/strikes`, async (c) => {
  const admin = requireAdmin(c);
  const userId = c.req.param("userId");
  const body = AddStrikeBody.parse(await jsonBody(c));
  if (body.userId !== userId) throw new AppError("validation", undefined, { reason: "user_mismatch" });
  await knownUser(c, userId);
  const node = body.nodeId ? await adminQ.nodeRow(db(c), body.nodeId) : null;
  const scanned = node && node.scanStatus !== "pending" ? node.sha256 : null;
  const result = await addStrike(deps(c), {
    userId,
    kind: body.kind,
    ...(body.nodeId ? { nodeId: body.nodeId } : {}),
    ...(body.reportId ? { reportId: body.reportId } : {}),
    ...(body.note ? { note: body.note } : {}),
    ...(scanned ? { sha256: scanned } : {}),
    issuedBy: admin.id,
  });
  const strike = await adminQ.strikeById(db(c), result.strikeId);
  return c.json({ strike: strikeDto(strike!, now(c)), created: result.created });
});

router.post(`/admin/strikes/${`:strikeId{${UUID_PARAM}}`}/lift`, async (c) => {
  const admin = requireAdmin(c);
  const strikeId = c.req.param("strikeId");
  const { reason } = AdminReasonBody.parse(await jsonBody(c));
  const strike = await adminQ.strikeById(db(c), strikeId);
  if (!strike) throw new AppError("not_found");
  const lifted = await liftStrike(deps(c), strikeId, admin.id);
  audit(c, "admin.strike_lifted", { type: "user", id: strike.userId }, { strikeId, reason });
  return c.json({ activeStrikes: lifted.activeStrikes });
});

router.post(`/admin/users/${USER}/legal-hold`, async (c) => {
  requireAdmin(c);
  const userId = c.req.param("userId");
  const body = SetLegalHoldBody.parse(await jsonBody(c));
  const reason = requiredReason(body.note);
  await knownUser(c, userId);
  await actions.setLegalHold(c, userId, body.held, reason);
  return c.json(await userDetail(c, userId));
});

/** "Delete user" — always T06's scheduled deletion (seven days; a held account is kept anyway). */
router.post(`/admin/users/${USER}/deletion`, async (c) => {
  const admin = requireAdmin(c);
  const userId = c.req.param("userId");
  const { reason } = AdminReasonBody.parse(await jsonBody(c));
  await knownUser(c, userId);
  const outcome = await scheduleDeletion(deps(c), userId, actor(admin));
  audit(c, "admin.deletion_scheduled", { type: "user", id: userId }, { reason, changed: outcome.changed });
  return c.json({ scheduledFor: iso(outcome.scheduledFor), changed: outcome.changed });
});

router.post(`/admin/users/${USER}/deletion/cancel`, async (c) => {
  const admin = requireAdmin(c);
  const userId = c.req.param("userId");
  const { reason } = AdminReasonBody.parse(await jsonBody(c));
  await knownUser(c, userId);
  const changed = await cancelDeletion(deps(c), userId, actor(admin));
  audit(c, "admin.deletion_cancelled", { type: "user", id: userId }, { reason, changed });
  return c.json({ scheduledFor: null, changed });
});

// ── settings ────────────────────────────────────────────────────────────────────────────────

/** Each ceiling key's default — the var, or the sign-up velocity default for the four without one. */
function ceilingDefaults(env: Env): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of CEILING_KEYS) {
    if (key in SIGNUP_VELOCITY_DEFAULTS) {
      out[key] = SIGNUP_VELOCITY_DEFAULTS[key as keyof typeof SIGNUP_VELOCITY_DEFAULTS];
      continue;
    }
    const value = Number((env as unknown as Record<string, unknown>)[key]);
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

async function settingsAnswer(c: C) {
  const stored = await coreOf(c).getSettings(db(c), { fresh: true });
  const resolved = resolveSettings(c.env, stored);
  const settings: SettingsDto = {
    signupMode: resolved.signupMode,
    uploadsEnabled: resolved.uploadsEnabled,
    linksEnabled: resolved.linksEnabled,
    readOnly: resolved.readOnly,
    demoMode: resolved.demoMode,
    orphanDeleteEnabled: stored.orphanDeleteEnabled !== false,
    ceilings: (stored.ceilings ?? {}) as SettingsDto["ceilings"],
    termsVersion: resolved.termsVersion,
  };
  return {
    settings,
    ceilingDefaults: ceilingDefaults(c.env),
    termsAccounts: await adminQ.termsAccounts(db(c)),
  };
}

router.get("/admin/settings", async (c) => {
  requireAdmin(c);
  return c.json(await settingsAnswer(c));
});

/**
 * Each key given is written (and audited with its value before and after); the settings cache
 * makes it effective everywhere within 60 s. A terms bump must name a NEW version.
 */
router.patch("/admin/settings", async (c) => {
  const admin = requireAdmin(c);
  const body = PatchSettingsBody.parse(await jsonBody(c));
  const before = (await settingsAnswer(c)).settings;
  if (body.termsVersion !== undefined && body.termsVersion === before.termsVersion) {
    throw new AppError("validation", "The new version must differ from the current one.", {
      reason: "terms_unchanged",
    });
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  // Every key and the audit row in ONE transaction (m4): no change commits without its record.
  await db(c).transaction(async (tx) => {
    for (const [key, value] of Object.entries(body) as [keyof Settings & keyof typeof body, unknown][]) {
      if (value === undefined) continue;
      await setSetting(tx, key, value as never, admin.id);
      changes[key] = { from: before[key as keyof SettingsDto], to: value };
    }
    await auditInTx(tx, c, "admin.settings_changed", { type: "settings", id: null }, { changes });
  });
  clearSettingsCache();
  return c.json(await settingsAnswer(c));
});

// ── quarantine ──────────────────────────────────────────────────────────────────────────────

router.get("/admin/quarantine", async (c) => {
  requireAdmin(c);
  const query = QuarantineQuery.parse(c.req.query());
  const page = await adminQ.listQuarantine(db(c), query);
  return c.json({ items: await quarantineItems(c, page.items), nextCursor: page.nextCursor });
});

router.get(`/admin/quarantine/${NODE}`, async (c) => {
  requireAdmin(c);
  const node = await adminQ.nodeRow(db(c), c.req.param("nodeId"));
  if (!node || node.system !== null) throw new AppError("not_found");
  const [item] = await quarantineItems(c, [node]);
  return c.json({
    item: item!,
    owner: item!.node.owner,
    scanReason: node.scanReason,
    scanDetail: (node.scanDetail as Record<string, unknown> | null) ?? null,
    sha256: item!.node.sha256,
    holds: await adminQ.holdCausesOf(db(c), node.id),
    links: (await adminQ.linksOnNode(db(c), node.id)).map(linkDto),
    malwareStrikeId: await adminQ.malwareStrikeFor(db(c), node.createdBy, node.id),
  });
});

router.post(`/admin/quarantine/${NODE}`, async (c) => {
  requireAdmin(c);
  const nodeId = c.req.param("nodeId");
  const body = QuarantineActionBody.parse(await jsonBody(c));
  if (body.action === "rescan") {
    // No pre-check of its own: `enqueueRescan` decides on the locked row (taken down — on the row
    // or through a folder above — or locked: nothing queued, and the admin is told why).
    const rescan = await enqueueRescan(deps(c), nodeId, { by: "admin" });
    if (rescan.queued) audit(c, "admin.rescan", { type: "node", id: nodeId }, { note: body.note ?? null });
    const node = await adminQ.nodeRow(db(c), nodeId);
    return c.json({ node: node ? (await toAdminNodeDtos(db(c), [node]))[0]! : null, rescan });
  }
  const reason = requiredReason(body.note);
  if (body.action === "release") {
    const done = await actions.markFalsePositive(c, nodeId, reason);
    return c.json({
      node: (await toAdminNodeDtos(db(c), [done.node]))[0]!,
      blocklistRemoved: done.blocklistRemoved,
      malwareStrikeId: done.malwareStrikeId,
    });
  }
  await actions.confirmDelete(c, nodeId, reason);
  return c.json({ node: null, purged: true });
});

// ── uploads kept under "keep and alert" ─────────────────────────────────────────────────────

router.get("/admin/kept-uploads", async (c) => {
  requireAdmin(c);
  const query = InviteListQuery.parse(c.req.query());
  const page = await adminQ.listKeptUploads(db(c), query.cursor, query.limit);
  return c.json({ items: page.items.map(keptDto), nextCursor: page.nextCursor });
});

router.post(`/admin/kept-uploads/${`:uploadId{${UUID_PARAM}}`}/resolve`, async (c) => {
  const admin = requireAdmin(c);
  const uploadId = c.req.param("uploadId");
  const body = ResolveKeptUploadBody.parse(await jsonBody(c));
  const done = await actions.resolveKeptUpload(
    c,
    admin,
    uploadId,
    body.resolution,
    body.reason,
    body.confirm === true,
  );
  return c.json({
    confirmed: done.confirmed,
    resolution: body.resolution,
    upload: keptDto(done.kept),
    ended: done.ended,
  });
});

// ── reports ─────────────────────────────────────────────────────────────────────────────────

router.get("/admin/reports", async (c) => {
  requireAdmin(c);
  const query = AdminReportListQuery.parse(c.req.query());
  const page = await adminQ.listReports(db(c), query);
  return c.json({ items: await reportDtos(c, page.items), nextCursor: page.nextCursor });
});

/** The report detail: metadata and counts — never content, never a URL. */
async function reportDetail(c: C, reportId: string): Promise<ReportDetailDto> {
  const report = await adminQ.reportRow(db(c), reportId);
  if (!report) throw new AppError("not_found");
  const node = report.nodeId ? await adminQ.nodeRow(db(c), report.nodeId) : null;
  const open = node ? await adminQ.openReportsOn(db(c), node.id) : { open: 0, reporters: 0 };
  const uploaderId = node ? await actions.currentUploader(c, node) : null;
  const uploader = uploaderId ? await adminQ.adminUser(db(c), uploaderId) : null;
  const at = now(c);
  const record = node ? await adminQ.lockRecord(db(c), node.id, report.id) : { locked: null, alerts: [] };
  return {
    report: await reportDto(c, report),
    openOnNode: open.open,
    distinctReporters: open.reporters,
    uploader: uploader
      ? {
          id: uploader.id,
          displayName: uploader.name,
          createdAt: uploader.createdAt.toISOString(),
          strikes: (await adminQ.strikesOf(db(c), uploader.id)).map((strike) => strikeDto(strike, at)),
        }
      : null,
    links: node
      ? await adminQ.linkSummary(db(c), node.id).then((summary) => ({
          count: summary.count,
          downloads: summary.downloads,
          bytesServed: summary.bytesServed,
          lastAccessAt: summary.lastAccessAt,
        }))
      : { count: 0, downloads: 0, bytesServed: 0, lastAccessAt: null },
    locked: record.locked,
    alerts: record.alerts,
    nodeIsFolder: node?.kind === "folder",
    releasableAt: report.ncmecFiledAt ? actions.releasableAt(report.ncmecFiledAt).toISOString() : null,
  };
}

router.get(`/admin/reports/${ID}`, async (c) => {
  requireAdmin(c);
  return c.json(await reportDetail(c, c.req.param("id")));
});

router.post(`/admin/reports/${ID}/assign`, async (c) => {
  const admin = requireAdmin(c);
  const { assignToMe } = ReportAssignBody.parse(await jsonBody(c));
  const report = await actions.assignReport(c, admin, c.req.param("id"), assignToMe);
  return c.json(await reportDto(c, report));
});

router.post(`/admin/reports/${ID}/action`, async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param("id");
  const body = ReportActionBody.parse(await jsonBody(c));
  const resolution = requiredReason(body.resolution);
  if (body.action === "dismiss") {
    const report = await actions.dismissReport(c, id, resolution);
    return c.json({ report: await reportDto(c, report), csamReportId: null });
  }
  const done =
    body.action === "escalate_csam"
      ? await actions.escalateReport(c, id, resolution)
      : await actions.actionReport(c, admin, id, body.action, resolution);
  return c.json({ report: await reportDto(c, done.report), csamReportId: done.csamReportId });
});

router.post(`/admin/reports/${ID}/ncmec/start`, async (c) => {
  requireAdmin(c);
  return c.json(await reportDto(c, await actions.ncmecStart(c, c.req.param("id"))));
});

/** A POST (CSRF-checked, never cached or prefetched), answered `no-store`. */
router.post(`/admin/reports/${ID}/ncmec/evidence`, async (c) => {
  requireAdmin(c);
  const evidence = await actions.ncmecEvidence(c, c.req.param("id"));
  return c.json(evidence, 200, { "cache-control": "no-store" });
});

router.post(`/admin/reports/${ID}/ncmec/filed`, async (c) => {
  requireAdmin(c);
  const body = NcmecFiledBody.parse(await jsonBody(c));
  await actions.ncmecFiled(c, c.req.param("id"), body);
  return c.json(await reportDetail(c, c.req.param("id")));
});

router.post(`/admin/reports/${ID}/release-holds`, async (c) => {
  requireAdmin(c);
  const body = TwoStepBody.parse(await jsonBody(c));
  return c.json(await actions.releaseHolds(c, c.req.param("id"), body.reason, body.confirm === true));
});

router.post(`/admin/reports/${ID}/clear-lock`, async (c) => {
  requireAdmin(c);
  const body = TwoStepBody.parse(await jsonBody(c));
  return c.json(await actions.clearLock(c, c.req.param("id"), body.reason, body.confirm === true));
});

router.post("/admin/moderation/lock-csam", async (c) => {
  requireAdmin(c);
  const body = LockCsamBody.parse(await jsonBody(c));
  return c.json(await actions.lockFromNotice(c, body.reference, body.reason, body.confirm === true));
});

// ── copyright notices ───────────────────────────────────────────────────────────────────────

router.get("/admin/dmca", async (c) => {
  requireAdmin(c);
  const query = DmcaListQuery.parse(c.req.query());
  const page = await adminQ.listNotices(db(c), query);
  return c.json({ items: page.items.map(noticeDto), nextCursor: page.nextCursor });
});

router.post("/admin/dmca", async (c) => {
  const admin = requireAdmin(c);
  const { nodeIds, receivedAt, ...fields } = CreateDmcaNoticeBody.parse(
    await jsonBody(c, DMCA_NOTICE_BODY_MAX_BYTES),
  );
  const created = await actions.createNotices(
    c,
    admin,
    { ...fields, ...(receivedAt ? { receivedAt: new Date(receivedAt) } : {}) },
    nodeIds,
  );
  const notices = [];
  for (const notice of created) notices.push(noticeDto((await adminQ.noticeById(db(c), notice.id))!));
  return c.json({ notices });
});

router.get(`/admin/dmca/${ID}`, async (c) => {
  requireAdmin(c);
  const notice = await adminQ.noticeById(db(c), c.req.param("id"));
  if (!notice) throw new AppError("not_found");
  return c.json(noticeDto(notice));
});

router.post(`/admin/dmca/${ID}/action`, async (c) => {
  const admin = requireAdmin(c);
  const body = DmcaActionBody.parse(await jsonBody(c));
  return c.json(noticeDto(await actions.noticeAction(c, admin, c.req.param("id"), body)));
});

router.post(`/admin/dmca/${ID}/counter`, async (c) => {
  const admin = requireAdmin(c);
  const body = CounterNoticeBody.parse(await jsonBody(c, DMCA_NOTICE_BODY_MAX_BYTES));
  return c.json(noticeDto(await actions.counterNotice(c, admin, c.req.param("id"), body)));
});

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

/** The notice as printable HTML (v1's export). Every value escaped; no script, no external resource. */
router.get(`/admin/dmca/${ID}/export`, async (c) => {
  requireAdmin(c);
  const notice = await adminQ.noticeById(db(c), c.req.param("id"));
  if (!notice) throw new AppError("not_found");
  const dto = noticeDto(notice);
  const rows = Object.entries(dto)
    .filter(([key]) => key !== "nodes")
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value))}</td></tr>`,
    )
    .join("");
  const nodes = dto.nodes
    .map(
      (node) =>
        `<li>${escapeHtml(node.nodeName ?? "")} — ${escapeHtml(node.nodeId)} — ${escapeHtml(node.sha256 ?? "")}</li>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Copyright notice ${escapeHtml(dto.id)}</title></head><body><h1>Copyright notice</h1><table>${rows}</table><h2>Named files</h2><ul>${nodes}</ul></body></html>`;
  audit(c, "admin.dmca_exported", { type: "dmca_notice", id: dto.id }, null);
  return c.body(html, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
});

// ── links ───────────────────────────────────────────────────────────────────────────────────

router.get("/admin/links", async (c) => {
  requireAdmin(c);
  const query = AdminLinkListQuery.parse(c.req.query());
  const page = await adminQ.listLinks(db(c), query);
  return c.json({ items: page.items.map(linkDto), nextCursor: page.nextCursor });
});

async function knownLink(c: C, id: string) {
  const link = await adminQ.linkRow(db(c), id);
  if (!link) throw new AppError("not_found");
  return link;
}

router.post(`/admin/links/${ID}`, async (c) => {
  requireAdmin(c);
  const id = c.req.param("id");
  const { action } = AdminLinkActionBody.parse(await jsonBody(c));
  await knownLink(c, id);
  if (action === "revoke") await revokeLink(db(c), id);
  else await adminQ.setLinkLocked(db(c), id, action === "lock");
  audit(c, `admin.link_${action === "revoke" ? "revoked" : action === "lock" ? "locked" : "unlocked"}`, {
    type: "link",
    id,
  });
  return c.json(linkDto(await knownLink(c, id)));
});

/**
 * Pause a link by hand with `anomaly`, or lift that reason — the only way before T22's midnight
 * job (00:05 UTC) lifts it. Only that reason: a link paused for another stays paused.
 */
router.post(`/admin/links/${ID}/anomaly`, async (c) => {
  requireAdmin(c);
  const id = c.req.param("id");
  const { paused, reason } = AdminLinkAnomalyBody.parse(await jsonBody(c));
  await knownLink(c, id);
  if (paused) await pauseLinks(db(c), { linkId: id }, "anomaly");
  else await unpauseLinks(db(c), { linkId: id }, "anomaly");
  audit(
    c,
    paused ? "admin.link_anomaly_paused" : "admin.link_anomaly_unpaused",
    { type: "link", id },
    { reason },
  );
  return c.json(linkDto(await knownLink(c, id)));
});

// ── invites ─────────────────────────────────────────────────────────────────────────────────

router.get("/admin/invites", async (c) => {
  requireAdmin(c);
  const query = InviteListQuery.parse(c.req.query());
  const page = await adminQ.listInvites(db(c), query);
  return c.json({ items: page.items.map(inviteDto), nextCursor: page.nextCursor });
});

router.post("/admin/invites", async (c) => {
  const admin = requireAdmin(c);
  const body = CreateInvitesBody.parse(await jsonBody(c));
  const created = await adminQ.createInvites(db(c), {
    count: body.count,
    maxUses: body.maxUses,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    note: body.note ?? null,
    createdBy: admin.id,
  });
  // The codes are credentials of a sort: the row names how many, never which.
  audit(
    c,
    "admin.invites_created",
    { type: "invite", id: null },
    { count: created.length, maxUses: body.maxUses },
  );
  return c.json({ invites: created.map(inviteDto) });
});

router.post("/admin/invites/:code{[A-Za-z0-9_-]{1,128}}/revoke", async (c) => {
  requireAdmin(c);
  const revoked = await adminQ.revokeInvite(db(c), c.req.param("code"));
  if (!revoked) throw new AppError("not_found");
  audit(c, "admin.invite_revoked", { type: "invite", id: null }, { changed: revoked.changed });
  return c.json(inviteDto(revoked.invite));
});

/** One CSV cell: quoted, and a leading formula character neutralised (a sheet must not run it). */
export function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;

router.get("/admin/invites/export", async (c) => {
  requireAdmin(c);
  const rows = await adminQ.allInvites(db(c));
  const head = csvLine(["code", "maxUses", "uses", "expiresAt", "revokedAt", "note", "createdAt"]);
  const body =
    head +
    rows
      .map((row) =>
        csvLine([
          row.code,
          row.maxUses,
          row.uses,
          iso(row.expiresAt),
          iso(row.revokedAt),
          row.note,
          iso(row.createdAt),
        ]),
      )
      .join("");
  audit(c, "admin.invites_exported", { type: "invite", id: null }, { count: rows.length });
  return c.body(body, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="invites.csv"',
    "cache-control": "no-store",
  });
});

// ── audit ───────────────────────────────────────────────────────────────────────────────────

router.get("/admin/audit", async (c) => {
  requireAdmin(c);
  const query = AuditQuery.parse(c.req.query());
  const page = await adminQ.listAudit(db(c), query);
  return c.json({
    items: page.items.map(auditDto),
    nextCursor: page.nextCursor,
    actors: await adminQ.actorsOf(
      db(c),
      page.items.map((row) => row.actorUserId),
    ),
  });
});

export const AUDIT_EXPORT_BATCH = 500;

/**
 * The audit log as CSV, streamed a batch at a time as the client reads (pull, backpressure); the
 * stream's completion is handed to `defer`, so the database stays open until it ends.
 */
router.get("/admin/audit/export", async (c) => {
  requireAdmin(c);
  const query = AuditQuery.parse(c.req.query());
  const filter = {
    actorUserId: query.actorUserId,
    action: query.action,
    targetType: query.targetType,
    targetId: query.targetId,
    from: query.from,
    to: query.to,
  };
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let started = false;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const columns = [
    "id",
    "at",
    "actorUserId",
    "actorType",
    "action",
    "targetType",
    "targetId",
    "ua",
    "country",
    "requestId",
    "meta",
  ];
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (!started) {
            started = true;
            controller.enqueue(encoder.encode(csvLine(columns)));
            return;
          }
          const page = await adminQ.auditBatch(db(c), { ...filter, cursor }, AUDIT_EXPORT_BATCH);
          const text = page.items
            .map(auditDto)
            .map((row) => csvLine(columns.map((column) => row[column as keyof AuditEntryDto])))
            .join("");
          if (text) controller.enqueue(encoder.encode(text));
          if (!page.nextCursor) {
            controller.close();
            finished();
            return;
          }
          cursor = page.nextCursor;
        } catch (error) {
          controller.error(error);
          finished();
        }
      },
      cancel() {
        finished();
      },
    },
    { highWaterMark: 0 },
  );
  defer(c, done);
  audit(c, "admin.audit_exported", { type: "audit", id: null }, { filter });
  return c.body(body, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="audit.csv"',
    "cache-control": "no-store",
  });
});

// ── system ──────────────────────────────────────────────────────────────────────────────────

/** Jobs whose pass is longer than a request's 20 s: run as a streamed response (v1: `backup`). */
export const STREAMED_JOBS: ReadonlySet<string> = new Set(["backup"]);
/** The plain pass: answered inside the request, then the caller calls again until `done`. */
export const RUN_NOW_SOFT_DEADLINE_MS = 20_000;
/** A streamed pass's wall time at most (spike S16-a: a streaming response lived 600 s). */
export const STREAMED_MAX_MS = 540_000;
/** How often a streamed pass looks for new progress records. */
export const PROGRESS_POLL_MS = 5_000;

/** The test seam of "Check scanner": T20's `scannerHealth` deps (the stub binding). Null in production. */
export const scannerProbe: { deps: ScannerDeps | null } = { deps: null };

const scannerAvailable = (env: Env) => env.SCAN_STUB !== "1" && Boolean(env.SCANNER);

router.get("/admin/system", async (c) => {
  requireAdmin(c);
  const meta = buildMeta();
  const healthy = async (probe: () => Promise<unknown>) => {
    try {
      await probe();
      return true;
    } catch {
      return false;
    }
  };
  const detector = await actions.readDetector(c);
  const body: AdminSystemDto = {
    build: {
      sha: meta.commit === "unknown" ? null : meta.commit,
      builtAt: meta.builtAt === "unknown" ? null : meta.builtAt,
    },
    database: { ok: await healthy(() => db(c).execute(sql`select 1`)) },
    storage: { ok: await healthy(() => storage(c.env).head("health-probe")) },
    flags: { photodnaEnabled: c.env.PHOTODNA_ENABLED === "true", scanStub: c.env.SCAN_STUB === "1" },
    scannerAvailable: scannerAvailable(c.env),
    jobs: jobs.map((job) => ({
      name: job.name,
      cron: job.cron,
      guarded: job.guarded === true,
      streamed: STREAMED_JOBS.has(job.name),
    })),
    detector: actions.publicReading(detector),
  };
  return c.json(body);
});

/** "Check scanner" — on demand only (the call wakes the containers): T20's `scannerHealth`, 5 s each. */
router.post("/admin/system/scanner-check", async (c) => {
  requireAdmin(c);
  const body: ScannerCheckResponse = { available: scannerAvailable(c.env), instances: [] };
  if (body.available) {
    for (const name of SCANNER_INSTANCES) {
      try {
        const health = await scannerHealth(c.env, name, scannerProbe.deps ?? undefined);
        body.instances.push({
          name,
          ok: health.ready === true,
          ready: health.ready,
          dbVersion: health.dbVersion,
          dbAgeHours: health.dbAgeHours,
          freshclam: health.freshclam,
          error: null,
        });
      } catch (error) {
        const kind = error instanceof Error ? error.name : "Error";
        body.instances.push({
          name,
          ok: false,
          ready: null,
          dbVersion: null,
          dbAgeHours: null,
          freshclam: null,
          error: kind,
        });
      }
    }
  }
  audit(
    c,
    "admin.scanner_checked",
    { type: "system", id: "scanner" },
    {
      available: body.available,
      ok: body.instances.filter((i) => i.ok).length,
    },
  );
  return c.json(body);
});

router.post("/admin/system/generation", async (c) => {
  requireAdmin(c);
  const body = AcceptGenerationBody.parse(await jsonBody(c));
  if (body.confirm && !body.checklist) {
    throw new AppError("validation", "Tick every item of the checklist first.", { reason: "checklist" });
  }
  return c.json(await actions.acceptGeneration(c, body.reason, body.confirm === true));
});

router.post("/admin/system/destroy-pause", async (c) => {
  const admin = requireAdmin(c);
  const body = DestroyPauseBody.parse(await jsonBody(c));
  return c.json(await actions.setDestroyPause(c, admin, body.on, body.reason, body.confirm === true));
});

/** Why a guarded job's `done: false` pass is a STOP, not "not done yet" — or null. */
async function stoppedBecause(c: C): Promise<"destroy_paused" | "rolled_back" | null> {
  if ((await readPauseSwitch(c.env)) !== "off") return "destroy_paused";
  return (await readsRolledBack(c.env, db(c))) ? "rolled_back" : null;
}

/**
 * Run a scheduled job on demand — the only way on a deployed Worker. `:name` must be one of T14's
 * registry names. ONE bounded pass, awaited inside the request (work left to `waitUntil` would be
 * cut off 30 s after the response): `200 { name, done: true }` or `202 { name, done: false }`, and
 * the caller calls again until done. A GUARDED job stopped by the rollback detector or the pause
 * switch is not "not done yet": `409 conflict` with `details.reason` `rolled_back` /
 * `destroy_paused`, and the caller stops. A streamed job (`backup`) answers `application/x-ndjson`:
 * one line per new progress record its pass writes, the last line `{ name, done }`.
 */
router.post("/admin/jobs/:name{[a-z-]+}/run", async (c) => {
  requireAdmin(c);
  const name = c.req.param("name");
  if (!jobNames.includes(name)) throw new AppError("not_found");
  const job = jobs.find((candidate) => candidate.name === name)!;
  audit(c, "admin.job_run", { type: "job", id: name }, { name });
  if (STREAMED_JOBS.has(name)) return streamedRun(c, name);

  const result = await runBackground(c.env, c.executionCtx, (bg) =>
    runJob(name, bg, { softDeadlineMs: RUN_NOW_SOFT_DEADLINE_MS }),
  );
  if (result.done) return c.json({ name, done: true }, 200);
  if (job.guarded) {
    const reason = await stoppedBecause(c);
    if (reason) {
      throw new AppError(
        "conflict",
        reason === "destroy_paused"
          ? "The job is stopped: the pause switch is on."
          : "The job is stopped: the database reads as rolled back.",
        { reason },
      );
    }
  }
  return c.json({ name, done: false }, 202);
});

/** The streamed pass: progress lines from the run's `_progress/` records, then `{ name, done }`. */
function streamedRun(c: C, name: string): Response {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const line = (value: unknown) => writer.write(encoder.encode(`${JSON.stringify(value)}\n`));
  const store = storage(c.env);
  // The backup's date is the UTC day of its pass: the day the call started and — for a pass that
  // crosses midnight — the day it is now. Only the CURRENT attempt's records are progress
  // (Addendum 1, 19:05: `b/db/<date>/_attempt.json` names it; each record carries its id) — a
  // retried pass must not echo the steps of the attempt before it.
  const startDay = now(c).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const attemptOf = async (key: string): Promise<string | null> => {
    const found = await store.get(key);
    if (!found || found.kind !== "body") return null;
    const value = JSON.parse(await found.object.text()) as { attempt?: unknown };
    return typeof value.attempt === "string" ? value.attempt : null;
  };
  // `echo: false` (once, before the run) only records what is already there: a call that finds
  // the set complete, or another pass running, did not write those records.
  const report = async (echo = true) => {
    for (const day of new Set([startDay, new Date().toISOString().slice(0, 10)])) {
      try {
        const current = await attemptOf(`b/db/${day}/_attempt.json`);
        if (current === null) continue;
        const prefix = `b/db/${day}/_progress/`;
        let cursor: string | undefined;
        do {
          const page = await store.list(prefix, cursor);
          for (const object of page.objects) {
            // Keyed by attempt too: a new attempt rewrites the same `_progress/<table>.json` keys.
            const mark = `${current} ${object.key}`;
            if (seen.has(mark)) continue;
            if ((await attemptOf(object.key)) !== current) continue;
            seen.add(mark);
            if (echo) await line({ progress: object.key.slice(prefix.length) });
          }
          cursor = page.cursor ?? undefined;
        } while (cursor);
      } catch {
        // A listing (or a record) that cannot be read keeps nothing from finishing: the next look
        // tries again.
      }
    }
  };
  const work = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = true;
    const tick = async () => {
      if (!running) return;
      await report();
      if (running) timer = setTimeout(tick, PROGRESS_POLL_MS);
    };
    await report(false);
    timer = setTimeout(tick, PROGRESS_POLL_MS);
    try {
      const result = await runBackground(c.env, c.executionCtx, (bg) =>
        runJob(name, bg, { softDeadlineMs: Math.min(softDeadlineOf(name), STREAMED_MAX_MS) }),
      );
      running = false;
      clearTimeout(timer);
      await report();
      await line({ name, done: result.done });
    } catch {
      running = false;
      clearTimeout(timer);
      await line({ name, done: false, error: "internal" });
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  void work;
  return new Response(stream.readable, {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
