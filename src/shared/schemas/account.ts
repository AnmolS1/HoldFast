// The account: usage, preferences, profile, sessions, activity, deletion and the data export.

import { z } from "zod";
import { Bytes, Email, NodeId, RowId, ScanStatus, SessionId, Sha256, Timestamp, UserId } from "./common";
import { LinkState } from "./link";
import { hasAField, NodeKind, NOTHING_TO_CHANGE } from "./node";
import { ShareRole } from "./share";

/** `usedBytes` is the sum of the four parts. */
export const UsageDto = z.object({
  usedBytes: Bytes,
  quotaBytes: Bytes,
  filesBytes: Bytes,
  trashBytes: Bytes,
  versionsBytes: Bytes,
  reservedBytes: Bytes,
});
export type UsageDto = z.infer<typeof UsageDto>;

/** `emailSecurity` cannot be switched off. */
export const PrefsDto = z.object({
  density: z.enum(["compact", "comfortable"]),
  theme: z.enum(["system", "light", "dark"]),
  viewMode: z.enum(["list", "grid"]),
  emailShares: z.boolean(),
  emailLinkDigest: z.boolean(),
  emailSecurity: z.literal(true),
});
export type PrefsDto = z.infer<typeof PrefsDto>;

export const PatchPrefsBody = z
  .strictObject({
    density: PrefsDto.shape.density.optional(),
    theme: PrefsDto.shape.theme.optional(),
    viewMode: PrefsDto.shape.viewMode.optional(),
    emailShares: z.boolean().optional(),
    emailLinkDigest: z.boolean().optional(),
  })
  .refine(hasAField, NOTHING_TO_CHANGE);
export type PatchPrefsBody = z.infer<typeof PatchPrefsBody>;

/** The caller's own profile (so it carries their own email). The time zone lives here, not in prefs. */
export const ProfileDto = z.object({
  displayName: z.string(),
  email: z.string(),
  timezone: z.string().nullable(),
  locale: z.string(),
  avatar: z.object({ nodeId: NodeId, etag: z.string() }).nullable(),
});
export type ProfileDto = z.infer<typeof ProfileDto>;

export const PatchProfileBody = z.strictObject({
  displayName: z.string().min(1).max(80).optional(),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().min(2).max(35).optional(),
});
export type PatchProfileBody = z.infer<typeof PatchProfileBody>;

/** Never an IP address, never the session token. `uaLabel`: "Chrome on macOS". */
export const SessionDto = z.object({
  id: SessionId,
  current: z.boolean(),
  createdAt: Timestamp,
  lastActiveAt: Timestamp,
  expiresAt: Timestamp,
  uaLabel: z.string(),
  country: z.string().nullable(),
});
export type SessionDto = z.infer<typeof SessionDto>;

/** `action` is the audit action, e.g. "auth.sign_in". */
export const ActivityDto = z.object({
  id: RowId,
  at: Timestamp,
  action: z.string(),
  outcome: z.enum(["ok", "failed"]),
  uaLabel: z.string().nullable(),
  country: z.string().nullable(),
});
export type ActivityDto = z.infer<typeof ActivityDto>;

/** `GET /api/account/deletion-status`. It never mentions a hold. */
export const DeletionStatusDto = z.object({ scheduledFor: Timestamp.nullable() });
export type DeletionStatusDto = z.infer<typeof DeletionStatusDto>;

/** No secrets, no link URLs, no avatar and no hidden nodes. */
export const ExportManifest = z.object({
  version: z.literal(1),
  exportedAt: Timestamp,
  user: z.object({
    id: UserId,
    email: z.string(),
    displayName: z.string(),
    createdAt: Timestamp,
    timezone: z.string().nullable(),
    locale: z.string(),
    quotaBytes: Bytes,
    usedBytes: Bytes,
    termsAcceptedAt: Timestamp.nullable(),
    termsVersion: z.string().nullable(),
  }),
  prefs: PrefsDto,
  nodes: z.array(
    z.object({
      id: NodeId,
      parentId: NodeId.nullable(),
      kind: NodeKind,
      name: z.string(),
      size: Bytes,
      mimeSniffed: z.string().nullable(),
      sha256: Sha256.nullable(),
      scanStatus: ScanStatus,
      starred: z.boolean(),
      createdAt: Timestamp,
      updatedAt: Timestamp,
      deletedAt: Timestamp.nullable(),
    }),
  ),
  shares: z.array(
    z.object({
      nodeId: NodeId,
      email: z.string(),
      role: ShareRole,
      canUpload: z.boolean(),
      createdAt: Timestamp,
    }),
  ),
  sharedWithMe: z.array(
    z.object({ nodeId: NodeId, name: z.string(), role: ShareRole, ownerDisplayName: z.string() }),
  ),
  links: z.array(
    z.object({
      id: RowId,
      nodeId: NodeId,
      state: LinkState,
      expiresAt: Timestamp.nullable(),
      hasPassword: z.boolean(),
      maxDownloads: z.number().int().positive().nullable(),
      downloadCount: z.number().int().nonnegative(),
      createdAt: Timestamp,
    }),
  ),
  activity: z.array(ActivityDto),
});
export type ExportManifest = z.infer<typeof ExportManifest>;

// The two bodies below belong to endpoints that were written before this file existed and
// validate with local schemas of exactly these shapes (a test holds the two to each other).
// They are NOT strict, because those are not.

/** `PATCH /api/account/pending-email`. */
export const PendingEmailBody = z.object({ email: Email });
export type PendingEmailBody = z.infer<typeof PendingEmailBody>;

/** `POST /api/account/accept-terms`. */
export const AcceptTermsBody = z.object({ version: z.string().min(1).max(64) });
export type AcceptTermsBody = z.infer<typeof AcceptTermsBody>;
