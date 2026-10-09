// The complete v1 schema. Later tasks add no migrations: a missing table, column or enum value
// is a "schema gap" report item, and only the orchestrator edits this file.
//
// Conventions
// - Column names are derived from the property names (`casing: "snake_case"` in drizzle.config.ts
//   and in db/client.ts). SQL fragments in this file (index predicates, CHECKs) therefore spell
//   the physical snake_case names out.
// - Rows of our tables have a `uuid` v7 id from db/ids.ts. A column that holds a Better Auth user
//   or session id is `text` (those ids are 32-character strings, not UUIDs).
// - Every timestamp here is `timestamptz`. Better Auth's generated tables (auth-schema.ts) use
//   `timestamp` WITHOUT time zone and are kept verbatim; see the header of db/client.ts.
// - ON DELETE for every reference to `user`: RESTRICT where the user-purge job must clean up
//   first, SET NULL where authorship is anonymised, CASCADE where the row is only about that user.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { uuidv7 } from "./ids";

export * from "./auth-schema";

// ── column helpers ──────────────────────────────────────────────────────────────────────────

/** Case-insensitive text (the `citext` extension, created by migration 0000). */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

/** Raw bytes. `pg` returns a Buffer, which is a Uint8Array. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

const id = () => uuid().primaryKey().$defaultFn(uuidv7);
const ts = () => timestamp({ withTimezone: true, mode: "date" });
const bytes = () => bigint({ mode: "number" });

// ── enums ───────────────────────────────────────────────────────────────────────────────────

export const nodeKind = pgEnum("node_kind", ["file", "folder"]);
export const scanStatus = pgEnum("scan_status", [
  "pending",
  "clean",
  "infected",
  "suspected_csam",
  "under_review",
  "skipped",
  "error",
]);
export const takedownReason = pgEnum("takedown_reason", ["dmca", "abuse", "csam", "admin"]);
export const uploadStatus = pgEnum("upload_status", ["open", "completing", "done", "aborted"]);
export const uploadPurpose = pgEnum("upload_purpose", ["file", "avatar"]);
export const shareRole = pgEnum("share_role", ["viewer", "editor"]);
export const linkOutcome = pgEnum("link_outcome", [
  "ok",
  "denied_password",
  "denied_expired",
  "denied_cap",
  "denied_paused",
  "denied_scan",
  "denied_owner",
]);
export const ledgerSubject = pgEnum("ledger_subject", [
  // downloads
  "user",
  "link",
  "ip",
  // uploads
  "upload_user",
  "upload_editor",
  // creations per user per day
  "transform_user",
  "share_user",
  "link_user",
  // sign-up velocity (never shares a row with download accounting)
  "signup_ip",
  "signup_ip24",
  "signup_asn",
  "signup_domain",
  // declared, unused in v1
  "ip24",
  "asn",
  "email",
]);
export const blocklistReason = pgEnum("blocklist_reason", ["malware", "csam", "dmca", "admin"]);
export const reportCategory = pgEnum("report_category", [
  "malware",
  "csam",
  "copyright",
  "phishing",
  "spam",
  "other",
]);
export const reportSource = pgEnum("report_source", ["user", "system", "admin", "photodna"]);
export const reportStatus = pgEnum("report_status", ["open", "reviewing", "actioned", "dismissed"]);
export const dmcaReceivedVia = pgEnum("dmca_received_via", ["email", "form", "post"]);
export const dmcaStatus = pgEnum("dmca_status", [
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
export const strikeKind = pgEnum("strike_kind", ["dmca", "malware", "abuse"]);
export const auditActor = pgEnum("audit_actor", ["user", "admin", "system", "link"]);
export const scanJobStatus = pgEnum("scan_job_status", ["running", "done", "failed"]);
export const prefDensity = pgEnum("pref_density", ["compact", "comfortable"]);
export const prefTheme = pgEnum("pref_theme", ["system", "light", "dark"]);
export const prefViewMode = pgEnum("pref_view_mode", ["list", "grid"]);
export const emailWindowKind = pgEnum("email_window_kind", ["hour", "day"]);

/** `nodes.scan_reason` is text + CHECK, so v1.1 can add a reason without an enum migration. */
export const SCAN_REASONS = ["size", "encrypted", "limits", "timeout", "engine", "hash_mismatch"] as const;
export type ScanReason = (typeof SCAN_REASONS)[number];

/** The elements `share_links.pause_reasons` may hold. The column is a set. */
export const PAUSE_REASONS = [
  "ceiling",
  "anomaly",
  "owner",
  "owner_deletion",
  "owner_suspended",
  "report",
  "moderation",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export type ScanStatus = (typeof scanStatus.enumValues)[number];
export type LedgerSubject = (typeof ledgerSubject.enumValues)[number];

/** Shape of `nodes.scan_detail`. */
export type ScanDetail = {
  signatures?: string[];
  pua?: string[];
  engine?: string;
  dbVersion?: string;
  durationMs?: number;
};

// ── nodes ───────────────────────────────────────────────────────────────────────────────────

export const nodes = pgTable(
  "nodes",
  {
    // Identity and tree.
    id: id(),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** The uploader; differs from the owner inside shared folders. Null = anonymised. */
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    /**
     * Null = root. NO ACTION, never CASCADE: it is checked at the end of the statement, so one
     * DELETE of a whole subtree succeeds while a DELETE that would orphan children fails.
     */
    parentId: uuid().references((): AnyPgColumn => nodes.id),
    kind: nodeKind().notNull(),
    name: text().notNull(),
    /** From `nameKeyOf()`; what uniqueness and name ordering use. */
    nameKey: text().notNull(),
    /** Lower-case extension without the dot, '' when none. Written together with `name`. */
    ext: text().notNull().default(""),
    /** Null, or 'avatar'. System nodes are in no listing and never count against the quota. */
    system: text(),

    // Content.
    size: bytes().notNull().default(0),
    mimeDeclared: text(),
    mimeSniffed: text(),
    r2Key: text(),
    versionId: text(),
    sha256: text(),

    // Scan.
    scanStatus: scanStatus().notNull().default("pending"),
    /** The status to restore when a report is dismissed. */
    scanStatusPrev: scanStatus(),
    /** Why the node is `skipped` or `error`. One of SCAN_REASONS. */
    scanReason: text().$type<ScanReason>(),
    scanDetail: jsonb().$type<ScanDetail>(),
    scannedAt: ts(),
    rescanRequestedAt: ts(),

    // Trash.
    deletedAt: ts(),
    trashedRoot: boolean().notNull().default(false),
    trashedBy: text().references(() => user.id, { onDelete: "set null" }),
    purgeAfter: ts(),
    /** The owner asked for permanent deletion while the subtree was held. */
    purgeRequestedAt: ts(),

    // Moderation.
    legalHold: boolean().notNull().default(false),
    takedownAt: ts(),
    takedownReason: takedownReason(),
    takedownBy: text().references(() => user.id, { onDelete: "set null" }),

    // Misc.
    starred: boolean().notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
    lastAccessedAt: ts(),
  },
  (t) => [
    // One live name per folder. A unique index treats NULLs as distinct, and drizzle-kit cannot
    // emit NULLS NOT DISTINCT on an index, so the root level (parent_id IS NULL) has its own
    // index. Together the two are UNIQUE (owner_id, parent_id, name_key) NULLS NOT DISTINCT.
    uniqueIndex("nodes_live_name_root_uq")
      .on(t.ownerId, t.nameKey)
      .where(sql`parent_id IS NULL AND deleted_at IS NULL AND system IS NULL`),
    uniqueIndex("nodes_live_name_child_uq")
      .on(t.ownerId, t.parentId, t.nameKey)
      .where(sql`parent_id IS NOT NULL AND deleted_at IS NULL AND system IS NULL`),
    // Keyset listings of a folder, one per sort key (folders first, then the key, then id).
    index("nodes_children_name_idx").on(t.parentId, t.kind, t.nameKey, t.id),
    index("nodes_children_size_idx").on(t.parentId, t.kind, t.size, t.id),
    index("nodes_children_updated_idx").on(t.parentId, t.kind, t.updatedAt, t.id),
    index("nodes_children_ext_idx").on(t.parentId, t.kind, t.ext, t.nameKey, t.id),
    // The owner's top level in the default order (parent_id IS NULL has no parent to seek on).
    index("nodes_root_name_idx")
      .on(t.ownerId, t.kind, t.nameKey, t.id)
      .where(sql`parent_id IS NULL`),
    index("nodes_owner_parent_idx").on(t.ownerId, t.parentId),
    index("nodes_owner_deleted_idx").on(t.ownerId, t.deletedAt),
    index("nodes_owner_accessed_idx").on(t.ownerId, t.lastAccessedAt.desc()),
    index("nodes_owner_starred_idx")
      .on(t.ownerId)
      .where(sql`starred`),
    index("nodes_purge_after_idx")
      .on(t.purgeAfter)
      .where(sql`trashed_root`),
    index("nodes_purge_requested_idx")
      .on(t.purgeRequestedAt)
      .where(sql`purge_requested_at IS NOT NULL`),
    index("nodes_sha256_idx").on(t.sha256),
    uniqueIndex("nodes_r2_key_uq")
      .on(t.r2Key)
      .where(sql`r2_key IS NOT NULL`),
    index("nodes_created_by_idx").on(t.createdBy, t.createdAt),
    index("nodes_scan_status_idx")
      .on(t.scanStatus)
      .where(sql`scan_status <> 'clean'`),
    index("nodes_takedown_idx")
      .on(t.takedownAt)
      .where(sql`takedown_at IS NOT NULL`),
    index("nodes_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    check(
      "nodes_scan_reason_known",
      sql`scan_reason IS NULL OR scan_reason IN ('size', 'encrypted', 'limits', 'timeout', 'engine', 'hash_mismatch')`,
    ),
  ],
);

/** Written on Replace. The history UI is v1.1. */
export const nodeVersions = pgTable(
  "node_versions",
  {
    nodeId: uuid()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    versionId: text().notNull(),
    r2Key: text().notNull(),
    size: bytes().notNull(),
    sha256: text(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    purgeAfter: ts().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.versionId] }),
    index("node_versions_purge_after_idx").on(t.purgeAfter),
    index("node_versions_r2_key_idx").on(t.r2Key),
  ],
);

// ── uploads ─────────────────────────────────────────────────────────────────────────────────

export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    ownerId: text()
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    uploaderId: text()
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** NO ACTION: `deleteSubtreeRows` removes the sessions that target a subtree first. */
    parentId: uuid().references(() => nodes.id),
    /** Pre-allocated id of the node this upload creates, or `replaceNodeId`. No FK: no row yet. */
    nodeId: uuid().notNull(),
    /** Pre-allocated: the R2 key `u/<owner>/<node>/<version>` is needed at init. */
    versionId: text().notNull(),
    replaceNodeId: uuid().references(() => nodes.id, { onDelete: "set null" }),
    name: text().notNull(),
    nameKey: text().notNull(),
    size: bytes().notNull(),
    mimeDeclared: text(),
    r2Key: text().notNull(),
    /** Null for a single PUT. There is no `mode` column. */
    r2UploadId: text(),
    partBytes: integer(),
    partCount: integer(),
    expectedSha256: text(),
    status: uploadStatus().notNull().default("open"),
    purpose: uploadPurpose().notNull().default("file"),
    fileLastModified: ts(),
    createdAt: ts().notNull().defaultNow(),
    expiresAt: ts().notNull(),
    /** When `claimCompleting` moved the session to `completing`; the stale sweep measures from it. */
    completingAt: ts(),
    /** When the session reached a terminal status (`done` or `aborted`). */
    completedAt: ts(),
  },
  (t) => [
    index("uploads_resume_idx")
      .on(t.uploaderId, t.parentId, t.nameKey, t.size, t.fileLastModified)
      .where(sql`status = 'open'`),
    index("uploads_uploader_status_idx").on(t.uploaderId, t.status),
    index("uploads_owner_status_idx").on(t.ownerId, t.status),
    index("uploads_status_expires_idx").on(t.status, t.expiresAt),
    index("uploads_parent_idx").on(t.parentId),
    index("uploads_r2_key_idx").on(t.r2Key),
  ],
);

export const uploadParts = pgTable(
  "upload_parts",
  {
    uploadId: uuid()
      .notNull()
      .references(() => uploads.id, { onDelete: "cascade" }),
    partNumber: integer().notNull(),
    etag: text().notNull(),
    size: bytes().notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.partNumber] })],
);

// ── sharing ─────────────────────────────────────────────────────────────────────────────────

/** A share to an address with no account is a real, pending row. Only activated rows grant. */
export const shares = pgTable(
  "shares",
  {
    id: id(),
    nodeId: uuid()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    grantedBy: text().references(() => user.id, { onDelete: "set null" }),
    /** The address as the owner typed it; kept after activation. */
    granteeEmail: citext().notNull(),
    /** Null = pending. */
    granteeUserId: text().references(() => user.id, { onDelete: "cascade" }),
    /** Null = pending. */
    activatedAt: ts(),
    role: shareRole().notNull(),
    canUpload: boolean().notNull().default(true),
    mutedByGrantee: boolean().notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shares_node_email_uq").on(t.nodeId, t.granteeEmail),
    uniqueIndex("shares_node_user_uq").on(t.nodeId, t.granteeUserId),
    index("shares_grantee_user_idx").on(t.granteeUserId),
    index("shares_pending_email_idx")
      .on(t.granteeEmail)
      .where(sql`grantee_user_id IS NULL`),
  ],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    nodeId: uuid()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** v1: always the node's owner. */
    createdBy: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** SHA-256 of the token. Lookup never decrypts. */
    tokenHash: text().notNull().unique("share_links_token_hash_uq"),
    /** The token sealed with AES-GCM, so the owner can copy the URL again. */
    tokenEnc: bytea().notNull(),
    tokenIv: bytea().notNull(),
    tokenKeyVersion: smallint().notNull().default(1),
    /** Self-describing scrypt string. */
    passwordHash: text(),
    expiresAt: ts(),
    /** Null = unlimited. */
    maxDownloads: integer(),
    downloadCount: integer().notNull().default(0),
    bytesServed: bytes().notNull().default(0),
    allowPreview: boolean().notNull().default(true),
    revokedAt: ts(),
    /** When the set first became non-empty. Null exactly when the set is empty. */
    pausedAt: ts(),
    /** A SET of PAUSE_REASONS. The link is paused exactly when it is non-empty. */
    pauseReasons: text()
      .array()
      .$type<PauseReason[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    lockedByAdmin: boolean().notNull().default(false),
    /** The owner is emailed about a pause at most once a day. */
    lastPauseEmailAt: ts(),
    lastAccessAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("share_links_node_idx").on(t.nodeId),
    index("share_links_creator_idx").on(t.createdBy, t.createdAt),
    index("share_links_paused_idx")
      .on(t.pausedAt)
      .where(sql`paused_at IS NOT NULL`),
    check(
      "share_links_pause_reasons_known",
      sql`pause_reasons <@ ARRAY['ceiling', 'anomaly', 'owner', 'owner_deletion', 'owner_suspended', 'report', 'moderation']::text[]`,
    ),
    check("share_links_paused_at_matches", sql`(paused_at IS NULL) = (cardinality(pause_reasons) = 0)`),
  ],
);

/** Inline exponential throttle per link and IP. There is no hard pause. */
export const linkPasswordAttempts = pgTable(
  "link_password_attempts",
  {
    linkId: uuid()
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    ipHashStable: text().notNull(),
    failures: integer().notNull().default(0),
    lastFailureAt: ts().notNull().defaultNow(),
    lockedUntil: ts(),
  },
  (t) => [
    primaryKey({ columns: [t.linkId, t.ipHashStable] }),
    index("link_password_attempts_last_failure_idx").on(t.lastFailureAt),
  ],
);

export const linkAccessLog = pgTable(
  "link_access_log",
  {
    id: id(),
    linkId: uuid()
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    /** The file served. No FK. */
    nodeId: uuid(),
    at: ts().notNull().defaultNow(),
    ipHashDaily: text(),
    country: text(),
    uaHash: text(),
    bytes: bytes().notNull().default(0),
    outcome: linkOutcome().notNull(),
  },
  (t) => [index("link_access_log_link_at_idx").on(t.linkId, t.at), index("link_access_log_at_idx").on(t.at)],
);

// ── ledgers ─────────────────────────────────────────────────────────────────────────────────

/** Every daily ceiling, not only downloads. Days are UTC. */
export const downloadLedger = pgTable(
  "download_ledger",
  {
    day: date({ mode: "string" }).notNull(),
    subjectType: ledgerSubject().notNull(),
    /** A user id, a link id, an IP hash, an ASN, a domain. */
    subjectId: text().notNull(),
    bytes: bytes().notNull().default(0),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.subjectType, t.subjectId] })],
);

/** The shared store behind the per-recipient 5/hour and 50/day email caps. */
export const emailLedger = pgTable(
  "email_ledger",
  {
    /** Not `window`: that is a reserved word. */
    windowKind: emailWindowKind().notNull(),
    windowStart: ts().notNull(),
    recipientHash: text().notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.windowKind, t.windowStart, t.recipientHash] }),
    index("email_ledger_window_start_idx").on(t.windowStart),
  ],
);

// ── moderation ──────────────────────────────────────────────────────────────────────────────

export const hashBlocklist = pgTable("hash_blocklist", {
  sha256: text().primaryKey(),
  reason: blocklistReason().notNull(),
  /** The node whose verdict added the entry. No FK. */
  sourceNodeId: uuid(),
  addedBy: text().references(() => user.id, { onDelete: "set null" }),
  addedAt: ts().notNull().defaultNow(),
  note: text(),
});

export const invites = pgTable("invites", {
  code: text().primaryKey(),
  createdBy: text().references(() => user.id, { onDelete: "set null" }),
  maxUses: integer().notNull().default(1),
  uses: integer().notNull().default(0),
  expiresAt: ts(),
  revokedAt: ts(),
  note: text(),
  createdAt: ts().notNull().defaultNow(),
});

export const reports = pgTable(
  "reports",
  {
    id: id(),
    nodeId: uuid().references(() => nodes.id, { onDelete: "set null" }),
    linkId: uuid().references(() => shareLinks.id, { onDelete: "set null" }),
    /** Owner of the reported node. */
    ownerId: text().references(() => user.id, { onDelete: "set null" }),
    category: reportCategory().notNull(),
    source: reportSource().notNull(),
    reporterEmail: citext(),
    /** Set when the reporter proved access through a share role. */
    reporterUserId: text().references(() => user.id, { onDelete: "set null" }),
    /** The non-rotating hash: it is what lets the dedupe index work across days. */
    reporterIpHashStable: text(),
    details: text(),
    status: reportStatus().notNull().default("open"),
    assignedTo: text().references(() => user.id, { onDelete: "set null" }),
    resolution: text(),
    createdAt: ts().notNull().defaultNow(),
    resolvedAt: ts(),
    ncmecStartedAt: ts(),
    ncmecFiledAt: ts(),
    ncmecReportId: text(),
  },
  (t) => [
    uniqueIndex("reports_open_dedupe_uq")
      .on(t.nodeId, t.reporterIpHashStable, t.category)
      .where(sql`status IN ('open', 'reviewing')`),
    index("reports_status_created_idx").on(t.status, t.createdAt),
    index("reports_node_idx").on(t.nodeId),
  ],
);

export const strikes = pgTable(
  "strikes",
  {
    id: id(),
    /** The uploader. */
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: strikeKind().notNull(),
    reportId: uuid().references(() => reports.id, { onDelete: "set null" }),
    /** No FK. */
    nodeId: uuid(),
    /** Null = system. */
    issuedBy: text().references(() => user.id, { onDelete: "set null" }),
    at: ts().notNull().defaultNow(),
    note: text(),
    liftedAt: ts(),
    liftedBy: text().references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("strikes_user_at_idx").on(t.userId, t.at)],
);

/** One row per notice per alleged infringer. */
export const dmcaNotices = pgTable(
  "dmca_notices",
  {
    // The notice, 17 U.S.C. §512(c)(3).
    id: id(),
    receivedAt: ts().notNull().defaultNow(),
    receivedVia: dmcaReceivedVia().notNull(),
    complainantName: text(),
    complainantOrg: text(),
    complainantAddress: text(),
    complainantPhone: text(),
    complainantEmail: citext(),
    /** The copyrighted work. */
    workDescription: text(),
    /** The material and where it is. */
    infringingDescription: text(),
    statementGoodFaith: boolean().notNull().default(false),
    /** Accuracy and authority, under penalty of perjury. */
    statementAccuracy: boolean().notNull().default(false),
    signature: text(),
    /** The notice as received. */
    rawText: text(),
    /** Per-element completeness verdicts. */
    checklist: jsonb().$type<Record<string, unknown>>(),

    // Handling.
    status: dmcaStatus().notNull().default("received"),
    handledBy: text().references(() => user.id, { onDelete: "set null" }),
    takedownAt: ts(),
    ownerNotifiedAt: ts(),
    strikeId: uuid().references(() => strikes.id, { onDelete: "set null" }),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),

    // The counter-notice, §512(g).
    counterReceivedAt: ts(),
    counterName: text(),
    counterAddress: text(),
    counterPhone: text(),
    counterEmail: citext(),
    counterStatement: text(),
    counterConsentJurisdiction: boolean(),
    counterSignature: text(),
    /** When the copy went to the complainant. */
    counterForwardedAt: ts(),
    /** 10 and 14 business days after `counterForwardedAt`. */
    restoreNotBefore: ts(),
    restoreNotAfter: ts(),
    /** The complainant says an action was filed: the material stays down. */
    lawsuitNoticeAt: ts(),
    restoredAt: ts(),
    restoredBy: text().references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("dmca_notices_status_idx").on(t.status, t.receivedAt)],
);

export const dmcaNoticeNodes = pgTable(
  "dmca_notice_nodes",
  {
    noticeId: uuid()
      .notNull()
      .references(() => dmcaNotices.id, { onDelete: "cascade" }),
    /** No FK: the notice record outlives the file. */
    nodeId: uuid().notNull(),
    // Snapshots.
    nodeName: text(),
    sha256: text(),
  },
  (t) => [primaryKey({ columns: [t.noticeId, t.nodeId] }), index("dmca_notice_nodes_node_idx").on(t.nodeId)],
);

// ── audit and retention ─────────────────────────────────────────────────────────────────────

/** Kept 180 days, except rows with `meta.legalHold = true`. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: ts().notNull().defaultNow(),
    /** No FK: audit rows outlive the account. */
    actorUserId: text(),
    actorType: auditActor().notNull(),
    action: text().notNull(),
    targetType: text(),
    /** Holds either id family. */
    targetId: text(),
    ipHashDaily: text(),
    ua: text(),
    country: text(),
    requestId: text(),
    meta: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at.desc()),
    index("audit_log_actor_idx").on(t.actorUserId, t.at.desc()),
    index("audit_log_target_idx").on(t.targetType, t.targetId, t.at.desc()),
  ],
);

/**
 * Raw-IP retention for lawful reporting only. Deleted after 90 days unless `legalHold`.
 * No FKs: a row must survive the node and the account for its retention period.
 */
export const uploadIps = pgTable(
  "upload_ips",
  {
    id: id(),
    nodeId: uuid().notNull(),
    versionId: text().notNull(),
    uploaderId: text().notNull(),
    /** AES-GCM under `IP_ENC_KEY`. */
    ipEncrypted: bytea().notNull(),
    iv: bytea().notNull(),
    keyVersion: smallint().notNull(),
    at: ts().notNull().defaultNow(),
    legalHold: boolean().notNull().default(false),
  },
  (t) => [index("upload_ips_node_idx").on(t.nodeId), index("upload_ips_at_idx").on(t.at)],
);

// ── scanning ────────────────────────────────────────────────────────────────────────────────

/** One row per object key; keys are immutable. Claim semantics live in queries/scan-jobs.ts. */
export const scanJobs = pgTable(
  "scan_jobs",
  {
    id: id(),
    nodeId: uuid()
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    r2Key: text().notNull().unique("scan_jobs_r2_key_uq"),
    /** Informational only. */
    etag: text(),
    attempt: integer().notNull().default(1),
    status: scanJobStatus().notNull().default("running"),
    engine: text(),
    verdict: jsonb().$type<Record<string, unknown>>(),
    lastError: text(),
    startedAt: ts().notNull().defaultNow(),
    finishedAt: ts(),
  },
  (t) => [
    index("scan_jobs_node_idx").on(t.nodeId),
    index("scan_jobs_status_started_idx").on(t.status, t.startedAt),
  ],
);

// ── settings and preferences ────────────────────────────────────────────────────────────────

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedBy: text().references(() => user.id, { onDelete: "set null" }),
  updatedAt: ts().notNull().defaultNow(),
});

export const userPrefs = pgTable("user_prefs", {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  density: prefDensity().notNull().default("compact"),
  theme: prefTheme().notNull().default("system"),
  /** The only home of the explorer view mode. */
  viewMode: prefViewMode().notNull().default("list"),
  emailShares: boolean().notNull().default(true),
  /** Stored, unused in v1. */
  emailLinkDigest: boolean().notNull().default(true),
  /** Not editable. */
  emailSecurity: boolean().notNull().default(true),
  updatedAt: ts().notNull().defaultNow(),
});

// ── account deletion ────────────────────────────────────────────────────────────────────────

/** Lifecycle owned by queries/user-purge.ts. */
export const pendingUserPurges = pgTable(
  "pending_user_purges",
  {
    /** No FK: the row must outlive the user row it purges. */
    userId: text().primaryKey(),
    requestedAt: ts().notNull().defaultNow(),
    scheduledFor: ts().notNull(),
    startedAt: ts(),
    finishedAt: ts(),
    attempts: integer().notNull().default(0),
    error: text(),
  },
  (t) => [index("pending_user_purges_due_idx").on(t.scheduledFor)],
);

export type Node = typeof nodes.$inferSelect;
export type NodeVersion = typeof nodeVersions.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type UploadPart = typeof uploadParts.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type ShareLink = typeof shareLinks.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Strike = typeof strikes.$inferSelect;
export type DmcaNotice = typeof dmcaNotices.$inferSelect;
export type ScanJob = typeof scanJobs.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type UserPrefs = typeof userPrefs.$inferSelect;
export type PendingUserPurge = typeof pendingUserPurges.$inferSelect;
export type UploadIp = typeof uploadIps.$inferSelect;
