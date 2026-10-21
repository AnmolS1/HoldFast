// Public links: what the owner manages, and what the public page is told.

import { z } from "zod";
import { THUMB_SIZES, ZIP_MAX_ENTRIES, ZIP_URL_BATCH } from "../constants";
import { Bytes, MimeCategory, NodeId, Page, PathToken, RowId, Timestamp } from "./common";
import {
  BatchDownloadUrlsResponse,
  DownloadUrlResponse,
  hasAField,
  NodeKind,
  NOTHING_TO_CHANGE,
  ZipEntry,
} from "./node";

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
/**
 * The stored reasons the owner's own "resume" can clear: their own pause, and a daily-ceiling
 * pause (resuming bypasses nothing — the next request still meets the ceiling). NOT `anomaly`:
 * that is an abuse pause, lifted by an admin or by the midnight job; if the owner could resume
 * it, the control would last one click.
 */
const OWNER_CLEARABLE = ["owner", "ceiling"];

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
 * `limitedToday`: the link's daily download count or daily bytes are used up right now — it is
 * refused with `429` until the UTC day rolls over, and is NOT paused (`state` stays live and
 * `pausedReasons` empty). Absent or false otherwise.
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
  limitedToday: z.boolean().optional(),
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
export const PatchLinkBody = z
  .strictObject({
    expiresAt: Timestamp.nullable().optional(),
    password: LinkPassword.nullable().optional(),
    maxDownloads: z.number().int().positive().nullable().optional(),
    allowPreview: z.boolean().optional(),
    paused: z.boolean().optional(),
  })
  .refine(hasAField, NOTHING_TO_CHANGE);
export type PatchLinkBody = z.infer<typeof PatchLinkBody>;

/**
 * How a visit to a link ended, AS ITS OWNER IS TOLD. The stored outcomes say more — that a file
 * was held back by a scan, or that the owner's own account was the reason — and those must not
 * reach the owner: they are folded into the one neutral `refused`.
 */
export const LinkOutcome = z.enum(["ok", "password", "expired", "limit", "paused", "refused"]);
export type LinkOutcome = z.infer<typeof LinkOutcome>;

const OUTCOME_SHOWN_AS: Record<string, LinkOutcome> = {
  ok: "ok",
  denied_password: "password",
  denied_expired: "expired",
  denied_cap: "limit",
  denied_paused: "paused",
  denied_scan: "refused",
  denied_owner: "refused",
};

/** A stored `link_access_log.outcome` as the owner is told. Anything unknown is `refused`. */
export function publicLinkOutcome(stored: string): LinkOutcome {
  return Object.hasOwn(OUTCOME_SHOWN_AS, stored) ? OUTCOME_SHOWN_AS[stored]! : "refused";
}

/** Counts per stored outcome as `LinkActivityDto.outcomes`: mapped, and summed where two fold into one. */
export function publicLinkOutcomes(stored: Record<string, number>): Partial<Record<LinkOutcome, number>> {
  const shown: Partial<Record<LinkOutcome, number>> = {};
  for (const [outcome, count] of Object.entries(stored)) {
    const key = publicLinkOutcome(outcome);
    shown[key] = (shown[key] ?? 0) + count;
  }
  return shown;
}

/** No addresses and no hashes: days, countries and owner-visible outcomes only. */
export const LinkActivityDto = z.object({
  days: z.array(z.object({ day: z.iso.date(), downloads: z.number().int().nonnegative(), bytes: Bytes })),
  countries: z.array(z.object({ country: z.string(), downloads: z.number().int().nonnegative() })),
  outcomes: z.partialRecord(LinkOutcome, z.number().int().nonnegative()),
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
  /** The detected type — what the preview picks its viewer by (the owner's `NodeDto` carries the same). */
  mimeSniffed: z.string().nullable(),
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
 * `nodeId` is absent for a link on a single file. `size` is REQUIRED for `kind: "thumb"` and
 * refused for every other kind.
 * `zipGrant`: a `download` mint carrying a valid grant does not count as another download.
 * Answered with a `DownloadUrlResponse`.
 */
export const PublicDownloadUrlBody = z.discriminatedUnion("kind", [
  // A thumbnail names its size, and nothing that belongs to a download.
  z.strictObject({
    nodeId: NodeId.optional(),
    kind: z.literal("thumb"),
    size: z.union(THUMB_SIZES.map((size) => z.literal(size))),
  }),
  // Anything else has no size.
  z.strictObject({
    nodeId: NodeId.optional(),
    kind: z.enum(["download", "inline"]),
    dangerousAck: z.boolean().optional(),
    zipGrant: z.string().min(1).max(2048).optional(),
  }),
]);
export type PublicDownloadUrlBody = z.infer<typeof PublicDownloadUrlBody>;

export const PublicDownloadUrlResponse = DownloadUrlResponse;
export type PublicDownloadUrlResponse = z.infer<typeof PublicDownloadUrlResponse>;

/**
 * `POST /api/public/links/:token/download-urls` — the URLs of one window of a public zip, minted
 * under its grant in ONE request (one hit of the per-address limiter). Every node passes every
 * check of the single mint; a refused node is an item with its code and no URL. A request without
 * a valid grant is refused as a whole. Answered with `PublicDownloadUrlsResponse`.
 */
export const PublicDownloadUrlsBody = z.strictObject({
  zipGrant: z.string().min(1).max(2048),
  nodeIds: z.array(NodeId).min(1).max(ZIP_URL_BATCH),
  dangerousAck: z.boolean().optional(),
});
export type PublicDownloadUrlsBody = z.infer<typeof PublicDownloadUrlsBody>;

export const PublicDownloadUrlsResponse = BatchDownloadUrlsResponse;
export type PublicDownloadUrlsResponse = z.infer<typeof PublicDownloadUrlsResponse>;

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
  entries: z.array(ZipEntry).max(ZIP_MAX_ENTRIES),
  totalBytes: Bytes,
  skipped: z.array(PublicZipSkipped),
  truncated: z.boolean(),
  zipGrant: z.string(),
});
export type PublicZipManifest = z.infer<typeof PublicZipManifest>;

/** The link token of a path or a body. */
export const LinkToken = PathToken;
export type LinkToken = z.infer<typeof LinkToken>;
