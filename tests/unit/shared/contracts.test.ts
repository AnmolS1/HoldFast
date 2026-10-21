// The shared contracts: every schema parses its documented example, what a client sends refuses
// an unknown field, and the values that exist in two places agree.
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as constants from "../../../src/shared/constants";
import { ERROR_STATUS } from "../../../src/shared/errors";
import { BA_ID } from "../../../src/shared/ids";
import { PublicConfig } from "../../../src/shared/public-config";
import * as account from "../../../src/shared/schemas/account";
import * as admin from "../../../src/shared/schemas/admin";
import * as common from "../../../src/shared/schemas/common";
import * as link from "../../../src/shared/schemas/link";
import * as node from "../../../src/shared/schemas/node";
import * as report from "../../../src/shared/schemas/report";
import * as search from "../../../src/shared/schemas/search";
import * as share from "../../../src/shared/schemas/share";
import * as upload from "../../../src/shared/schemas/upload";
import { PublicConfig as ClientPublicConfig } from "../../../src/client/lib/contracts";
import * as linksQuery from "../../../src/worker/db/queries/links";
import * as nodesQuery from "../../../src/worker/db/queries/nodes";
import * as scanJobs from "../../../src/worker/db/queries/scan-jobs";
import * as schema from "../../../src/worker/db/schema";
import { uuidv7 } from "../../../src/worker/db/ids";
import acceptTermsRoute from "../../../src/worker/routes/account-lifecycle.ts?raw";
import pendingEmailRoute from "../../../src/worker/routes/pending-email.ts?raw";
import publicRoute from "../../../src/worker/routes/public.ts?raw";

const USER = "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF";
const OTHER_USER = "Zy9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE";
const NODE = "0199d3c2-7a10-7000-8000-0000000000a1";
const PARENT = "0199d3c2-7a10-7000-8000-0000000000b2";
const ROW = "0199d3c2-7a10-7000-8000-0000000000c3";
const AT = "2026-10-12T12:00:00.000Z";
// A made-up digest: 64 hex characters that belong to no real content.
const SHA = "ab".repeat(32);

const userRef = { id: USER, displayName: "Ada" };
const nodeDto = {
  id: NODE,
  parentId: PARENT,
  kind: "file",
  name: "report.pdf",
  ext: "pdf",
  size: 1234,
  mimeCategory: "pdf",
  mimeSniffed: "application/pdf",
  etag: "0199d3c2-7a10-7000-8000-0000000000d4",
  sha256: SHA,
  scanStatus: "clean",
  scanReason: null,
  pua: [],
  thumb: false,
  starred: false,
  createdAt: AT,
  updatedAt: AT,
  lastAccessedAt: null,
  deletedAt: null,
  purgeAfter: null,
  owner: userRef,
  createdBy: userRef,
  role: "owner",
  sharing: { people: 2, link: "active", summary: "both" },
};
const zipEntry = { nodeId: NODE, path: "docs/report.pdf", size: 1234, etag: "v1", modifiedAt: AT };
const linkDto = {
  id: ROW,
  nodeId: NODE,
  node: { name: "report.pdf", kind: "file" },
  url: "https://holdfast.example/s/AbCdEfGhIjKlMnOpQrStUv",
  state: "paused",
  pausedReasons: ["traffic", "owner"],
  canUnpause: true,
  expiresAt: null,
  hasPassword: true,
  maxDownloads: 10,
  downloadCount: 3,
  bytesServed: 3702,
  allowPreview: true,
  createdAt: AT,
  lastAccessAt: null,
  limitedToday: false,
};
const shareDto = {
  id: ROW,
  nodeId: NODE,
  email: "Friend@Example.test",
  role: "editor",
  canUpload: true,
  createdAt: AT,
};
const publicNode = {
  id: NODE,
  name: "a.png",
  kind: "file",
  size: 10,
  mimeCategory: "image",
  ext: "png",
  thumb: true,
};
const prefs = {
  density: "compact",
  theme: "system",
  viewMode: "list",
  emailShares: true,
  emailLinkDigest: false,
  emailSecurity: true,
};
const activity = {
  id: ROW,
  at: AT,
  action: "auth.sign_in",
  outcome: "ok",
  uaLabel: "Chrome on macOS",
  country: "DE",
};
const adminNode = {
  ...nodeDto,
  scanStatus: "suspected_csam",
  takedown: { at: AT, reason: "csam" },
  legalHold: true,
};
const reportDto = {
  id: ROW,
  nodeId: NODE,
  linkId: null,
  ownerId: USER,
  category: "malware",
  source: "user",
  reporterEmail: "reporter@example.test",
  reporterUserId: null,
  details: "It asked me to run a program.",
  status: "open",
  assignedTo: null,
  resolution: null,
  createdAt: AT,
  resolvedAt: null,
  ncmecStartedAt: null,
  ncmecFiledAt: null,
  ncmecReportId: null,
  node: adminNode,
};
const dmcaNotice = {
  id: ROW,
  receivedAt: AT,
  receivedVia: "email",
  complainantName: "A. Rights-Holder",
  complainantOrg: null,
  complainantAddress: "1 Example Street",
  complainantPhone: null,
  complainantEmail: "legal@example.test",
  workDescription: "A photograph.",
  infringingDescription: "The file report.pdf.",
  statementGoodFaith: true,
  statementAccuracy: true,
  signature: "A. Rights-Holder",
  rawText: null,
  checklist: { identification: true },
  status: "received",
  handledBy: null,
  takedownAt: null,
  ownerNotifiedAt: null,
  strikeId: null,
  createdAt: AT,
  updatedAt: AT,
  counterReceivedAt: null,
  counterName: null,
  counterAddress: null,
  counterPhone: null,
  counterEmail: null,
  counterStatement: null,
  counterConsentJurisdiction: null,
  counterSignature: null,
  counterForwardedAt: null,
  restoreNotBefore: null,
  restoreNotAfter: null,
  lawsuitNoticeAt: null,
  restoredAt: null,
  restoredBy: null,
  nodes: [{ nodeId: NODE, nodeName: "report.pdf", sha256: SHA }],
};
const page = <T>(item: T) => ({ items: [item], nextCursor: null });

const uploadSession = {
  uploadId: ROW,
  parentId: PARENT,
  name: "video.mp4",
  size: 2_000_000_000,
  partBytes: 67_108_864,
  partCount: 30,
  uploadedParts: 4,
  fileLastModified: AT,
  createdAt: AT,
  expiresAt: AT,
};
const trashedDto = { ...nodeDto, deletedAt: AT, purgeAfter: AT };

/** One documented example per exported schema, keyed `module.Name`. */
const EXAMPLES: Record<string, unknown> = {
  "common.UserId": USER,
  "common.SessionId": OTHER_USER,
  "common.NodeId": NODE,
  "common.RowId": ROW,
  "common.PathToken": "AbCdEfGhIjKlMnOpQrStUv",
  "common.Timestamp": AT,
  "common.Bytes": 2_000_000_000,
  "common.Sha256": SHA,
  "common.UserRef": userRef,
  "common.Role": "editor",
  "common.ScanStatus": "under_review",
  "common.ScanReason": "hash_mismatch",
  "common.MimeCategory": "archive",
  "common.ErrorCode": "ceiling_exceeded",
  "common.ErrorBody": {
    error: "ceiling_exceeded",
    message: "Daily limit reached.",
    requestId: "0199d3c2-7a10-7000-8000-0000000000ff",
    details: { kind: "download_user", dimension: "bytes" },
  },
  "common.NodeName": "report.pdf",
  "common.Email": "ada@example.test",

  "node.NodeKind": "folder",
  "node.NodeSharing": { people: 0, link: "none", summary: "none" },
  "node.NodeDto": nodeDto,
  "node.ListChildrenQuery": { sort: "updated", dir: "desc", cursor: "abc", limit: "200", kind: "file" },
  "node.NodePage": page(nodeDto),
  "node.BreadcrumbDto": { id: PARENT, name: "Documents" },
  "node.NodeDetailDto": { node: nodeDto, breadcrumbs: [{ id: PARENT, name: "Documents" }] },
  "node.CreateFolderBody": { parentId: null, name: "Documents" },
  "node.RenameBody": { name: "Reports", starred: true },
  "node.MoveBody": { parentId: PARENT },
  "node.EmptyTrashResponse": { remaining: 12 },
  "node.TrashItemDto": trashedDto,
  "node.TrashQuery": { cursor: "b3BhcXVl", limit: "50" },
  "node.TrashResponse": { items: [trashedDto], nextCursor: null },
  "node.TrashNodeResponse": trashedDto,
  "node.RestoreNodeResponse": { ...nodeDto, parentId: null, name: "report (restored).pdf" },
  "node.DownloadUrlBody": { kind: "inline" },
  "node.DownloadUrlResponse": { url: "https://files.example/d/x/y", expiresAt: AT, warning: "unscanned" },
  "node.ThumbUrlResponse": { url: "https://files.example/t/x/y", expiresAt: AT },
  "node.ZipManifestBody": { nodeIds: [NODE], allOwned: false },
  "node.ZipEntry": zipEntry,
  "node.ZipSkipped": { nodeId: NODE, path: "docs/a.exe", reason: "scan_blocked" },
  "node.ZipManifest": {
    entries: [zipEntry],
    totalBytes: 1234,
    skipped: [{ nodeId: NODE, path: "docs/new.bin", reason: "scan_pending" }],
    truncated: false,
  },
  "node.BatchDownloadUrlsBody": { nodeIds: [NODE, PARENT] },
  "node.BatchDownloadUrlItem": { nodeId: NODE, error: "scan_pending" },
  "node.BatchDownloadUrlsResponse": {
    items: [
      { nodeId: NODE, url: "https://files.example/d/x/y", expiresAt: AT },
      { nodeId: PARENT, error: "not_found" },
    ],
  },

  "upload.InitUploadBody": {
    parentId: null,
    name: "video.mp4",
    size: 2_000_000_000,
    mimeDeclared: "video/mp4",
    fileLastModified: AT,
    onConflict: "replace",
    replaceNodeId: NODE,
    purpose: "file",
  },
  "upload.UploadedPart": { n: 1, etag: "0cc175b9c0f1b6a831c399e269772661" },
  "upload.InitUploadResponse": {
    uploadId: ROW,
    mode: "multipart",
    partBytes: 67_108_864,
    partCount: 30,
    resumedParts: [{ n: 1, etag: "0cc175b9c0f1b6a831c399e269772661" }],
    finalName: "video (2).mp4",
    expiresAt: AT,
  },
  "upload.PartResponse": { n: 2, etag: "92eb5ffee6ae2fec3ad71c777531578f" },
  "upload.SinglePutResponse": { etag: "92eb5ffee6ae2fec3ad71c777531578f" },
  "upload.OpenUploadsResponse": [uploadSession],
  "upload.CompleteUploadBody": { sha256: SHA, parts: [{ n: 1, etag: "0cc175b9c0f1b6a831c399e269772661" }] },
  "upload.CompleteUploadResponse": nodeDto,
  "upload.UploadSessionDto": uploadSession,

  "share.ShareRole": "viewer",
  "share.ShareDto": shareDto,
  "share.CreateShareBody": { email: "friend@example.test", role: "editor", canUpload: true },
  "share.PatchShareBody": { role: "viewer", canUpload: false, mutedByGrantee: true },
  "share.NodeSharingDto": {
    shares: [shareDto],
    links: [linkDto],
    inheritedFrom: { nodeId: PARENT, name: "Documents" },
  },
  "share.SharedWithMeDto": {
    node: { ...nodeDto, role: "viewer" },
    role: "viewer",
    owner: userRef,
    sharedAt: AT,
  },
  "share.SharesMineDto": { node: { id: NODE, name: "report.pdf", kind: "file" }, shares: [shareDto] },

  "link.LinkState": "limit_reached",
  "link.LinkOutcome": "refused",
  "link.LinkPauseReason": "review",
  "link.LinkDto": linkDto,
  "link.CreateLinkBody": {
    expiresAt: AT,
    password: "a made-up password",
    maxDownloads: 5,
    allowPreview: true,
  },
  "link.PatchLinkBody": {
    expiresAt: null,
    password: null,
    maxDownloads: null,
    allowPreview: false,
    paused: true,
  },
  "link.LinkActivityDto": {
    days: [{ day: "2026-10-12", downloads: 3, bytes: 3702 }],
    countries: [{ country: "DE", downloads: 3 }],
    outcomes: { ok: 3, password: 1 },
  },
  "link.PublicNodeDto": publicNode,
  "link.PublicLinkInfo": { requiresPassword: true, node: null, allowPreview: true, dangerous: false },
  "link.PublicChildrenResponse": page(publicNode),
  "link.UnlockBody": { password: "a made-up password" },
  "link.UnlockResponse": { linkSession: "payload.signature", expiresAt: AT },
  "link.PublicDownloadUrlBody": {
    nodeId: NODE,
    kind: "download",
    dangerousAck: true,
    zipGrant: "payload.signature",
  },
  "link.PublicDownloadUrlResponse": { url: "https://files.example/d/x/y", expiresAt: AT },
  "link.PublicZipSkipped": { nodeId: NODE, path: "docs/a.bin", reason: "unavailable" },
  "link.PublicZipManifest": {
    entries: [zipEntry],
    totalBytes: 1234,
    skipped: [{ nodeId: PARENT, path: "docs/b.bin", reason: "unavailable" }],
    truncated: false,
    zipGrant: "payload.signature",
  },
  "link.LinkToken": "AbCdEfGhIjKlMnOpQrStUv",

  "search.SearchQuery": {
    q: "tax",
    kind: "file",
    category: "document",
    scope: "shared",
    inFolder: PARENT,
    cursor: "abc",
    limit: "50",
  },
  "search.SearchResultDto": { ...nodeDto, pathHint: "Documents / 2026" },
  "search.SearchResponse": page({ ...nodeDto, pathHint: "Documents" }),
  "search.RecentQuery": { limit: "10" },
  "search.RecentResponse": { items: [{ ...nodeDto, lastAccessedAt: AT }] },
  "search.StarredQuery": { cursor: "b3BhcXVl", limit: "200" },
  "search.StarredResponse": { items: [{ ...nodeDto, starred: true }], nextCursor: "b3BhcXVl" },

  "account.UsageDto": {
    usedBytes: 100,
    quotaBytes: 5_000_000_000,
    filesBytes: 70,
    trashBytes: 20,
    versionsBytes: 10,
    reservedBytes: 0,
  },
  "account.PrefsDto": prefs,
  "account.PatchPrefsBody": {
    density: "comfortable",
    theme: "dark",
    viewMode: "grid",
    emailShares: false,
    emailLinkDigest: true,
  },
  "account.ProfileDto": {
    displayName: "Ada",
    email: "ada@example.test",
    timezone: "Europe/Berlin",
    locale: "en",
    avatar: { nodeId: NODE, etag: "v1" },
  },
  "account.PatchProfileBody": { displayName: "Ada L.", timezone: "Europe/Berlin", locale: "en-GB" },
  "account.SessionDto": {
    id: OTHER_USER,
    current: true,
    createdAt: AT,
    lastActiveAt: AT,
    expiresAt: AT,
    uaLabel: "Chrome on macOS",
    country: null,
  },
  "account.ActivityDto": activity,
  "account.DeletionStatusDto": { scheduledFor: AT },
  "account.ExportManifest": {
    version: 1,
    exportedAt: AT,
    user: {
      id: USER,
      email: "ada@example.test",
      displayName: "Ada",
      createdAt: AT,
      timezone: null,
      locale: "en",
      quotaBytes: 5_000_000_000,
      usedBytes: 100,
      termsAcceptedAt: AT,
      termsVersion: "2026-10",
    },
    prefs,
    nodes: [
      {
        id: NODE,
        parentId: null,
        kind: "file",
        name: "report.pdf",
        size: 1234,
        mimeSniffed: "application/pdf",
        sha256: SHA,
        scanStatus: "clean",
        starred: false,
        createdAt: AT,
        updatedAt: AT,
        deletedAt: null,
      },
    ],
    shares: [{ nodeId: NODE, email: "friend@example.test", role: "viewer", canUpload: false, createdAt: AT }],
    sharedWithMe: [{ nodeId: PARENT, name: "Shared", role: "editor", ownerDisplayName: "Grace" }],
    links: [
      {
        id: ROW,
        nodeId: NODE,
        state: "active",
        expiresAt: null,
        hasPassword: false,
        maxDownloads: null,
        downloadCount: 0,
        createdAt: AT,
      },
    ],
    activity: [activity],
  },
  "account.PendingEmailBody": { email: "new@example.test" },
  "account.AcceptTermsBody": { version: "2026-10" },

  "report.ReportCategory": "phishing",
  "report.ReportBody": {
    nodeId: NODE,
    linkToken: "AbCdEfGhIjKlMnOpQrStUv",
    category: "malware",
    details: "It asked me to run a program.",
    reporterEmail: "reporter@example.test",
    turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
  },
  "report.ReportResponse": { received: true },

  "admin.AdminScanStatus": "suspected_csam",
  "admin.TakedownReason": "dmca",
  "admin.AdminNodeDto": adminNode,
  "admin.AdminUserDto": {
    id: USER,
    email: "ada@example.test",
    displayName: "Ada",
    role: "user",
    emailVerified: true,
    twoFactorEnabled: false,
    createdAt: AT,
    quotaBytes: 5_000_000_000,
    usedBytes: 100,
    banned: false,
    banReason: null,
    suspendedAt: AT,
    suspendedReason: "strikes",
    deleteScheduledAt: null,
    legalHold: false,
    activeStrikes: 3,
    lastActiveAt: AT,
  },
  "admin.AdminUserListQuery": { q: "ada", state: "suspended", cursor: "abc", limit: "25" },
  "admin.AdminUserPage": { items: [], nextCursor: "next" },
  "admin.SuspendUserBody": { reason: "Repeated abuse." },
  "admin.SetQuotaBody": { quotaBytes: 10_000_000_000 },
  "admin.SetLegalHoldBody": { held: true, note: "Preservation request 7." },
  "admin.StrikeKind": "malware",
  "admin.StrikeDto": {
    id: ROW,
    userId: USER,
    kind: "malware",
    reportId: null,
    nodeId: NODE,
    contentSha256: SHA,
    issuedBy: null,
    at: AT,
    note: null,
    liftedAt: null,
    liftedBy: null,
  },
  "admin.AddStrikeBody": { userId: USER, kind: "abuse", nodeId: NODE, reportId: ROW, note: "See report." },
  "admin.QuarantineItemDto": {
    node: { ...adminNode, scanStatus: "infected" },
    uploader: userRef,
    signatures: ["Win.Test.EICAR_HDB-1"],
    scannedAt: AT,
  },
  "admin.QuarantinePage": { items: [], nextCursor: null },
  "admin.QuarantineActionBody": { action: "rescan", note: "False positive?" },
  "admin.AdminRescanResponse": { queued: false, reason: "taken_down" },
  "admin.ReportStatus": "reviewing",
  "admin.ReportDto": reportDto,
  "admin.ReportListQuery": { status: "open", category: "csam", cursor: "abc", limit: "10" },
  "admin.ReportPage": page(reportDto),
  "admin.ReportActionBody": { action: "takedown", resolution: "Confirmed." },
  "admin.NcmecFiledBody": { reportId: "123456789", filedAt: AT },
  "admin.DmcaStatus": "counter_received",
  "admin.DmcaNoticeDto": dmcaNotice,
  "admin.DmcaNoticePage": page(dmcaNotice),
  "admin.CreateDmcaNoticeBody": {
    receivedVia: "form",
    complainantName: "A. Rights-Holder",
    complainantEmail: "legal@example.test",
    workDescription: "A photograph.",
    infringingDescription: "The file report.pdf.",
    statementGoodFaith: true,
    statementAccuracy: true,
    signature: "A. Rights-Holder",
    nodeIds: [NODE],
  },
  "admin.DmcaActionBody": { action: "takedown", checklist: { identification: true }, note: "Complete." },
  "admin.CounterNoticeBody": {
    counterName: "Ada",
    counterAddress: "2 Example Street",
    counterEmail: "ada@example.test",
    counterStatement: "The material is mine.",
    counterConsentJurisdiction: true,
    counterSignature: "Ada",
  },
  "admin.AdminLinkDto": {
    id: ROW,
    nodeId: NODE,
    node: { name: "report.pdf", kind: "file" },
    ownerId: USER,
    pauseReasons: ["ceiling", "report"],
    pausedAt: AT,
    lockedByAdmin: false,
    revokedAt: null,
    expiresAt: null,
    hasPassword: false,
    maxDownloads: null,
    downloadCount: 0,
    bytesServed: 0,
    createdAt: AT,
    lastAccessAt: null,
  },
  "admin.AdminLinkPage": { items: [], nextCursor: null },
  "admin.AdminLinkActionBody": { action: "lock" },
  "admin.InviteDto": {
    code: "HF-ABCD-EFGH",
    createdBy: USER,
    maxUses: 5,
    uses: 1,
    expiresAt: null,
    revokedAt: null,
    note: "beta",
    createdAt: AT,
  },
  "admin.InvitePage": { items: [], nextCursor: null },
  "admin.CreateInvitesBody": { count: 10, maxUses: 1, expiresAt: AT, note: "beta wave 2" },
  "admin.AuditEntryDto": {
    id: ROW,
    at: AT,
    actorUserId: USER,
    actorType: "admin",
    action: "account.suspended",
    targetType: "user",
    targetId: OTHER_USER,
    ua: "Chrome",
    country: "DE",
    requestId: "0199d3c2-7a10-7000-8000-0000000000ff",
    meta: { reason: "strikes" },
  },
  "admin.AuditQuery": {
    actorUserId: USER,
    action: "account.suspended",
    targetType: "user",
    targetId: OTHER_USER,
    from: AT,
    to: AT,
    cursor: "abc",
    limit: "100",
  },
  "admin.AuditPage": { items: [], nextCursor: null },
  "admin.CeilingOverrides": { CEIL_SHARES_DAY: 50, NEW_ACCOUNT_FACTOR: 0.5, signupIpDay: 3 },
  "admin.SettingsDto": {
    signupMode: "invite",
    uploadsEnabled: true,
    linksEnabled: true,
    readOnly: false,
    orphanDeleteEnabled: true,
    ceilings: { CEIL_LINKS_DAY: 20 },
    termsVersion: "2026-10",
  },
  "admin.PatchSettingsBody": { readOnly: true, ceilings: { signupDomainDay: 10 } },
  "admin.JobRunResponse": { done: false },
};

const modules = { common, node, upload, share, link, search, account, report, admin };
const isSchema = (value: unknown): value is z.ZodType => value instanceof z.ZodType;
const schemas = Object.entries(modules).flatMap(([moduleName, exports]) =>
  Object.entries(exports)
    .filter(([, value]) => isSchema(value))
    .map(([name, value]) => ({ key: `${moduleName}.${name}`, name, schema: value as z.ZodType })),
);
/** A strict object: its catch-all is `never`. */
const isStrictObject = (candidate: z.ZodType): candidate is z.ZodObject =>
  candidate instanceof z.ZodObject && candidate.def.catchall?._zod.def.type === "never";
/** The object shapes a schema can be: itself, or each option of a union of objects. */
const objectsOf = (candidate: z.ZodType): z.ZodType[] =>
  candidate instanceof z.ZodUnion ? (candidate.options as z.ZodType[]).flatMap(objectsOf) : [candidate];
const isObject = (candidate: z.ZodType): boolean =>
  objectsOf(candidate).every((option) => option instanceof z.ZodObject);
/** Strict all the way: a union is strict when every one of its options is. */
const isStrict = (candidate: z.ZodType): boolean => objectsOf(candidate).every(isStrictObject);

describe("every schema", () => {
  it("has a documented example here, and nothing here documents a schema that is gone", () => {
    expect(schemas.length).toBeGreaterThan(100);
    expect(schemas.map((entry) => entry.key).sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  it.each(schemas)("$key parses its example", ({ key, schema }) => {
    const parsed = schema.safeParse(EXAMPLES[key]);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("what a client sends is strict; what the server answers is not", () => {
    // `ErrorBody` is the body of an ANSWER, whatever its name ends in.
    const sent = schemas.filter(
      (entry) => /(Body|Query)$/.test(entry.name) && entry.key !== "common.ErrorBody",
    );
    const answered = schemas.filter(
      (entry) => /(Dto|Response|Manifest|Info|Page)$/.test(entry.name) || entry.key === "common.ErrorBody",
    );
    expect(sent.length).toBeGreaterThan(35);
    expect(answered.length).toBeGreaterThan(40);
    // The two endpoints that predate this file validate with non-strict schemas; these mirror them.
    const predating = ["account.PendingEmailBody", "account.AcceptTermsBody"];
    for (const { key, schema } of sent) {
      expect(isObject(schema), `${key} is an object`).toBe(true);
      expect(isStrict(schema), `${key} is strict`).toBe(!predating.includes(key));
    }
    for (const { key, schema } of answered) {
      if (schema instanceof z.ZodObject) expect(isStrictObject(schema), `${key} is not strict`).toBe(false);
    }
  });

  it.each(
    schemas.filter(
      (entry) => /(Body|Query)$/.test(entry.name) && isObject(entry.schema) && isStrict(entry.schema),
    ),
  )("$key rejects an unknown field", ({ key, schema }) => {
    const example = EXAMPLES[key] as Record<string, unknown>;
    // The control: without the extra field the same object parses.
    expect(schema.safeParse(example).success).toBe(true);
    const parsed = schema.safeParse({ ...example, notInTheContract: 1 });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("unrecognized_keys");
  });

  it("a strict object nested in a strict body is strict too (ceilings)", () => {
    expect(admin.PatchSettingsBody.safeParse({ ceilings: { CEIL_SHARES_DAY: 5 } }).success).toBe(true);
    for (const ceilings of [
      { CEIL_MADE_UP: 5 },
      { ceil_shares_day: 5 },
      { CEIL_SHARES_DAY: -1 },
      { CEIL_SHARES_DAY: "5" },
      // A limit is a whole number the ledger can hold exactly.
      { CEIL_SHARES_DAY: 1.5 },
      { CEIL_USER_BYTES_DAY: Number.MAX_SAFE_INTEGER + 2 },
      { CEIL_USER_BYTES_DAY: 1e300 },
      { CEIL_USER_BYTES_DAY: Number.POSITIVE_INFINITY },
      { NEW_ACCOUNT_DAYS: 0.5 },
      { signupIpDay: 2.5 },
      // The factor is a share: 0 to 1.
      { NEW_ACCOUNT_FACTOR: 1.01 },
      { NEW_ACCOUNT_FACTOR: -0.1 },
    ]) {
      expect(admin.PatchSettingsBody.safeParse({ ceilings }).success, JSON.stringify(ceilings)).toBe(false);
      expect(
        admin.SettingsDto.safeParse({ ...(EXAMPLES["admin.SettingsDto"] as object), ceilings }).success,
      ).toBe(false);
    }
    for (const ceilings of [
      { CEIL_USER_BYTES_DAY: Number.MAX_SAFE_INTEGER },
      { CEIL_USER_BYTES_DAY: 0 },
      { NEW_ACCOUNT_FACTOR: 0 },
      { NEW_ACCOUNT_FACTOR: 1 },
      { NEW_ACCOUNT_FACTOR: 0.25 },
    ]) {
      expect(admin.PatchSettingsBody.safeParse({ ceilings }).success, JSON.stringify(ceilings)).toBe(true);
    }
    expect(Object.keys(admin.CeilingOverrides.shape).sort()).toEqual([...constants.CEILING_KEYS].sort());
    expect(constants.CEILING_KEYS).toHaveLength(18);
  });

  it("an unknown field in an answer is dropped, not refused", () => {
    const parsed = node.NodeDto.parse({ ...nodeDto, r2Key: "u/x/y/z", ownerEmail: "ada@example.test" });
    expect(parsed).not.toHaveProperty("r2Key");
    expect(parsed).not.toHaveProperty("ownerEmail");
    expect(Object.keys(node.NodeDto.shape)).not.toContain("r2Key");
  });
});

describe("ids", () => {
  it("UserId is the auth library's id shape, never a UUID; NodeId is a UUID", () => {
    const pattern = common.UserId.def.checks?.map(
      (check) => (check as unknown as { _zod: { def: { pattern?: RegExp } } })._zod.def.pattern,
    );
    expect(pattern?.[0]?.source).toBe(BA_ID.source);
    const v7 = uuidv7();
    expect(v7).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(common.UserId.safeParse(v7).success).toBe(false);
    expect(common.NodeId.safeParse(v7).success).toBe(true);
    expect(common.RowId.safeParse(v7).success).toBe(true);
    expect(common.UserId.safeParse(USER).success).toBe(true);
    expect(common.NodeId.safeParse(USER).success).toBe(false);
    for (const bad of ["", USER.slice(1), `${USER}x`, `${USER.slice(0, 31)}-`, 7, null]) {
      expect(common.UserId.safeParse(bad).success, String(bad)).toBe(false);
      expect(common.SessionId.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("every field that holds a user id refuses a UUID, and every node id refuses a user id", () => {
    const uuid = uuidv7();
    expect(common.UserRef.safeParse({ id: uuid, displayName: "x" }).success).toBe(false);
    expect(node.NodeDto.safeParse({ ...nodeDto, owner: { id: uuid, displayName: "x" } }).success).toBe(false);
    expect(node.NodeDto.safeParse({ ...nodeDto, id: USER }).success).toBe(false);
    expect(admin.AddStrikeBody.safeParse({ userId: uuid, kind: "abuse" }).success).toBe(false);
    expect(admin.AuditQuery.safeParse({ actorUserId: uuid }).success).toBe(false);
    expect(
      account.SessionDto.safeParse({ ...(EXAMPLES["account.SessionDto"] as object), id: uuid }).success,
    ).toBe(false);
    for (const field of ["ownerId", "reporterUserId", "assignedTo"]) {
      expect(admin.ReportDto.safeParse({ ...reportDto, [field]: uuid }).success, field).toBe(false);
    }
    for (const field of ["userId", "issuedBy", "liftedBy"]) {
      expect(
        admin.StrikeDto.safeParse({ ...(EXAMPLES["admin.StrikeDto"] as object), [field]: uuid }).success,
        field,
      ).toBe(false);
    }
  });
});

describe("vocabularies that exist in two places", () => {
  it("MimeCategory is exactly the keys of MIME_CATEGORIES", () => {
    expect(common.MimeCategory.options).toEqual(Object.keys(constants.MIME_CATEGORIES));
    expect(common.MimeCategory.options).toEqual([
      "image",
      "video",
      "audio",
      "pdf",
      "document",
      "archive",
      "code",
      "other",
    ]);
    expect(common.MimeCategory.safeParse("doc").success).toBe(false);
  });

  it("ScanStatus is the database's enum without suspected_csam; the admin one has it", () => {
    const stored = [...schema.scanStatus.enumValues];
    expect([...common.ScanStatus.options].sort()).toEqual(
      stored.filter((s) => s !== "suspected_csam").sort(),
    );
    expect(common.ScanStatus.safeParse("suspected_csam").success).toBe(false);
    expect(node.NodeDto.safeParse({ ...nodeDto, scanStatus: "suspected_csam" }).success).toBe(false);
    expect([...admin.AdminScanStatus.options].sort()).toEqual(stored.sort());
  });

  it("the other enums equal the database's", () => {
    expect(common.ScanReason.options).toEqual([...schema.SCAN_REASONS]);
    expect(report.ReportCategory.options).toEqual(schema.reportCategory.enumValues);
    expect(admin.ReportStatus.options).toEqual(schema.reportStatus.enumValues);
    expect(admin.DmcaStatus.options).toEqual(schema.dmcaStatus.enumValues);
    expect(admin.TakedownReason.options).toEqual(schema.takedownReason.enumValues);
    expect(admin.StrikeKind.options).toEqual(schema.strikeKind.enumValues);
    expect(share.ShareRole.options).toEqual(schema.shareRole.enumValues);
    expect(node.NodeKind.options).toEqual(schema.nodeKind.enumValues);
    expect(admin.AdminLinkDto.shape.pauseReasons.element.options).toEqual([...schema.PAUSE_REASONS]);
    expect(admin.AuditEntryDto.shape.actorType.options).toEqual(schema.auditActor.enumValues);
    expect(admin.ReportDto.shape.source.options).toEqual(schema.reportSource.enumValues);
    expect(admin.DmcaNoticeDto.shape.receivedVia.options).toEqual(schema.dmcaReceivedVia.enumValues);
    expect(account.PrefsDto.shape.density.options).toEqual(schema.prefDensity.enumValues);
    expect(account.PrefsDto.shape.theme.options).toEqual(schema.prefTheme.enumValues);
    expect(account.PrefsDto.shape.viewMode.options).toEqual(schema.prefViewMode.enumValues);
    expect(upload.InitUploadBody.shape.purpose.options).toEqual(schema.uploadPurpose.enumValues);
  });

  it("DmcaNoticeDto mirrors dmca_notices column for column, StrikeDto the strikes table", () => {
    const columns = Object.keys(getTableColumns(schema.dmcaNotices));
    expect(Object.keys(admin.DmcaNoticeDto.shape).filter((key) => key !== "nodes")).toEqual(columns);
    expect(Object.keys(admin.DmcaNoticeDto.shape.nodes.element.shape).sort()).toEqual(
      Object.keys(getTableColumns(schema.dmcaNoticeNodes))
        .filter((key) => key !== "noticeId")
        .sort(),
    );
    expect(Object.keys(admin.StrikeDto.shape).sort()).toEqual(
      Object.keys(getTableColumns(schema.strikes)).sort(),
    );
    expect(Object.keys(admin.InviteDto.shape).sort()).toEqual(
      Object.keys(getTableColumns(schema.invites)).sort(),
    );
  });

  it("constants that also live in the query layer hold the same value", () => {
    expect(constants.SCAN_CLAIM_STALE_MINUTES).toBe(scanJobs.SCAN_CLAIM_STALE_MINUTES);
    expect(constants.PASSWORD_FREE_ATTEMPTS).toBe(linksQuery.PASSWORD_FREE_ATTEMPTS);
    expect(constants.PASSWORD_LOCK_MAX_SEC).toBe(linksQuery.PASSWORD_LOCK_MAX_SEC);
    expect(constants.VERSION_RETENTION_DAYS).toBe(nodesQuery.VERSION_RETENTION_DAYS);
  });
});

describe("the error table equals PLAN §10", () => {
  // The table of PLAN §10, row for row.
  const PLAN_10: Record<string, number> = {
    validation: 400,
    unauthorized: 401,
    forbidden: 403,
    terms_required: 403,
    not_found: 404,
    conflict: 409,
    scan_pending: 409,
    scan_blocked: 403,
    quota_exceeded: 413,
    file_too_large: 413,
    ceiling_exceeded: 429,
    rate_limited: 429,
    invalid_token: 403,
    link_expired: 410,
    link_paused: 423,
    password_required: 403,
    admin_requires_2fa: 403,
    read_only: 503,
    feature_disabled: 503,
  };
  // In src/shared/errors.ts and NOT in PLAN §10: added by the auth security pass. Reported.
  const NOT_IN_THE_PLAN: Record<string, number> = {
    second_factor_required: 403,
    second_factor_throttled: 429,
  };

  it("every row of the plan is in the table with its status", () => {
    expect(Object.keys(PLAN_10)).toHaveLength(19);
    for (const [code, status] of Object.entries(PLAN_10)) {
      expect((ERROR_STATUS as Record<string, number>)[code], code).toBe(status);
    }
    expect(ERROR_STATUS.password_required).toBe(403);
    expect(ERROR_STATUS.terms_required).toBe(403);
    expect(ERROR_STATUS.feature_disabled).toBe(503);
    // 401 has one meaning.
    expect(Object.entries(ERROR_STATUS).filter(([, status]) => status === 401)).toEqual([
      ["unauthorized", 401],
    ]);
  });

  it("the table has nothing else — except the two codes known to be missing from the plan", () => {
    expect(ERROR_STATUS).toEqual({ ...PLAN_10, ...NOT_IN_THE_PLAN });
    expect([...common.ErrorCode.options].sort()).toEqual(Object.keys(ERROR_STATUS).sort());
  });
});

describe("PublicConfig", () => {
  it("is the worker core's one object, with its fourteen fields", () => {
    expect(ClientPublicConfig).toBe(PublicConfig);
    expect(Object.keys(PublicConfig.shape)).toEqual([
      "signupMode",
      "quotaBytes",
      "maxFileBytes",
      "partBytes",
      "turnstileSiteKey",
      "appOrigin",
      "filesOrigin",
      "termsVersion",
      "uploadsEnabled",
      "linksEnabled",
      "readOnly",
      "sentryDsnWeb",
      "sentryEnvironment",
      "release",
    ]);
    // The route imports it from the same file; nothing under schemas/ defines another.
    expect(publicRoute).toMatch(/from "\.\.\/\.\.\/shared\/public-config"/);
    for (const exports of Object.values(modules)) expect(exports).not.toHaveProperty("PublicConfig");
  });
});

describe("the two bodies that predate this file", () => {
  it("the routes' local schemas are still exactly the shapes mirrored here", () => {
    // The local schemas are module-private: their source text is what can be held to.
    expect(acceptTermsRoute).toContain(
      "const AcceptTermsBody = z.object({ version: z.string().min(1).max(64) });",
    );
    expect(pendingEmailRoute).toContain("const Body = z.object({ email: z.email().max(254) });");
  });

  it("the shared schemas decide the same way", () => {
    const local = {
      AcceptTermsBody: z.object({ version: z.string().min(1).max(64) }),
      PendingEmailBody: z.object({ email: z.email().max(254) }),
    };
    const inputs: unknown[] = [
      {},
      null,
      "text",
      { version: "2026-10" },
      { version: "" },
      { version: "v".repeat(64) },
      { version: "v".repeat(65) },
      { version: 7 },
      { version: "2026-10", extra: true },
      { email: "ada@example.test" },
      { email: "ADA@Example.TEST" },
      { email: "not an address" },
      { email: "" },
      { email: `${"a".repeat(64)}@${"b".repeat(185)}.test` },
      { email: `${"a".repeat(64)}@${"b".repeat(186)}.test` },
      { email: "ada@example.test", extra: true },
      { email: 7 },
    ];
    for (const input of inputs) {
      for (const name of ["AcceptTermsBody", "PendingEmailBody"] as const) {
        const mine = account[name].safeParse(input);
        const theirs = local[name].safeParse(input);
        expect(mine.success, `${name} ${JSON.stringify(input)}`).toBe(theirs.success);
        if (mine.success && theirs.success) expect(mine.data).toEqual(theirs.data);
      }
    }
  });
});

describe("constants", () => {
  it("the part sizes fit each other and the request-body limit", () => {
    expect(constants.PART_BYTES).toBeLessThanOrEqual(constants.MAX_PART_BYTES);
    expect(constants.SINGLE_PUT_MAX).toBeLessThanOrEqual(constants.MAX_PART_BYTES);
    expect(constants.MAX_PART_BYTES).toBeLessThan(100_000_000);
    expect(Math.ceil(2_000_000_000 / constants.PART_BYTES)).toBe(30);
    expect(2_000_000_000 - 29 * constants.PART_BYTES).toBe(53_842_944);
    expect(constants.MIN_PART_BYTES).toBe(5 * 1024 * 1024);
    expect(constants.PART_BYTES).toBeGreaterThanOrEqual(constants.MIN_PART_BYTES);
    expect(constants.PART_BYTES * constants.MAX_PARTS).toBeGreaterThan(constants.MAX_FILE_BYTES_DEFAULT);
  });

  it("has the documented values", () => {
    expect(constants).toMatchObject({
      MAX_FILE_BYTES_DEFAULT: 2_000_000_000,
      PART_BYTES: 67_108_864,
      MAX_PART_BYTES: 67_108_864,
      SINGLE_PUT_MAX: 67_108_864,
      MIN_PART_BYTES: 5_242_880,
      MAX_PARTS: 10_000,
      MAX_OPEN_UPLOADS: 20,
      AVATAR_MAX_BYTES: 5_000_000,
      THUMB_SIZES: [160, 320, 1280],
      THUMB_INPUT_MAX_BYTES: 20_000_000,
      PREVIEW_TEXT_MAX_BYTES: 2_000_000,
      PDF_PREVIEW_MAX_BYTES: 50_000_000,
      IMAGE_PREVIEW_MAX_BYTES: 50_000_000,
      ZIP_URL_BATCH: 50,
      ZIP_MAX_ENTRIES: 10_000,
      TOKEN_TTL: { download: 300, inline: 900, thumb: 600, zip: 900 },
      LINK_TOKEN_BYTES: 16,
      PASSWORD_FREE_ATTEMPTS: 3,
      PASSWORD_LOCK_MAX_SEC: 900,
      STRIKES_TO_SUSPEND: 3,
      STRIKE_WINDOW_DAYS: 365,
      TRASH_RETENTION_DAYS: 30,
      VERSION_RETENTION_DAYS: 30,
      SCAN_CLAIM_STALE_MINUTES: 20,
      HEADER_WARNING: "X-Holdfast-Warning",
      HEADER_LINK_SESSION: "X-Holdfast-Link-Session",
    });
  });

  it("the limits in the schemas are the constants", () => {
    const ids = (n: number) => Array.from({ length: n }, () => NODE);
    expect(node.BatchDownloadUrlsBody.safeParse({ nodeIds: ids(constants.ZIP_URL_BATCH) }).success).toBe(
      true,
    );
    expect(node.BatchDownloadUrlsBody.safeParse({ nodeIds: ids(constants.ZIP_URL_BATCH + 1) }).success).toBe(
      false,
    );
    expect(node.BatchDownloadUrlsBody.safeParse({ nodeIds: [] }).success).toBe(false);
    expect(node.ZipManifestBody.safeParse({ nodeIds: ids(100) }).success).toBe(true);
    expect(node.ZipManifestBody.safeParse({ nodeIds: ids(101) }).success).toBe(false);
    expect(node.ListChildrenQuery.parse({})).toEqual({ sort: "name", dir: "asc", limit: 100 });
    expect(node.ListChildrenQuery.safeParse({ limit: "201" }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "a" }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "ab", limit: "51" }).success).toBe(false);
    expect(search.SearchQuery.safeParse({ q: "ab", category: "doc" }).success).toBe(false);
    expect(search.SearchQuery.parse({ q: "ab" })).toEqual({ q: "ab", scope: "all", limit: 20 });
    for (const size of constants.THUMB_SIZES) {
      expect(link.PublicDownloadUrlBody.safeParse({ kind: "thumb", size }).success).toBe(true);
    }
    expect(link.PublicDownloadUrlBody.safeParse({ kind: "thumb", size: 640 }).success).toBe(false);
  });
});

describe("a link's pause reasons, as its owner is told", () => {
  it("maps the stored set without leaking it: de-duplicated, in a fixed order", () => {
    const cases: [string[], string[]][] = [
      [[], []],
      [["ceiling"], ["traffic"]],
      [["anomaly", "ceiling"], ["traffic"]],
      [["report"], ["review"]],
      [["moderation", "report"], ["review"]],
      [["owner_deletion"], ["account"]],
      [["owner_suspended", "owner_deletion"], ["account"]],
      [["owner"], ["owner"]],
      [
        ["owner", "owner_suspended", "moderation", "anomaly"],
        ["traffic", "review", "account", "owner"],
      ],
      [["something_new"], ["review"]],
    ];
    for (const [stored, shown] of cases) {
      expect(link.publicPauseReasons(stored), stored.join(",")).toEqual(shown);
      expect(z.array(link.LinkPauseReason).safeParse(link.publicPauseReasons(stored)).success).toBe(true);
    }
    // Every stored reason has a mapping of its own.
    for (const reason of schema.PAUSE_REASONS) expect(link.publicPauseReasons([reason])).toHaveLength(1);
    expect(link.LinkPauseReason.safeParse("moderation").success).toBe(false);
  });

  it("canUnpause: paused, only reasons the owner can clear, and not locked", () => {
    expect(link.ownerCanUnpause(["owner"], false)).toBe(true);
    expect(link.ownerCanUnpause(["ceiling", "owner"], false)).toBe(true);
    expect(link.ownerCanUnpause(["ceiling"], false)).toBe(true);
    // An abuse pause is not the owner's to clear — alone or beside their own.
    expect(link.ownerCanUnpause(["anomaly"], false)).toBe(false);
    expect(link.ownerCanUnpause(["owner", "anomaly"], false)).toBe(false);
    expect(link.ownerCanUnpause(["ceiling", "anomaly", "owner"], false)).toBe(false);
    // …though it is still SHOWN to the owner as traffic.
    expect(link.publicPauseReasons(["anomaly"])).toEqual(["traffic"]);
    expect(link.ownerCanUnpause([], false)).toBe(false);
    expect(link.ownerCanUnpause(["owner"], true)).toBe(false);
    for (const blocking of [
      "anomaly",
      "report",
      "moderation",
      "owner_deletion",
      "owner_suspended",
      "something_new",
    ]) {
      expect(link.ownerCanUnpause(["owner", blocking], false), blocking).toBe(false);
      expect(link.ownerCanUnpause([blocking], false), blocking).toBe(false);
    }
  });
});

describe("shapes that say exactly what their comment says", () => {
  it("PublicDownloadUrlBody: a size exactly when the kind is thumb", () => {
    const ok = (body: unknown) => link.PublicDownloadUrlBody.safeParse(body).success;
    for (const size of constants.THUMB_SIZES) expect(ok({ kind: "thumb", size })).toBe(true);
    expect(ok({ kind: "thumb", size: 320, nodeId: NODE })).toBe(true);
    expect(ok({ kind: "download" })).toBe(true);
    expect(ok({ kind: "inline", nodeId: NODE })).toBe(true);
    expect(ok({ kind: "download", dangerousAck: true, zipGrant: "payload.signature" })).toBe(true);
    // A thumbnail without its size, and a size with anything else.
    expect(ok({ kind: "thumb" })).toBe(false);
    expect(ok({ kind: "thumb", size: 640 })).toBe(false);
    expect(ok({ kind: "download", size: 320 })).toBe(false);
    expect(ok({ kind: "inline", size: 160 })).toBe(false);
    // A thumbnail carries nothing that belongs to a download.
    expect(ok({ kind: "thumb", size: 160, zipGrant: "payload.signature" })).toBe(false);
    expect(ok({ kind: "thumb", size: 160, dangerousAck: true })).toBe(false);
    expect(ok({ kind: "zip" })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it("ZipManifestBody: a list of nodes, or allOwned alone", () => {
    const ok = (body: unknown) => node.ZipManifestBody.safeParse(body).success;
    expect(ok({ allOwned: true })).toBe(true);
    expect(ok({ nodeIds: [NODE] })).toBe(true);
    expect(ok({ nodeIds: [NODE], allOwned: false })).toBe(true);
    expect(ok({ nodeIds: [NODE], allOwned: true })).toBe(false);
    expect(ok({ nodeIds: [], allOwned: true })).toBe(false);
    expect(ok({ allOwned: false })).toBe(false);
    expect(ok({ nodeIds: [] })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it("the public zip manifest has the same entry maximum as the signed-in one", () => {
    const entries = (n: number) => Array.from({ length: n }, () => zipEntry);
    const publicManifest = (n: number) =>
      link.PublicZipManifest.safeParse({
        entries: entries(n),
        totalBytes: 0,
        skipped: [],
        truncated: true,
        zipGrant: "g",
      }).success;
    const ownManifest = (n: number) =>
      node.ZipManifest.safeParse({ entries: entries(n), totalBytes: 0, skipped: [], truncated: true })
        .success;
    expect(publicManifest(constants.ZIP_MAX_ENTRIES)).toBe(true);
    expect(publicManifest(constants.ZIP_MAX_ENTRIES + 1)).toBe(false);
    expect(ownManifest(constants.ZIP_MAX_ENTRIES)).toBe(true);
    expect(ownManifest(constants.ZIP_MAX_ENTRIES + 1)).toBe(false);
  });

  it("a link's activity shows owner-visible outcomes only: the internal reasons fold into `refused`", () => {
    expect(link.LinkOutcome.options).toEqual(["ok", "password", "expired", "limit", "paused", "refused"]);
    expect(schema.linkOutcome.enumValues.map((stored) => [stored, link.publicLinkOutcome(stored)])).toEqual([
      ["ok", "ok"],
      ["denied_password", "password"],
      ["denied_expired", "expired"],
      ["denied_cap", "limit"],
      ["denied_paused", "paused"],
      ["denied_scan", "refused"],
      ["denied_owner", "refused"],
    ]);
    for (const unknown of ["denied_something_new", "", "constructor", "__proto__"]) {
      expect(link.publicLinkOutcome(unknown), unknown).toBe("refused");
    }
    // Two stored reasons that fold into one are summed.
    expect(link.publicLinkOutcomes({ ok: 5, denied_scan: 2, denied_owner: 3, denied_password: 1 })).toEqual({
      ok: 5,
      refused: 5,
      password: 1,
    });
    const activity = (outcomes: unknown) =>
      link.LinkActivityDto.safeParse({ days: [], countries: [], outcomes }).success;
    expect(activity(link.publicLinkOutcomes({ ok: 5, denied_scan: 2, denied_owner: 3 }))).toBe(true);
    expect(activity({})).toBe(true);
    // A stored name cannot be put in the DTO.
    for (const stored of ["denied_scan", "denied_owner", "denied_password"]) {
      expect(activity({ ok: 1, [stored]: 1 }), stored).toBe(false);
    }
  });

  it("a change with nothing in it is refused", () => {
    const bodies: [string, z.ZodType, Record<string, unknown>][] = [
      ["RenameBody", node.RenameBody, { starred: false }],
      ["PatchShareBody", share.PatchShareBody, { canUpload: false }],
      ["PatchLinkBody", link.PatchLinkBody, { password: null }],
      ["PatchPrefsBody", account.PatchPrefsBody, { emailShares: false }],
    ];
    for (const [name, body, one] of bodies) {
      expect(body.safeParse({}).success, `${name} {}`).toBe(false);
      expect(body.safeParse({}).error?.issues[0]?.message, name).toBe("Nothing to change.");
      // The control: one field — also a false, also a null — is a change.
      expect(body.safeParse(one).success, `${name} ${JSON.stringify(one)}`).toBe(true);
      // And still strict.
      expect(body.safeParse({ ...one, notInTheContract: 1 }).success, name).toBe(false);
    }
  });
});
