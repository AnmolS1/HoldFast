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
  action: z.enum(["release", "delete", "rescan"]),
  note: z.string().max(500).optional(),
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
  nodes: z.array(z.object({ nodeId: NodeId, nodeName: text(), sha256: text() })),
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

const limit = z.number().finite().nonnegative().optional();

/**
 * Overrides of the daily limits: exactly the keys of `CEILING_KEYS`, each optional, each a
 * non-negative number. Any other key is a validation error.
 */
export const CeilingOverrides = z.strictObject(
  Object.fromEntries(CEILING_KEYS.map((key) => [key, limit])) as Record<
    (typeof CEILING_KEYS)[number],
    typeof limit
  >,
);
export type CeilingOverrides = z.infer<typeof CeilingOverrides>;

/** The runtime settings an admin can see and change. Internal keys are not part of it. */
export const SettingsDto = z.object({
  signupMode: z.enum(["invite", "open"]),
  uploadsEnabled: z.boolean(),
  linksEnabled: z.boolean(),
  readOnly: z.boolean(),
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
  orphanDeleteEnabled: z.boolean().optional(),
  ceilings: CeilingOverrides.optional(),
  termsVersion: z.string().min(1).max(64).optional(),
});
export type PatchSettingsBody = z.infer<typeof PatchSettingsBody>;

// ── jobs ────────────────────────────────────────────────────────────────────────────────────

/** `POST /api/admin/jobs/:name/run`: `200` with `done: true`, `202` with `done: false`. */
export const JobRunResponse = z.object({ done: z.boolean() });
export type JobRunResponse = z.infer<typeof JobRunResponse>;
