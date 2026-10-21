// The account, as its holder manages it. Paths are relative to /api.
//
//   GET    /api/account/profile                 ProfileDto (the time zone lives here, on `user`)
//   PATCH  /api/account/profile                 PatchProfileBody → ProfileDto
//   GET    /api/account/prefs                   PrefsDto (`user_prefs`)
//   PATCH  /api/account/prefs                   PatchPrefsBody → PrefsDto
//   GET    /api/account/activity                ActivityDto[] — the last 20 sign-in events
//   GET    /api/account/sessions                SessionDto[] — the caller's own sessions
//   POST   /api/account/sessions/revoke-others  { revoked } — every own session but this one
//   DELETE /api/account/sessions/:id            one own session (any other id: 404)
//   GET    /api/account/export                  ExportManifest, as a download
//   GET    /api/account/avatar-url/:userId      ThumbUrlResponse for that user's avatar
//
// Not here: usage (routes/nodes.ts), terms and every deletion endpoint (routes/account-lifecycle.ts),
// the address change (Better Auth's /change-email and routes/pending-email.ts), the avatar upload
// (routes/uploads.ts, `purpose: "avatar"`). Password, passkeys, two-factor and Google linking are
// Better Auth's own endpoints.
//
// NOTHING HERE TELLS A HELD ACCOUNT FROM ANOTHER: no answer carries `legalHold`, and the export's
// node set leaves out exactly what would differ (db/queries/account.ts).
//
// The GETs that hand out content or personal data — activity, sessions, export, avatar-url —
// refuse an impersonated session (`assertContentAccess`); T07 already makes such a session
// read-only for every other method.

import { Hono } from "hono";
import { z } from "zod";
import { THUMB_SIZES, type ThumbSize } from "../../shared/constants";
import { BA_ID_PARAM } from "../../shared/ids";
import { hasAdminRole } from "../../shared/roles";
import {
  ExportManifest,
  PatchPrefsBody,
  PatchProfileBody,
  type ActivityDto,
  type PrefsDto,
  type ProfileDto,
  type SessionDto,
} from "../../shared/schemas/account";
import type { LinkState } from "../../shared/schemas/link";
import type { ThumbUrlResponse } from "../../shared/schemas/node";
import { hasSecondFactor } from "../auth/second-factor";
import {
  ACTIVITY_LIMIT,
  avatarNodeIdOf,
  currentAvatar,
  deleteOtherSessions,
  deleteOwnSession,
  exportLinks,
  exportNodes,
  exportSharesGiven,
  exportUser,
  FAILED_ACTIVITY_ACTIONS,
  getPrefs,
  getProfile,
  ownSessions,
  recentActivity,
  updatePrefs,
  updateProfile,
  type ActivityRow,
  type ProfileRow,
} from "../db/queries/account";
import { displayNames } from "../db/queries/node-dto";
import { SHARED_VISIBLE_STATUSES } from "../db/queries/nodes";
import { hasShareBetween, sharedWithMe } from "../db/queries/shares";
import type { UserPrefs } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { assertContentAccess } from "../services/permissions";
import { db, keys, type AppEnv } from "../services/request-context";
import { mintDownloadToken } from "../services/tokens";

export const router = new Hono<AppEnv>();

const BA_ID = `{${BA_ID_PARAM}}`;
const iso = (date: Date) => date.toISOString();
const self = (userId: string) => ({ type: "user", id: userId });

// ── profile ─────────────────────────────────────────────────────────────────────────────────

const toProfileDto = (row: ProfileRow): ProfileDto => ({
  displayName: row.name,
  email: row.email,
  timezone: row.timezone,
  locale: row.locale,
  avatar: row.avatar ? { nodeId: row.avatar.nodeId, etag: row.avatar.versionId ?? "" } : null,
});

/**
 * A name as the sign-up form takes it (auth/preflight.ts `personName`, which is not exported):
 * 1–80 characters (the schema), no control or format character, no line or paragraph separator.
 */
const NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A zone the runtime knows, as it names it; null when it knows none by that name. */
function knownTimeZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The canonical form of a BCP 47 tag; null when it is not one. */
function canonicalLocale(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

const invalid = (field: string, message: string) =>
  new AppError("validation", message, { issues: [{ path: field, message }] });

router.get("/account/profile", async (c) => {
  const user = requireVerified(c);
  const row = await getProfile(db(c), user.id);
  if (!row) throw new AppError("not_found");
  return c.json(toProfileDto(row) satisfies ProfileDto);
});

router.patch("/account/profile", async (c) => {
  const user = requireVerified(c);
  // Strict: any other field of `user` (quotaBytes, legalHold, role …) is a 400 here.
  const body = PatchProfileBody.parse(await jsonBody(c));
  const patch: { name?: string; timezone?: string; locale?: string } = {};
  if (body.displayName !== undefined) {
    const name = body.displayName.trim();
    if (name === "" || NAME_FORBIDDEN.test(name)) throw invalid("displayName", "Enter a name.");
    patch.name = name;
  }
  if (body.timezone !== undefined) {
    const zone = knownTimeZone(body.timezone);
    if (!zone) throw invalid("timezone", "Unknown time zone.");
    patch.timezone = zone;
  }
  if (body.locale !== undefined) {
    const locale = canonicalLocale(body.locale);
    if (!locale) throw invalid("locale", "Unknown language.");
    patch.locale = locale;
  }
  if (Object.keys(patch).length > 0) {
    if (!(await updateProfile(db(c), user.id, patch))) throw new AppError("not_found");
    audit(c, "account.profile_updated", self(user.id), { fields: Object.keys(patch).sort() });
  }
  const row = await getProfile(db(c), user.id);
  if (!row) throw new AppError("not_found");
  return c.json(toProfileDto(row) satisfies ProfileDto);
});

// ── preferences ─────────────────────────────────────────────────────────────────────────────

const toPrefsDto = (row: UserPrefs): PrefsDto => ({
  density: row.density,
  theme: row.theme,
  viewMode: row.viewMode,
  emailShares: row.emailShares,
  emailLinkDigest: row.emailLinkDigest,
  // Security mail cannot be switched off, whatever a row says.
  emailSecurity: true,
});

router.get("/account/prefs", async (c) => {
  const user = requireVerified(c);
  return c.json(toPrefsDto(await getPrefs(db(c), user.id)) satisfies PrefsDto);
});

router.patch("/account/prefs", async (c) => {
  const user = requireVerified(c);
  // Strict, and at least one field: `emailSecurity` is not a field of it.
  const body = PatchPrefsBody.parse(await jsonBody(c));
  const row = await updatePrefs(db(c), user.id, body);
  audit(c, "account.prefs_updated", self(user.id), { fields: Object.keys(body).sort() });
  return c.json(toPrefsDto(row) satisfies PrefsDto);
});

// ── sign-in activity ────────────────────────────────────────────────────────────────────────

function toActivityDto(row: ActivityRow): ActivityDto {
  // A sign-in records "Chrome on macOS" in its meta; the row's own `ua` is the browser family.
  const label = row.meta?.uaFamily;
  return {
    id: row.id,
    at: iso(row.at),
    action: row.action,
    outcome: FAILED_ACTIVITY_ACTIONS.has(row.action) ? "failed" : "ok",
    uaLabel: typeof label === "string" && label !== "" ? label : row.ua,
    country: row.country,
  };
}

router.get("/account/activity", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const rows = await recentActivity(db(c), user.id, ACTIVITY_LIMIT);
  return c.json(rows.map(toActivityDto) satisfies ActivityDto[]);
});

// ── sessions ────────────────────────────────────────────────────────────────────────────────
// The caller's own sessions only. Revoking one deletes its row: every request reads the session
// row (no cookie cache — auth/create-auth.ts), so the other browser is signed out at its next
// request.

router.get("/account/sessions", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const currentId = c.get("session")?.id ?? null;
  const rows = await ownSessions(db(c), user.id, now(c));
  const body = rows.map((row): SessionDto => ({
    id: row.id,
    current: row.id === currentId,
    createdAt: iso(row.createdAt),
    lastActiveAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt),
    // Never the raw User-Agent and never the address: the coarse label the session was made
    // with, "" when there was none (the SPA says "Unknown device").
    uaLabel: row.uaFamily ?? "",
    country: row.country,
  }));
  return c.json(body satisfies SessionDto[]);
});

// Static before parameterised (the registry test).
router.post("/account/sessions/revoke-others", async (c) => {
  const user = requireVerified(c);
  const current = c.get("session");
  if (!current) throw new AppError("unauthorized");
  const revoked = await deleteOtherSessions(db(c), user.id, current.id);
  audit(c, "account.session_revoked", self(user.id), { scope: "others", count: revoked });
  return c.json({ revoked });
});

router.delete(`/account/sessions/:id${BA_ID}`, async (c) => {
  const user = requireVerified(c);
  const id = c.req.param("id");
  if (!(await deleteOwnSession(db(c), user.id, id))) throw new AppError("not_found");
  audit(c, "account.session_revoked", self(user.id), { scope: "one", count: 1 });
  return c.body(null, 204);
});

// ── the data export ─────────────────────────────────────────────────────────────────────────

const EXPORT_ACTIVITY_LIMIT = 1_000;
/** Nodes written per chunk of the streamed body. */
const NODES_PER_CHUNK = 500;

/** What the owner is shown a link as. Most decisive first: an ended link is not "paused". */
function linkState(
  row: {
    revokedAt: Date | null;
    lockedByAdmin: boolean;
    expiresAt: Date | null;
    maxDownloads: number | null;
    downloadCount: number;
    pauseReasons: readonly string[];
  },
  at: Date,
): LinkState {
  if (row.revokedAt) return "revoked";
  if (row.lockedByAdmin) return "locked";
  if (row.expiresAt && row.expiresAt.getTime() <= at.getTime()) return "expired";
  if (row.maxDownloads !== null && row.downloadCount >= row.maxDownloads) return "limit_reached";
  if (row.pauseReasons.length > 0) return "paused";
  return "active";
}

router.get("/account/export", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const handle = db(c);
  const at = now(c);
  // EVERY read happens here, before the answer: the pool closes once the request's deferred work
  // is drained, which a long download could outlast.
  const [account, prefs, nodeRows, given, received, links, activity] = await Promise.all([
    exportUser(handle, user.id),
    getPrefs(handle, user.id),
    exportNodes(handle, user.id),
    exportSharesGiven(handle, user.id),
    sharedWithMe(handle, user.id, { visibleStatuses: SHARED_VISIBLE_STATUSES }),
    exportLinks(handle, user.id),
    recentActivity(handle, user.id, EXPORT_ACTIVITY_LIMIT),
  ]);
  if (!account) throw new AppError("not_found");
  const owners = await displayNames(
    handle,
    received.map((item) => item.node.ownerId),
  );

  // Parsed through the contract: what is written is exactly its fields — a column added to a
  // query later can never reach the file.
  const manifest = ExportManifest.parse({
    version: 1,
    exportedAt: iso(at),
    user: {
      id: account.id,
      email: account.email,
      displayName: account.name,
      createdAt: iso(account.createdAt),
      timezone: account.timezone,
      locale: account.locale,
      quotaBytes: account.quotaBytes,
      usedBytes: account.usedBytes,
      termsAcceptedAt: account.termsAcceptedAt ? iso(account.termsAcceptedAt) : null,
      termsVersion: account.termsVersion,
    },
    prefs: toPrefsDto(prefs),
    nodes: nodeRows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      kind: row.kind,
      name: row.name,
      size: row.size,
      mimeSniffed: row.mimeSniffed,
      sha256: row.sha256,
      scanStatus: row.scanStatus,
      starred: row.starred,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      deletedAt: row.deletedAt ? iso(row.deletedAt) : null,
    })),
    shares: given.map((row) => ({
      nodeId: row.nodeId,
      email: row.granteeEmail,
      role: row.role,
      canUpload: row.canUpload,
      createdAt: iso(row.createdAt),
    })),
    sharedWithMe: received.map(({ share, node }) => ({
      nodeId: node.id,
      name: node.name,
      role: share.role,
      ownerDisplayName: owners.get(node.ownerId) ?? "",
    })),
    links: links.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      state: linkState(row, at),
      expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
      hasPassword: row.hasPassword,
      maxDownloads: row.maxDownloads,
      downloadCount: row.downloadCount,
      createdAt: iso(row.createdAt),
    })),
    activity: activity.map(toActivityDto),
  });
  audit(c, "account.export", self(user.id), { nodes: manifest.nodes.length });

  // The body is written in parts — the nodes, which can be many, a chunk at a time — from what
  // was read above; nothing is read from the database after this returns.
  const { nodes: list, ...rest } = manifest;
  const head = JSON.stringify(rest).slice(0, -1);
  const encoder = new TextEncoder();
  let index = 0;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(`${head},"nodes":[`));
        return;
      }
      if (index < list.length) {
        const part = list.slice(index, index + NODES_PER_CHUNK).map((item) => JSON.stringify(item));
        controller.enqueue(encoder.encode((index === 0 ? "" : ",") + part.join(",")));
        index += NODES_PER_CHUNK;
        return;
      }
      controller.enqueue(encoder.encode("]}"));
      controller.close();
    },
  });
  const day = iso(at).slice(0, 10);
  return c.body(body, 200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="holdfast-export-${day}.json"`,
    "cache-control": "no-store",
  });
});

// ── an avatar's URL ─────────────────────────────────────────────────────────────────────────
// WHO MAY SEE AN AVATAR is decided here and nowhere else (the files host's gate 4d does not ask
// for an avatar thumbnail): the user themself, someone with an ACTIVE share relationship with
// them in either direction (a pending share is none), and an admin as the admin routes see one.
// Anyone else, no avatar, and an avatar that is not clean or is hidden are the one `404`, after
// the same reads.

const AVATAR_SIZES = THUMB_SIZES.filter((size) => size <= 320);

const AvatarQuery = z.strictObject({
  size: z.coerce
    .number()
    .refine((size): size is ThumbSize => (AVATAR_SIZES as readonly number[]).includes(size)),
});

/** An admin as `requireAdmin` sees one: the role, two-factor on the account and on this session. */
function isAdminSession(c: Parameters<typeof requireVerified>[0]): boolean {
  const user = c.get("user");
  if (!user || c.get("impersonating")) return false;
  return (
    hasAdminRole(user.role) &&
    user.twoFactorEnabled === true &&
    hasSecondFactor(c.get("session"), now(c).getTime())
  );
}

router.get(`/account/avatar-url/:userId${BA_ID}`, async (c) => {
  const viewer = requireVerified(c);
  assertContentAccess(c);
  const { size } = AvatarQuery.parse(c.req.query());
  const targetId = c.req.param("userId");
  const handle = db(c);
  // Both reads, whatever the first answers.
  const [related, nodeId] = await Promise.all([
    hasShareBetween(handle, viewer.id, targetId),
    avatarNodeIdOf(handle, targetId),
  ]);
  const node = await currentAvatar(handle, targetId, nodeId);
  const allowed = related || isAdminSession(c);
  if (!allowed || !node || !node.versionId) throw new AppError("not_found");
  const { token, expiresAt } = await mintDownloadToken(keys(c), {
    k: "thumb",
    n: node.id,
    ver: node.versionId,
    st: "u",
    sub: viewer.id,
    sz: size,
  });
  return c.json({
    url: `${c.env.FILES_ORIGIN}/t/${node.id}/${size}/${token}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  } satisfies ThumbUrlResponse);
});
