// Public links: what the owner manages, and what the public page is told.

import { z } from "zod";
import { THUMB_SIZES } from "../constants";
import { Bytes, MimeCategory, NodeId, Page, PathToken, RowId, Timestamp } from "./common";
import { DownloadUrlResponse, NodeKind, ZipEntry } from "./node";

export const LinkState = z.enum(["active", "paused", "expired", "revoked", "limit_reached", "locked"]);
export type LinkState = z.infer<typeof LinkState>;

/** Why a link is paused, as its owner is told. The stored reasons are more, and are not shown. */
export const LinkPauseReason = z.enum(["traffic", "review", "account", "owner"]);
export type LinkPauseReason = z.infer<typeof LinkPauseReason>;

const PAUSE_REASON_ORDER = LinkPauseReason.options;
const SHOWN_AS: Record<string, LinkPauseReason> = {
  ceiling: "traffic",
  anomaly: "traffic",
  report: "review",
  moderation: "review",
  owner_deletion: "account",
  owner_suspended: "account",
  owner: "owner",
};
/** The stored reasons the owner's own "resume" can clear. */
const OWNER_CLEARABLE = ["owner", "ceiling", "anomaly"];

/**
 * The stored pause-reason set of a link as `LinkDto.pausedReasons`: mapped, de-duplicated, in the
 * fixed order traffic, review, account, owner. Empty when the link is not paused. A stored
 * reason this file does not know is shown as `review` (it is not the owner's to clear).
 */
export function publicPauseReasons(stored: readonly string[]): LinkPauseReason[] {
  const shown = new Set(stored.map((reason) => SHOWN_AS[reason] ?? "review"));
  return PAUSE_REASON_ORDER.filter((reason) => shown.has(reason));
}

/**
 * `LinkDto.canUnpause`: the link is paused, every stored reason is one the owner can clear, and
 * an admin has not locked it — so a resume always brings the link back.
 */
export function ownerCanUnpause(stored: readonly string[], lockedByAdmin: boolean): boolean {
  return !lockedByAdmin && stored.length > 0 && stored.every((reason) => OWNER_CLEARABLE.includes(reason));
}

/**
 * `url` is the full public URL, derived again from the sealed token on every owner read, so
 * "Copy link" works later. It is `null` for an impersonated session.
 */
export const LinkDto = z.object({
  id: RowId,
  nodeId: NodeId,
  node: z.object({ name: z.string(), kind: NodeKind }),
  url: z.string().nullable(),
  state: LinkState,
  pausedReasons: z.array(LinkPauseReason),
  canUnpause: z.boolean(),
  expiresAt: Timestamp.nullable(),
  hasPassword: z.boolean(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: z.number().int().nonnegative(),
  bytesServed: Bytes,
  allowPreview: z.boolean(),
  createdAt: Timestamp,
  lastAccessAt: Timestamp.nullable(),
});
export type LinkDto = z.infer<typeof LinkDto>;

const LinkPassword = z.string().min(8).max(256);

export const CreateLinkBody = z.strictObject({
  expiresAt: Timestamp.optional(),
  password: LinkPassword.optional(),
  maxDownloads: z.number().int().positive().optional(),
  allowPreview: z.boolean(),
});
export type CreateLinkBody = z.infer<typeof CreateLinkBody>;

/** `null` removes a password or a download limit. `paused` is the owner's own pause. */
export const PatchLinkBody = z.strictObject({
  expiresAt: Timestamp.nullable().optional(),
  password: LinkPassword.nullable().optional(),
  maxDownloads: z.number().int().positive().nullable().optional(),
  allowPreview: z.boolean().optional(),
  paused: z.boolean().optional(),
});
export type PatchLinkBody = z.infer<typeof PatchLinkBody>;

/** No addresses and no hashes: days, countries and outcomes only. */
export const LinkActivityDto = z.object({
  days: z.array(z.object({ day: z.iso.date(), downloads: z.number().int().nonnegative(), bytes: Bytes })),
  countries: z.array(z.object({ country: z.string(), downloads: z.number().int().nonnegative() })),
  outcomes: z.record(z.string(), z.number().int().nonnegative()),
});
export type LinkActivityDto = z.infer<typeof LinkActivityDto>;

// ── the public page ─────────────────────────────────────────────────────────────────────────
// Every `/api/public/links/:token/*` call carries the link session in the
// `X-Holdfast-Link-Session` header (the folder listing is a GET: it cannot be a body field).

export const PublicNodeDto = z.object({
  id: NodeId,
  name: z.string(),
  kind: NodeKind,
  size: Bytes,
  mimeCategory: MimeCategory,
  ext: z.string(),
  thumb: z.boolean(),
});
export type PublicNodeDto = z.infer<typeof PublicNodeDto>;

/** `node` is null until the password is satisfied. `dangerous`: show the warning page first. */
export const PublicLinkInfo = z.object({
  requiresPassword: z.boolean(),
  node: PublicNodeDto.nullable(),
  allowPreview: z.boolean(),
  dangerous: z.boolean(),
});
export type PublicLinkInfo = z.infer<typeof PublicLinkInfo>;

export const PublicChildrenResponse = Page(PublicNodeDto);
export type PublicChildrenResponse = z.infer<typeof PublicChildrenResponse>;

/**
 * A wrong password answers `403 password_required` with `details { wrongPassword: true,
 * retryAfterSec }`; a call during a delay answers `429 rate_limited` and does not look at the
 * password.
 */
export const UnlockBody = z.strictObject({ password: z.string().min(1).max(256) });
export type UnlockBody = z.infer<typeof UnlockBody>;

export const UnlockResponse = z.object({ linkSession: z.string(), expiresAt: Timestamp });
export type UnlockResponse = z.infer<typeof UnlockResponse>;

/**
 * `nodeId` is absent for a link on a single file. `size` goes with `kind: "thumb"`.
 * `zipGrant`: a `download` mint carrying a valid grant does not count as another download.
 * Answered with a `DownloadUrlResponse`.
 */
export const PublicDownloadUrlBody = z.strictObject({
  nodeId: NodeId.optional(),
  kind: z.enum(["download", "inline", "thumb"]),
  size: z.union(THUMB_SIZES.map((size) => z.literal(size))).optional(),
  dangerousAck: z.boolean().optional(),
  zipGrant: z.string().min(1).max(2048).optional(),
});
export type PublicDownloadUrlBody = z.infer<typeof PublicDownloadUrlBody>;

export const PublicDownloadUrlResponse = DownloadUrlResponse;
export type PublicDownloadUrlResponse = z.infer<typeof PublicDownloadUrlResponse>;

/** A public visitor is told ONE reason for every entry left out, never why. */
export const PublicZipSkipped = z.object({
  nodeId: NodeId,
  path: z.string(),
  reason: z.literal("unavailable"),
});
export type PublicZipSkipped = z.infer<typeof PublicZipSkipped>;

/**
 * `POST /api/public/links/:token/zip-manifest`. One zip counts as ONE download: this call
 * consumes it and issues `zipGrant`; the per-file URL mints then carry the grant.
 */
export const PublicZipManifest = z.object({
  entries: z.array(ZipEntry),
  totalBytes: Bytes,
  skipped: z.array(PublicZipSkipped),
  truncated: z.boolean(),
  zipGrant: z.string(),
});
export type PublicZipManifest = z.infer<typeof PublicZipManifest>;

/** The link token of a path or a body. */
export const LinkToken = PathToken;
export type LinkToken = z.infer<typeof LinkToken>;
