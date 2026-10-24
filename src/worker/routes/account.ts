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
import { deletedKeptBytes, holderUsedBytes } from "../db/queries/quota";
import { captureError } from "../sentry";
import {
  ACTIVITY_LIMIT,
  avatarNodeIdOf,
  currentAvatar,
  deleteOtherSessions,
  deleteOwnSession,
  activeShareBetween,
  admitExport,
  EXPORT_LIMITS,
  EXPORT_PAGE,
  exportLinks,
  exportNodePage,
  exportPasskeys,
  exportSharesGiven,
  exportSignInMethods,
  exportUser,
  FAILED_ACTIVITY_ACTIONS,
  getPrefs,
  getProfile,
  ownSessions,
  recentActivity,
  refundExportDay,
  releaseExport,
  updatePrefs,
  updateProfile,
  type ActivityRow,
  type ExportNodeRow,
  type ProfileRow,
} from "../db/queries/account";
import { displayNames } from "../db/queries/node-dto";
import { SHARED_VISIBLE_STATUSES } from "../db/queries/nodes";
import { sharedWithMe } from "../db/queries/shares";
import type { UserPrefs } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { assertContentAccess } from "../services/permissions";
import { coreOf, db, keys, runBackground, type AppEnv } from "../services/request-context";
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
  // No audit row: a theme or a notification switch is no security fact, and the debounced sync
  // would write one per burst of clicks (T23 review m2). Profile, sessions and export keep theirs.
  const row = await updatePrefs(db(c), user.id, body);
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
// THE TREE IS NEVER HELD WHOLE (T23 review M3). The small parts — the profile, prefs, shares,
// links, the activity — are read before the answer; the nodes are read a keyset page at a time
// AS THE BODY IS READ: the producer writes into a stream whose reader is the client, so it waits
// (backpressure) and at most one page and one encoded chunk are alive. It runs on a pool of its
// own (`runBackground`), held by ONE `waitUntil` registered before the handler returns — the
// request's own pool closes after its deferred drain (20 s), long before a big export ends
// (wave3-common §7; files-host `settleLater`). An account exports one at a time and at most
// EXPORT_DAILY_LIMIT a day (queries/account.ts); the running slot is given back however the
// stream ends.

const EXPORT_ACTIVITY_LIMIT = 1_000;
/** The export's maximum runtime has passed. */
class ExportExpired extends Error {
  constructor() {
    super("export: past its maximum runtime");
  }
}
/** One node of the file, as the contract says it — parsed per node, never the whole list. */
const ExportNode = ExportManifest.shape.nodes.element;
/** The file without its nodes, parsed through the contract: nothing beyond its fields is written. */
const ExportHead = ExportManifest.omit({ nodes: true });

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

const exportNode = (row: ExportNodeRow) =>
  ExportNode.parse({
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
    lastAccessedAt: row.lastAccessedAt ? iso(row.lastAccessedAt) : null,
  });

router.get("/account/export", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  // A GET, but it spends the day's budget: another site must not be able to spend it by navigating
  // the owner's browser here (R1 secsrv-3; the session cookie is SameSite=Lax, csrf.ts passes GETs).
  // The app's own link is same-origin; a typed address is `none`; no header at all is let through.
  const site = c.req.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site")
    throw new AppError("forbidden", "Cross-site request refused.", { reason: "csrf" });
  const handle = db(c);
  const at = now(c);
  const admitted = await admitExport(handle, user.id);
  if (!admitted.ok) {
    throw new AppError("rate_limited", undefined, undefined, {
      "Retry-After": String(admitted.retryAfterSeconds),
    });
  }
  let head: string;
  try {
    const [account, prefs, given, received, links, activity, held, sessions, passkeys, methods] =
      await Promise.all([
        exportUser(handle, user.id),
        getPrefs(handle, user.id),
        exportSharesGiven(handle, user.id),
        sharedWithMe(handle, user.id, { visibleStatuses: SHARED_VISIBLE_STATUSES }),
        exportLinks(handle, user.id),
        recentActivity(handle, user.id, EXPORT_ACTIVITY_LIMIT),
        deletedKeptBytes(handle, user.id),
        // Live ones only, as Settings → Devices lists them: an expired row a hold keeps past its
        // period (jobs/retention.ts) would make a held account's export tell the hold.
        ownSessions(handle, user.id, at),
        exportPasskeys(handle, user.id),
        exportSignInMethods(handle, user.id),
      ]);
    if (!account) throw new AppError("not_found");
    const owners = await displayNames(
      handle,
      received.map((item) => item.node.ownerId),
    );
    const rest = ExportHead.parse({
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
        // The account holder's figure, the one quota is enforced against (quota.ts).
        usedBytes: holderUsedBytes(account.usedBytes, held.files + held.versions, account.quotaBytes),
        termsAcceptedAt: account.termsAcceptedAt ? iso(account.termsAcceptedAt) : null,
        termsVersion: account.termsVersion,
        demoNoticeAcceptedAt: account.demoNoticeAcceptedAt ? iso(account.demoNoticeAcceptedAt) : null,
        demoNoticeVersion: account.demoNoticeVersion,
        ageVerifiedAt: account.ageVerifiedAt ? iso(account.ageVerifiedAt) : null,
        emailVerified: account.emailVerified,
        twoFactorEnabled: account.twoFactorEnabled === true,
      },
      prefs: toPrefsDto(prefs),
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
      sessions: sessions.map((row) => ({
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
      })),
      passkeys: passkeys.map((row) => ({ ...row, createdAt: row.createdAt ? iso(row.createdAt) : null })),
      // A password's "account id" is the user's own id: nothing to say.
      signInMethods: methods.map((row) => ({
        provider: row.provider,
        accountId: row.provider === "credential" ? null : row.accountId,
        createdAt: iso(row.createdAt),
      })),
    });
    head = `${JSON.stringify(rest).slice(0, -1)},"nodes":[`;
  } catch (error) {
    // Nothing was handed over: the slot and the day's export are given back.
    await releaseExport(handle, user.id, admitted.token);
    await refundExportDay(handle, user.id, admitted.dayWindow);
    throw error;
  }
  audit(c, "account.export", self(user.id));

  const encoder = new TextEncoder();
  // The body is a stream THIS code controls: a chunk is put in only when the client has asked for
  // one (`pull`, high-water mark 0 — backpressure), and at the deadline the stream is errored at
  // once. (A TransformStream cannot do the second: its writer's abort waits for a write the
  // stalled reader never takes.)
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let asked = false;
  let gone = false;
  let wake: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        controller = ctrl;
      },
      pull() {
        asked = true;
        wake?.();
        wake = null;
      },
      cancel() {
        gone = true;
        wake?.();
        wake = null;
      },
    },
    { highWaterMark: 0 },
  );
  const demand = () => (asked || gone ? Promise.resolve() : new Promise<void>((resolve) => (wake = resolve)));
  const { env, executionCtx } = c;
  const produce = runBackground(
    env,
    executionCtx,
    async (bg) => {
      // THE DEADLINE BOUNDS EVERYTHING (Addendum 5b): every read and every wait for the client
      // races it, so the export ends at its maximum runtime — inside the time its running slot is
      // held, so two exports of one account never overlap — and the slot is given back.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExportExpired()), EXPORT_LIMITS.maxRuntimeMs);
      });
      expired.catch(() => {});
      const inTime = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
      /** Bytes handed to the response so far: a refund only while there are none. */
      let handedOver = false;
      /** Whose failure it was: a client that went away or ran out the clock is not ours. */
      let ours = false;
      const send = async (bytes: Uint8Array) => {
        await inTime(demand());
        if (gone) throw new Error("export: the client went away");
        asked = false;
        controller.enqueue(bytes);
        handedOver = true;
      };
      try {
        await send(encoder.encode(head));
        let after: string | null = null;
        let first = true;
        for (;;) {
          let text: string;
          let page: ExportNodeRow[];
          try {
            page = await inTime(exportNodePage(bg.db, user.id, after));
            text = page.map((row) => JSON.stringify(exportNode(row))).join(",");
          } catch (error) {
            if (!(error instanceof ExportExpired)) ours = true;
            throw error;
          }
          if (page.length > 0) {
            await send(encoder.encode((first ? "" : ",") + text));
            first = false;
            after = page[page.length - 1]!.id;
          }
          if (page.length < EXPORT_PAGE) break;
        }
        await send(encoder.encode("]}"));
        controller.close();
      } catch (error) {
        // The body ends here, in an error the client sees. Only OUR failure before a byte was
        // handed over gives the day's export back — a client that walks away or stalls past the
        // clock has had its turn.
        if (!gone) {
          try {
            controller.error(error);
          } catch {
            // Already closed or errored.
          }
        }
        if (ours && !handedOver) await refundExportDay(bg.db, user.id, admitted.dayWindow);
      } finally {
        clearTimeout(timer);
        await releaseExport(bg.db, user.id, admitted.token);
      }
    },
    coreOf(c),
  ).catch((error) => {
    captureError(error, { kind: "account_export" });
  });
  // The request's own drain ends long before a long export does: this promise holds nothing of
  // the request's — the producer opens, drains and closes a pool of its own.
  // eslint-disable-next-line no-restricted-syntax -- not database work on the request's client
  executionCtx.waitUntil(produce);
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
// them in either direction (a pending share is none; nor one on a node the trash, a takedown or a
// delete-forever has taken away, nor one of an owner whose shares have stopped working), and an admin as the admin routes see one.
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
    activeShareBetween(handle, viewer.id, targetId),
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
