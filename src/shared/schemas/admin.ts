// The admin console. Everything here is answered only to an admin whose session passed a second
// factor; none of it reaches another contract.

import { z } from "zod";
import { CEILING_KEYS } from "../constants";
import { Bytes, Email, NodeId, Page, RowId, Sha256, Timestamp, UserId, UserRef } from "./common";
import { NodeDto, NodeKind } from "./node";
import { ReportCategory } from "./report";

/** The database's status, including the one no other contract ever shows. */
export const AdminScanStatus = z.enum([
  "pending",
  "clean",
  "infected",
  "suspected_csam",
  "under_review",
  "skipped",
  "error",
]);
export type AdminScanStatus = z.infer<typeof AdminScanStatus>;

export const TakedownReason = z.enum(["dmca", "abuse", "csam", "admin"]);
export type TakedownReason = z.infer<typeof TakedownReason>;

/**
 * A node as the console sees it: metadata only. The console never mints a content URL for a
 * `suspected_csam` node.
 */
export const AdminNodeDto = NodeDto.extend({
  scanStatus: AdminScanStatus,
  takedown: z.object({ at: Timestamp, reason: TakedownReason }).nullable(),
  legalHold: z.boolean(),
});
export type AdminNodeDto = z.infer<typeof AdminNodeDto>;

// ── users ───────────────────────────────────────────────────────────────────────────────────

export const AdminUserDto = z.object({
  id: UserId,
  email: z.string(),
  displayName: z.string(),
  role: z.enum(["user", "admin"]),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  createdAt: Timestamp,
  quotaBytes: Bytes,
  usedBytes: Bytes,
  banned: z.boolean(),
  banReason: z.string().nullable(),
  suspendedAt: Timestamp.nullable(),
  suspendedReason: z.string().nullable(),
  deleteScheduledAt: Timestamp.nullable(),
  legalHold: z.boolean(),
  activeStrikes: z.number().int().nonnegative(),
  lastActiveAt: Timestamp.nullable(),
});
export type AdminUserDto = z.infer<typeof AdminUserDto>;

export const AdminUserListQuery = z.strictObject({
  q: z.string().min(1).max(254).optional(),
  state: z.enum(["active", "suspended", "banned", "deletion", "held"]).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminUserListQuery = z.infer<typeof AdminUserListQuery>;

export const AdminUserPage = Page(AdminUserDto);
export type AdminUserPage = z.infer<typeof AdminUserPage>;

export const SuspendUserBody = z.strictObject({ reason: z.string().min(1).max(500) });
export type SuspendUserBody = z.infer<typeof SuspendUserBody>;

export const SetQuotaBody = z.strictObject({ quotaBytes: Bytes });
export type SetQuotaBody = z.infer<typeof SetQuotaBody>;

export const SetLegalHoldBody = z.strictObject({ held: z.boolean(), note: z.string().max(500).optional() });
export type SetLegalHoldBody = z.infer<typeof SetLegalHoldBody>;

// ── strikes ─────────────────────────────────────────────────────────────────────────────────

export const StrikeKind = z.enum(["dmca", "malware", "abuse"]);
export type StrikeKind = z.infer<typeof StrikeKind>;

export const StrikeDto = z.object({
  id: RowId,
  userId: UserId,
  kind: StrikeKind,
  reportId: RowId.nullable(),
  nodeId: NodeId.nullable(),
  contentSha256: Sha256.nullable(),
  issuedBy: UserId.nullable(),
  at: Timestamp,
  note: z.string().nullable(),
  liftedAt: Timestamp.nullable(),
  liftedBy: UserId.nullable(),
});
export type StrikeDto = z.infer<typeof StrikeDto>;

export const AddStrikeBody = z.strictObject({
  userId: UserId,
  kind: StrikeKind,
  nodeId: NodeId.optional(),
  reportId: RowId.optional(),
  note: z.string().max(500).optional(),
});
export type AddStrikeBody = z.infer<typeof AddStrikeBody>;

// ── quarantine ──────────────────────────────────────────────────────────────────────────────

export const QuarantineItemDto = z.object({
  node: AdminNodeDto,
  uploader: UserRef.nullable(),
  signatures: z.array(z.string()),
  scannedAt: Timestamp.nullable(),
});
export type QuarantineItemDto = z.infer<typeof QuarantineItemDto>;

export const QuarantinePage = Page(QuarantineItemDto);
export type QuarantinePage = z.infer<typeof QuarantinePage>;

export const QuarantineActionBody = z.strictObject({
  /**
   * `takedown` / `restore` (R1 ruling Q9) work on ANY file or folder, not only a quarantine member:
   * the console's own takedown (reason `admin`, or `csam` for a folder) and the restore of a
   * takedown that is not a copyright notice's.
   */
  action: z.enum(["release", "delete", "rescan", "takedown", "restore"]),
  note: z.string().max(500).optional(),
  /** `takedown` of a FOLDER as suspected CSAM: also holds it, and so everything under it. */
  csam: z.boolean().optional(),
});
export type QuarantineActionBody = z.infer<typeof QuarantineActionBody>;

/** What a rescan asked for from the console did. */
export const AdminRescanResponse = z.union([
  z.object({ queued: z.literal(true) }),
  z.object({ queued: z.literal(false), reason: z.enum(["taken_down", "locked"]) }),
]);
export type AdminRescanResponse = z.infer<typeof AdminRescanResponse>;

// ── reports ─────────────────────────────────────────────────────────────────────────────────

export const ReportStatus = z.enum(["open", "reviewing", "actioned", "dismissed"]);
export type ReportStatus = z.infer<typeof ReportStatus>;

/** `reporterEmail` is shown to the admin who handles the report, and to nobody else. */
export const ReportDto = z.object({
  id: RowId,
  nodeId: NodeId.nullable(),
  linkId: RowId.nullable(),
  ownerId: UserId.nullable(),
  category: ReportCategory,
  source: z.enum(["user", "system", "admin", "photodna"]),
  reporterEmail: z.string().nullable(),
  reporterUserId: UserId.nullable(),
  details: z.string().nullable(),
  status: ReportStatus,
  assignedTo: UserId.nullable(),
  resolution: z.string().nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  ncmecStartedAt: Timestamp.nullable(),
  ncmecFiledAt: Timestamp.nullable(),
  ncmecReportId: z.string().nullable(),
  node: AdminNodeDto.nullable(),
});
export type ReportDto = z.infer<typeof ReportDto>;

export const ReportListQuery = z.strictObject({
  status: ReportStatus.optional(),
  category: ReportCategory.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReportListQuery = z.infer<typeof ReportListQuery>;

export const ReportPage = Page(ReportDto);
export type ReportPage = z.infer<typeof ReportPage>;

export const ReportActionBody = z.strictObject({
  action: z.enum(["dismiss", "takedown", "strike", "escalate_csam"]),
  resolution: z.string().max(2000).optional(),
});
export type ReportActionBody = z.infer<typeof ReportActionBody>;

/** `POST /api/admin/reports/:id/ncmec/filed`. `reportId` is the reporting body's own id. */
export const NcmecFiledBody = z.strictObject({ reportId: z.string().min(1).max(64), filedAt: Timestamp });
export type NcmecFiledBody = z.infer<typeof NcmecFiledBody>;

// ── copyright notices ───────────────────────────────────────────────────────────────────────

export const DmcaStatus = z.enum([
  "received",
  "incomplete",
  "rejected",
  "actioned",
  "counter_received",
  "restored",
  "upheld",
  "withdrawn",
  "closed",
]);
export type DmcaStatus = z.infer<typeof DmcaStatus>;

const text = () => z.string().nullable();

/** The `dmca_notices` row, column for column, with the nodes it names. */
export const DmcaNoticeDto = z.object({
  id: RowId,
  receivedAt: Timestamp,
  receivedVia: z.enum(["email", "form", "post"]),
  complainantName: text(),
  complainantOrg: text(),
  complainantAddress: text(),
  complainantPhone: text(),
  complainantEmail: text(),
  workDescription: text(),
  infringingDescription: text(),
  statementGoodFaith: z.boolean(),
  statementAccuracy: z.boolean(),
  signature: text(),
  rawText: text(),
  checklist: z.record(z.string(), z.unknown()).nullable(),
  status: DmcaStatus,
  handledBy: UserId.nullable(),
  takedownAt: Timestamp.nullable(),
  ownerNotifiedAt: Timestamp.nullable(),
  strikeId: RowId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  counterReceivedAt: Timestamp.nullable(),
  counterName: text(),
  counterAddress: text(),
  counterPhone: text(),
  counterEmail: text(),
  counterStatement: text(),
  counterConsentJurisdiction: z.boolean().nullable(),
  counterSignature: text(),
  counterForwardedAt: Timestamp.nullable(),
  restoreNotBefore: Timestamp.nullable(),
  restoreNotAfter: Timestamp.nullable(),
  lawsuitNoticeAt: Timestamp.nullable(),
  restoredAt: Timestamp.nullable(),
  restoredBy: UserId.nullable(),
  /** `tookDown`: THIS notice's takedown took the node down (only such a node is its restore's to lift). */
  nodes: z.array(z.object({ nodeId: NodeId, nodeName: text(), sha256: text(), tookDown: z.boolean() })),
});
export type DmcaNoticeDto = z.infer<typeof DmcaNoticeDto>;

export const DmcaNoticePage = Page(DmcaNoticeDto);
export type DmcaNoticePage = z.infer<typeof DmcaNoticePage>;

const longText = z.string().max(20_000);

/** A notice as it is entered: the claim's elements, and the nodes it names. */
export const CreateDmcaNoticeBody = z.strictObject({
  receivedVia: z.enum(["email", "form", "post"]),
  receivedAt: Timestamp.optional(),
  complainantName: z.string().max(500).optional(),
  complainantOrg: z.string().max(500).optional(),
  complainantAddress: z.string().max(2000).optional(),
  complainantPhone: z.string().max(100).optional(),
  complainantEmail: Email.optional(),
  workDescription: longText.optional(),
  infringingDescription: longText.optional(),
  statementGoodFaith: z.boolean(),
  statementAccuracy: z.boolean(),
  signature: z.string().max(500).optional(),
  rawText: z.string().max(200_000).optional(),
  nodeIds: z.array(NodeId).max(500),
});
export type CreateDmcaNoticeBody = z.infer<typeof CreateDmcaNoticeBody>;

export const DmcaActionBody = z.strictObject({
  action: z.enum([
    "mark_incomplete",
    "reject",
    "takedown",
    "forward_counter",
    "lawsuit_notice",
    "restore",
    "uphold",
    "withdraw",
    "close",
  ]),
  checklist: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(2000).optional(),
  /** `restore` after `restoreNotAfter`: the operator's explicit "past the 14-business-day window". */
  acknowledgeLate: z.boolean().optional(),
});
export type DmcaActionBody = z.infer<typeof DmcaActionBody>;

export const CounterNoticeBody = z.strictObject({
  counterName: z.string().min(1).max(500),
  counterAddress: z.string().min(1).max(2000),
  counterPhone: z.string().max(100).optional(),
  counterEmail: Email,
  counterStatement: longText,
  counterConsentJurisdiction: z.boolean(),
  counterSignature: z.string().min(1).max(500),
  counterReceivedAt: Timestamp.optional(),
});
export type CounterNoticeBody = z.infer<typeof CounterNoticeBody>;

// ── links ───────────────────────────────────────────────────────────────────────────────────

/** A link as the console sees it: the STORED pause reasons, and never its URL or token. */
export const AdminLinkDto = z.object({
  id: RowId,
  nodeId: NodeId,
  node: z.object({ name: z.string(), kind: NodeKind }),
  ownerId: UserId,
  pauseReasons: z.array(
    z.enum(["ceiling", "anomaly", "owner", "owner_deletion", "owner_suspended", "report", "moderation"]),
  ),
  pausedAt: Timestamp.nullable(),
  lockedByAdmin: z.boolean(),
  revokedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  hasPassword: z.boolean(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: z.number().int().nonnegative(),
  bytesServed: Bytes,
  createdAt: Timestamp,
  lastAccessAt: Timestamp.nullable(),
});
export type AdminLinkDto = z.infer<typeof AdminLinkDto>;

export const AdminLinkPage = Page(AdminLinkDto);
export type AdminLinkPage = z.infer<typeof AdminLinkPage>;

export const AdminLinkActionBody = z.strictObject({ action: z.enum(["lock", "unlock", "revoke"]) });
export type AdminLinkActionBody = z.infer<typeof AdminLinkActionBody>;

// ── invites ─────────────────────────────────────────────────────────────────────────────────

export const InviteDto = z.object({
  code: z.string(),
  createdBy: UserId.nullable(),
  maxUses: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  note: z.string().nullable(),
  createdAt: Timestamp,
});
export type InviteDto = z.infer<typeof InviteDto>;

export const InvitePage = Page(InviteDto);
export type InvitePage = z.infer<typeof InvitePage>;

export const CreateInvitesBody = z.strictObject({
  count: z.number().int().min(1).max(100),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresAt: Timestamp.optional(),
  note: z.string().max(200).optional(),
});
export type CreateInvitesBody = z.infer<typeof CreateInvitesBody>;

// ── audit ───────────────────────────────────────────────────────────────────────────────────

/** No address and no address hash. `ua` is a browser family ("Chrome"), never a raw header. */
export const AuditEntryDto = z.object({
  id: RowId,
  at: Timestamp,
  actorUserId: UserId.nullable(),
  actorType: z.enum(["user", "admin", "system", "link"]),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ua: z.string().nullable(),
  country: z.string().nullable(),
  requestId: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

export const AuditQuery = z.strictObject({
  actorUserId: UserId.optional(),
  action: z.string().min(1).max(100).optional(),
  targetType: z.string().min(1).max(50).optional(),
  targetId: z.string().min(1).max(64).optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditPage = Page(AuditEntryDto);
export type AuditPage = z.infer<typeof AuditPage>;

// ── settings ────────────────────────────────────────────────────────────────────────────────

// A limit the ledger can count: a whole number, at most the largest a number holds exactly. (An
// override above that would make every request of its kind fail as invalid instead of being refused.)
const limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
// The one override that is not a count: the share of a limit a new account gets.
const factor = z.number().min(0).max(1).optional();

/**
 * Overrides of the daily limits: exactly the keys of `CEILING_KEYS`, each optional. Every one is
 * a non-negative safe INTEGER — except `NEW_ACCOUNT_FACTOR`, a number from 0 to 1. Any other key
 * is a validation error.
 */
export const CeilingOverrides = z.strictObject(
  Object.fromEntries(
    CEILING_KEYS.map((key) => [key, key === "NEW_ACCOUNT_FACTOR" ? factor : limit]),
  ) as Record<(typeof CEILING_KEYS)[number], typeof limit>,
);
export type CeilingOverrides = z.infer<typeof CeilingOverrides>;

/** The runtime settings an admin can see and change. Internal keys are not part of it. */
export const SettingsDto = z.object({
  signupMode: z.enum(["invite", "open"]),
  uploadsEnabled: z.boolean(),
  linksEnabled: z.boolean(),
  readOnly: z.boolean(),
  demoMode: z.boolean(),
  orphanDeleteEnabled: z.boolean(),
  ceilings: CeilingOverrides,
  termsVersion: z.string().min(1).max(64),
});
export type SettingsDto = z.infer<typeof SettingsDto>;

export const PatchSettingsBody = z.strictObject({
  signupMode: z.enum(["invite", "open"]).optional(),
  uploadsEnabled: z.boolean().optional(),
  linksEnabled: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  demoMode: z.boolean().optional(),
  orphanDeleteEnabled: z.boolean().optional(),
  ceilings: CeilingOverrides.optional(),
  termsVersion: z.string().min(1).max(64).optional(),
});
export type PatchSettingsBody = z.infer<typeof PatchSettingsBody>;

// ── jobs ────────────────────────────────────────────────────────────────────────────────────

/** `POST /api/admin/jobs/:name/run`: `200` with `done: true`, `202` with `done: false`. */
export const JobRunResponse = z.object({ done: z.boolean() });
export type JobRunResponse = z.infer<typeof JobRunResponse>;

// ── additions for the console's actions (T25, R-c: new exports only) ────────────────────────
// Every action below that changes something takes a typed `reason` (audited). A two-step action
// is called once without `confirm` — it changes nothing and answers the preview — and once more
// with `confirm: true` and the same reason; the second call decides again from the rows.

const Reason = z.string().trim().min(1).max(2000);

/** The body of an action whose only input is the reason it is taken for. */
export const AdminReasonBody = z.strictObject({ reason: Reason });
export type AdminReasonBody = z.infer<typeof AdminReasonBody>;

/** A two-step action's body. */
export const TwoStepBody = z.strictObject({ reason: Reason, confirm: z.literal(true).optional() });
export type TwoStepBody = z.infer<typeof TwoStepBody>;

// ── dashboard ────────────────────────────────────────────────────────────────────────────

/** Analytics Engine tiles: `{ available: false }` until the metrics queries exist (T27). */
export const AnalyticsTilesDto = z.union([
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    requestsPerMinute: z.number().nonnegative(),
    errorRate: z.number().min(0).max(1),
    p95LatencyMs: z.number().nonnegative(),
  }),
]);
export type AnalyticsTilesDto = z.infer<typeof AnalyticsTilesDto>;

export const PauseReason = z.enum([
  "ceiling",
  "anomaly",
  "owner",
  "owner_deletion",
  "owner_suspended",
  "report",
  "moderation",
]);
export type PauseReason = z.infer<typeof PauseReason>;

/** The operator's pause switch as read: `unreadable` counts as on. */
export const PauseSwitchState = z.enum(["on", "off", "unreadable"]);
export type PauseSwitchState = z.infer<typeof PauseSwitchState>;

export const AdminDashboardDto = z.object({
  users: z.object({ total: z.number().int().nonnegative(), new7d: z.number().int().nonnegative() }),
  storageBytes: Bytes,
  uploads24h: z.number().int().nonnegative(),
  downloads24h: z.object({ count: z.number().int().nonnegative(), bytes: Bytes }),
  scans24h: z.record(z.string(), z.number().int().nonnegative()),
  scanBacklog: z.object({ running: z.number().int().nonnegative(), oldestStartedAt: Timestamp.nullable() }),
  nodesInError: z.number().int().nonnegative(),
  reports: z.object({ open: z.number().int().nonnegative(), oldestOpenAt: Timestamp.nullable() }),
  strikes7d: z.number().int().nonnegative(),
  linksPaused: z.record(z.string(), z.number().int().nonnegative()),
  pauseSwitch: PauseSwitchState,
  analytics: AnalyticsTilesDto,
});
export type AdminDashboardDto = z.infer<typeof AdminDashboardDto>;

// ── users ────────────────────────────────────────────────────────────────────────────────

/** How the strike list shows a strike (an expired form offers no Lift). */
export const StrikeState = z.enum(["active", "lifted", "lifted_expired", "lifted_by_system", "expired"]);
export type StrikeState = z.infer<typeof StrikeState>;

export const AdminStrikeDto = StrikeDto.extend({ state: StrikeState });
export type AdminStrikeDto = z.infer<typeof AdminStrikeDto>;

export const AdminUserDetailDto = z.object({
  user: AdminUserDto,
  /** The `link_owner` ledger today against the effective `CEIL_OWNER_LINK_BYTES_DAY` (decimal bytes). */
  linkEgressToday: z.object({ bytes: Bytes, count: z.number().int().nonnegative(), capBytes: Bytes }),
  /** The TRUE counter (`user.used_bytes`) and the operator's breakdown — never the holder's figure. */
  usage: z.object({
    usedBytes: Bytes,
    filesBytes: Bytes,
    trashBytes: Bytes,
    versionsBytes: Bytes,
    reservedBytes: Bytes,
    /** Deleted for good by the holder but kept (held): still counted. */
    keptDeletedBytes: Bytes,
    keptBackstopReached: z.boolean(),
  }),
  strikes: z.array(AdminStrikeDto),
  sessions: z.number().int().nonnegative(),
  links: z.object({ live: z.number().int().nonnegative(), paused: z.number().int().nonnegative() }),
  shares: z.number().int().nonnegative(),
  /** The newest `admin.legal_hold_set` / `_cleared` row says set: the hold is a hand-set one. */
  legalHoldByHand: z.boolean(),
});
export type AdminUserDetailDto = z.infer<typeof AdminUserDetailDto>;

export const AddStrikeResponse = z.object({ strike: AdminStrikeDto, created: z.boolean() });
export type AddStrikeResponse = z.infer<typeof AddStrikeResponse>;

export const LiftStrikeResponse = z.object({ activeStrikes: z.number().int().nonnegative() });
export type LiftStrikeResponse = z.infer<typeof LiftStrikeResponse>;

export const RevokeCountResponse = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeCountResponse = z.infer<typeof RevokeCountResponse>;

export const DeletionResponse = z.object({ scheduledFor: Timestamp.nullable(), changed: z.boolean() });
export type DeletionResponse = z.infer<typeof DeletionResponse>;

// ── settings ─────────────────────────────────────────────────────────────────────────────

export const AdminSettingsResponse = z.object({
  settings: SettingsDto,
  /** Each ceiling key's default (from the vars) — the form shows default and effective value. */
  ceilingDefaults: z.record(z.string(), z.number()),
  /** Accounts that would be asked to accept the terms again after a version bump. */
  termsAccounts: z.number().int().nonnegative(),
});
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponse>;

// ── quarantine ───────────────────────────────────────────────────────────────────────────

export const QuarantineQuery = z.strictObject({
  status: z.enum(["infected", "suspected_csam", "under_review", "error", "skipped", "taken_down"]).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type QuarantineQuery = z.infer<typeof QuarantineQuery>;

/** Why a node cannot be deleted from here (or anywhere): `assertPurgeable`'s causes, by name. */
export const HoldCause = z.enum([
  "node_legal_hold",
  "owner_legal_hold",
  "suspected_csam",
  "under_review",
  "open_notice",
  "inherited_legal_hold",
  "inherited_open_notice",
]);
export type HoldCause = z.infer<typeof HoldCause>;

export const AdminQuarantineDetailDto = z.object({
  item: QuarantineItemDto,
  owner: UserRef,
  scanReason: z.string().nullable(),
  scanDetail: z.record(z.string(), z.unknown()).nullable(),
  /** The scanner's hash once it has one (null while `pending`). */
  sha256: Sha256.nullable(),
  holds: z.array(HoldCause),
  links: z.array(AdminLinkDto),
  /** The uploader's unlifted malware strike for this file, when one exists (offered for lifting). */
  malwareStrikeId: RowId.nullable(),
});
export type AdminQuarantineDetailDto = z.infer<typeof AdminQuarantineDetailDto>;

export const QuarantineActionResponse = z.object({
  node: AdminNodeDto.nullable(),
  /** `release`: whether the blocklist entry this node added was removed. */
  blocklistRemoved: z.boolean().optional(),
  /** `release`: the uploader's malware strike for this file, to offer `liftStrike`. */
  malwareStrikeId: RowId.nullable().optional(),
  /** `rescan`: what the rescan did. */
  rescan: AdminRescanResponse.optional(),
  /** `delete`: the subtree is gone. */
  purged: z.boolean().optional(),
  /**
   * `restore`: the unlifted strikes report actions gave the current uploader for this node —
   * offered for lifting (`liftStrike`), never lifted by the restore.
   */
  reportStrikeIds: z.array(RowId).optional(),
});
export type QuarantineActionResponse = z.infer<typeof QuarantineActionResponse>;

// ── reports ──────────────────────────────────────────────────────────────────────────────

/** `ReportListQuery` and the two filters it lacks: the source, and an age. */
export const AdminReportListQuery = z.strictObject({
  status: ReportStatus.optional(),
  category: ReportCategory.optional(),
  source: z.enum(["user", "system", "admin", "photodna"]).optional(),
  olderThanHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 365)
    .optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminReportListQuery = z.infer<typeof AdminReportListQuery>;

export const ReportAssignBody = z.strictObject({ assignToMe: z.boolean() });
export type ReportAssignBody = z.infer<typeof ReportAssignBody>;

/** A `scan.csam_alert_sent` row: when operators were told, how, and how many (never an address). */
export const CsamAlertDto = z.object({
  at: Timestamp,
  via: z.string().nullable(),
  recipients: z.number().int(),
});
export type CsamAlertDto = z.infer<typeof CsamAlertDto>;

export const ReportDetailDto = z.object({
  report: ReportDto,
  /** Open or reviewing reports on the node, and from how many distinct reporters. */
  openOnNode: z.number().int().nonnegative(),
  distinctReporters: z.number().int().nonnegative(),
  uploader: z
    .object({
      id: UserId,
      displayName: z.string(),
      createdAt: Timestamp,
      strikes: z.array(AdminStrikeDto),
    })
    .nullable(),
  links: z.object({
    count: z.number().int().nonnegative(),
    downloads: z.number().int().nonnegative(),
    bytesServed: Bytes,
    lastAccessAt: Timestamp.nullable(),
  }),
  /** The `scan.suspected_csam` row: when, and its real source. Null when the node was never locked. */
  locked: z.object({ at: Timestamp, source: z.string().nullable() }).nullable(),
  alerts: z.array(CsamAlertDto),
  /** The node is a folder (a lock is refused for it). */
  nodeIsFolder: z.boolean(),
  /** For a `csam` report: the earliest release date once filed (`ncmecFiledAt` + 1 year). */
  releasableAt: Timestamp.nullable(),
});
export type ReportDetailDto = z.infer<typeof ReportDetailDto>;

export const ReportActionResponse = z.object({
  report: ReportDto,
  /** An escalation: the `csam` report the case now runs on (the same id for a `csam` report). */
  csamReportId: RowId.nullable(),
});
export type ReportActionResponse = z.infer<typeof ReportActionResponse>;

// ── the NCMEC procedure ──────────────────────────────────────────────────────────────────

export const EvidenceAddressDto = z.object({
  uploadIpRowId: RowId,
  versionId: z.string(),
  at: Timestamp,
  /** The decrypted address; null with `error` when the row cannot be opened. */
  ip: z.string().nullable(),
  error: z.literal("undecryptable").optional(),
});
export type EvidenceAddressDto = z.infer<typeof EvidenceAddressDto>;

export const EvidenceSubjectDto = z.object({
  userId: UserId,
  isOwner: z.boolean(),
  uploadedVersionIds: z.array(z.string()),
  isCurrentVersionUploader: z.boolean(),
  held: z.boolean(),
  account: z.object({
    email: z.string(),
    name: z.string(),
    createdAt: Timestamp,
    signInCountries: z.array(z.string()),
  }),
  addresses: z.array(EvidenceAddressDto),
});
export type EvidenceSubjectDto = z.infer<typeof EvidenceSubjectDto>;

/** `POST /api/admin/reports/:id/ncmec/evidence`. Answered `Cache-Control: no-store`. */
export const NcmecEvidenceResponse = z.object({
  reportId: RowId,
  node: z.object({
    id: NodeId,
    name: z.string(),
    mimeSniffed: z.string().nullable(),
    size: Bytes,
    sha256: z.string().nullable(),
    uploadedAt: Timestamp,
    versions: z.array(z.object({ versionId: z.string(), at: Timestamp, current: z.boolean() })),
  }),
  links: z.object({
    count: z.number().int().nonnegative(),
    downloads: z.number().int().nonnegative(),
    bytesServed: Bytes,
    lastAccessAt: Timestamp.nullable(),
    everPublic: z.boolean(),
  }),
  subjects: z.array(EvidenceSubjectDto),
  /** `deleted`: the current version's uploader has no account any more (no subject is marked). */
  currentVersionUploader: z.enum(["present", "deleted"]),
  orphanAddresses: z.array(EvidenceAddressDto.extend({ uploaderId: z.string() })),
});
export type NcmecEvidenceResponse = z.infer<typeof NcmecEvidenceResponse>;

export const ReleaseHoldsResponse = z.object({
  confirmed: z.boolean(),
  node: z.object({ released: z.boolean(), keptBecause: z.string().nullable() }),
  releasedUserIds: z.array(UserId),
  kept: z.array(
    z.object({ userId: UserId, because: z.enum(["other_csam_report", "other_locked_node", "set_by_hand"]) }),
  ),
  uploadIpsReleased: z.number().int().nonnegative(),
  /** True when nothing was held any more (a second confirmed call). */
  nothingToRelease: z.boolean(),
});
export type ReleaseHoldsResponse = z.infer<typeof ReleaseHoldsResponse>;

/** `moderation.clearSuspectedCsam`'s result, as the console shows it. */
export const CsamClearResultDto = z.object({
  cleared: z.boolean(),
  refused: z.enum(["not_locked", "reported"]).nullable(),
  blocklistRemoved: z.boolean(),
  blocklistRestoredTo: z.enum(["malware", "csam", "dmca", "admin"]).nullable(),
  blocklistKept: z
    .enum(["confirmed", "not_this_locks", "other_node_locked", "reported", "edited"])
    .nullable(),
  reportIds: z.array(RowId),
});
export type CsamClearResultDto = z.infer<typeof CsamClearResultDto>;

export const ClearLockResponse = z.object({
  confirmed: z.boolean(),
  /** The confirmed call's result; null on the preview. */
  result: CsamClearResultDto.nullable(),
  /** The node's status as the row has it after the call. */
  nodeStatus: AdminScanStatus.nullable(),
});
export type ClearLockResponse = z.infer<typeof ClearLockResponse>;

/** "Find, then lock as suspected CSAM": a node id, an R2 object key, or a files-host URL/path. */
export const LockCsamBody = z.strictObject({
  reference: z.string().trim().min(1).max(2048),
  reason: Reason,
  confirm: z.literal(true).optional(),
});
export type LockCsamBody = z.infer<typeof LockCsamBody>;

export const LockCsamResponse = z.object({
  confirmed: z.boolean(),
  referenceKind: z.enum(["node_id", "object_key", "files_url"]),
  match: z.object({
    nodeId: NodeId,
    name: z.string(),
    mimeSniffed: z.string().nullable(),
    size: Bytes,
    sha256: z.string().nullable(),
    owner: UserRef,
    uploaders: z.array(z.object({ versionId: z.string(), uploader: UserRef.nullable() })),
    scanStatus: AdminScanStatus,
  }),
  /** The case the lock filed or found (the confirmed call only). */
  reportId: RowId.nullable(),
});
export type LockCsamResponse = z.infer<typeof LockCsamResponse>;

/** An upload kept under "keep and alert": the server proved csam, the hash is no longer listed. */
export const KeptUploadDto = z.object({
  uploadId: RowId,
  ownerId: UserId,
  uploaderId: UserId.nullable(),
  name: z.string(),
  size: Bytes,
  sha256: z.string().nullable(),
  /** The hash's blocklist reason now (null: not listed — the keep-and-alert case). */
  listedAs: z.enum(["malware", "csam", "dmca", "admin"]).nullable(),
  owedAt: Timestamp,
  createdAt: Timestamp,
});
export type KeptUploadDto = z.infer<typeof KeptUploadDto>;

export const KeptUploadPage = Page(KeptUploadDto);
export type KeptUploadPage = z.infer<typeof KeptUploadPage>;

export const ResolveKeptUploadBody = z.strictObject({
  resolution: z.enum(["relist", "false_positive"]),
  reason: Reason,
  confirm: z.literal(true).optional(),
});
export type ResolveKeptUploadBody = z.infer<typeof ResolveKeptUploadBody>;

export const ResolveKeptUploadResponse = z.object({
  confirmed: z.boolean(),
  resolution: z.enum(["relist", "false_positive"]),
  upload: KeptUploadDto,
  /** `false_positive`, confirmed: the session ended and its object deleted. */
  ended: z.boolean(),
});
export type ResolveKeptUploadResponse = z.infer<typeof ResolveKeptUploadResponse>;

// ── copyright notices ────────────────────────────────────────────────────────────────────

export const DmcaListQuery = z.strictObject({
  status: DmcaStatus.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DmcaListQuery = z.infer<typeof DmcaListQuery>;

/** One notice per alleged infringer: a notice naming several uploaders' files is split. */
export const CreateDmcaNoticeResponse = z.object({ notices: z.array(DmcaNoticeDto) });
export type CreateDmcaNoticeResponse = z.infer<typeof CreateDmcaNoticeResponse>;

// ── links ────────────────────────────────────────────────────────────────────────────────

export const AdminLinkListQuery = z.strictObject({
  ownerId: UserId.optional(),
  nodeId: NodeId.optional(),
  paused: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminLinkListQuery = z.infer<typeof AdminLinkListQuery>;

/** Pause a link by hand with `anomaly`, or lift that reason (the only way before 00:05 UTC). */
export const AdminLinkAnomalyBody = z.strictObject({ paused: z.boolean(), reason: Reason });
export type AdminLinkAnomalyBody = z.infer<typeof AdminLinkAnomalyBody>;

// ── invites ──────────────────────────────────────────────────────────────────────────────

export const InviteListQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type InviteListQuery = z.infer<typeof InviteListQuery>;

export const CreateInvitesResponse = z.object({ invites: z.array(InviteDto) });
export type CreateInvitesResponse = z.infer<typeof CreateInvitesResponse>;

// ── audit ────────────────────────────────────────────────────────────────────────────────

/**
 * A page of audit rows, and who each actor id is: an id with no account any more maps to null
 * ("deleted account") — the row is never dropped for it.
 */
export const AdminAuditResponse = z.object({
  items: z.array(AuditEntryDto),
  nextCursor: z.string().nullable(),
  actors: z.record(z.string(), UserRef.nullable()),
});
export type AdminAuditResponse = z.infer<typeof AdminAuditResponse>;

// ── system ───────────────────────────────────────────────────────────────────────────────

/** How the rollback detector reads the two copies of the generation (written nowhere by reading). */
export const DetectorDto = z.object({
  object: z.object({ raw: z.string().nullable(), number: z.number().int().nullable() }),
  database: z.object({ raw: z.string().nullable(), number: z.number().int().nullable() }),
  reading: z.enum(["level", "first", "object_ahead", "object_missing", "anomaly", "unreadable"]),
  pauseSwitch: PauseSwitchState,
  orphanDeleteEnabled: z.boolean(),
});
export type DetectorDto = z.infer<typeof DetectorDto>;

export const AdminSystemDto = z.object({
  build: z.object({ sha: z.string().nullable(), builtAt: z.string().nullable() }),
  database: z.object({ ok: z.boolean() }),
  storage: z.object({ ok: z.boolean() }),
  flags: z.object({ photodnaEnabled: z.boolean(), scanStub: z.boolean() }),
  scannerAvailable: z.boolean(),
  jobs: z.array(
    z.object({ name: z.string(), cron: z.string(), guarded: z.boolean(), streamed: z.boolean() }),
  ),
  detector: DetectorDto,
});
export type AdminSystemDto = z.infer<typeof AdminSystemDto>;

export const ScannerCheckResponse = z.object({
  available: z.boolean(),
  instances: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      ready: z.boolean().nullable(),
      dbVersion: z.string().nullable(),
      dbAgeHours: z.number().nullable(),
      freshclam: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type ScannerCheckResponse = z.infer<typeof ScannerCheckResponse>;

/** S11's checklist, ticked in this order before the generation is levelled. */
export const AcceptGenerationBody = z.strictObject({
  reason: Reason,
  confirm: z.literal(true).optional(),
  checklist: z
    .strictObject({
      pausedAndOrphansOff: z.literal(true),
      reapplied: z.literal(true),
      reconciled: z.literal(true),
    })
    .optional(),
});
export type AcceptGenerationBody = z.infer<typeof AcceptGenerationBody>;

export const AcceptGenerationResponse = z.object({
  confirmed: z.boolean(),
  /** What the confirm would do / did: move the database's number, or rewrite the object. */
  action: z.enum(["advance_database", "rewrite_object", "none"]),
  before: z.object({ object: z.string().nullable(), database: z.string().nullable() }),
  after: z.object({ object: z.string().nullable(), database: z.string().nullable() }).nullable(),
  detector: DetectorDto,
});
export type AcceptGenerationResponse = z.infer<typeof AcceptGenerationResponse>;

export const DestroyPauseBody = z.strictObject({
  on: z.boolean(),
  reason: Reason,
  confirm: z.literal(true).optional(),
});
export type DestroyPauseBody = z.infer<typeof DestroyPauseBody>;

export const DestroyPauseResponse = z.object({
  confirmed: z.boolean(),
  before: PauseSwitchState,
  after: PauseSwitchState,
  changed: z.boolean(),
});
export type DestroyPauseResponse = z.infer<typeof DestroyPauseResponse>;
