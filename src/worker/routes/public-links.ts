// The public link API: what a visitor of `/s/:token` may do. Paths are relative to /api.
//
//   GET  /public/links/:token                     PublicLinkInfo (node null until unlocked)
//   POST /public/links/:token/unlock              the password → a link session (1 h)
//   POST /public/links/:token/download-url        a files-host URL: download, inline or thumb
//   GET  /public/links/:token/children[/:nodeId]  a folder link's listing, clean files only
//   POST /public/links/:token/zip-manifest        a folder link's zip: one download, and a grant
//
// NO SESSION COUNTS HERE. The session middleware does not run under /api/public/, and nothing in
// this file reads a user: whoever is signed in, a visitor gets exactly what the link gives. A
// password is proven by the link session, sent in the `X-Holdfast-Link-Session` header — never a
// cookie. Nothing here ever answers `401`: that code opens the app's re-auth dialog.
//
// ONE FUNCTION DECIDES WHETHER THE LINK ANSWERS AT ALL — `resolveLink`, the availability table:
// the link's own state first, then the password, then anything about the file. So a visitor
// without the password learns nothing about the node, and every node that is not there for a
// visitor — trashed, hidden (taken down itself or above, suspected CSAM), not clean (pending
// included: a visitor uploaded nothing) — is the `404 not_found` of a token that matches no link.
// That last answer is `getAccess` under `withLinkScope`; this file has no scan or hidden check.
//
// COUNTING. Only a `download` mint counts, and a zip counts once — at its manifest, which hands out
// a grant (bound to the link, the folder, the password version and the caller's address) under
// which the per-file mints count nothing. Two counters, in this order: the link's daily count
// (a refusal is `429`, the owner is told once a day, the link is NOT paused), then `maxDownloads`
// (an atomic conditional increment; at the cap `410`). Before either, every mint previews the
// owner's daily link bytes: at the cap it answers `429` and mints nothing — it consumes nothing.
//
// EVERY MINT AND EVERY REFUSAL leaves one `link_access_log` row (T05 `logAccess`), after the
// answer; a token that matches no link has no row to write. Never a URL, a Referer or a Location
// in a log line: the token is a secret in the path.

import { Hono, type Context } from "hono";
import { HEADER_LINK_SESSION, TOKEN_TTL, ZIP_MAX_ENTRIES } from "../../shared/constants";
import { TOKEN_PARAM, UUID_PARAM } from "../../shared/ids";
import {
  PublicDownloadUrlBody,
  UnlockBody,
  type PublicChildrenResponse,
  type PublicDownloadUrlResponse,
  type PublicLinkInfo,
  type PublicNodeDto,
  type PublicZipManifest,
  type UnlockResponse,
} from "../../shared/schemas/link";
import { ListChildrenQuery } from "../../shared/schemas/node";
import { QueryError } from "../db/errors";
import {
  clearPasswordFailures,
  consumeDownload,
  findByTokenHash,
  logAccess,
  passwordLock,
  recordPasswordFailure,
} from "../db/queries/links";
import { getNode, listChildren, SHARED_VISIBLE_STATUSES } from "../db/queries/nodes";
import { zipManifest } from "../db/queries/nodes-api";
import { ceilingAccount } from "../db/queries/sharing";
import { isActive, userState } from "../db/queries/users";
import type { Node, ShareLink } from "../db/schema";
import { rateLimitByIp } from "../middleware/rate-limit";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { ceilingExceeded, checkCeiling, tryConsumeCeiling, type CeilingSubject } from "../services/ceilings";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { dayUTC, ipHashDaily, ipHashStable } from "../services/ip-hash";
import { notifyLinkLimitOnce } from "../services/ledger";
import { verifyLinkPassword } from "../services/link-password";
import { metric } from "../services/metrics";
import { categoryOf, dangerousForPublicLink, inlineKindAllowed, thumbEligible } from "../services/mime";
import { getAccess, withLinkScope } from "../services/permissions";
import { db, defer, deps, keys, settings, type AppEnv } from "../services/request-context";
import {
  hashLinkToken,
  linkPwv,
  mintDownloadToken,
  mintLinkSession,
  mintZipGrant,
  verifyLinkSession,
  verifyZipGrant,
} from "../services/tokens";
import { parse } from "./links";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
type Outcome = Parameters<typeof logAccess>[1]["outcome"];

const TOKEN = `:token{${TOKEN_PARAM}}`;
const NODE = `:nodeId{${UUID_PARAM}}`;
const BASE = `/public/links/${TOKEN}`;

/** The coarse per-address limiter (per colo), in front of every route of this file. */
const limited = rateLimitByIp("RL_LINKS");

const isoOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

// ── the visitor ─────────────────────────────────────────────────────────────────────────────

/** The non-rotating address hash of this request: what sessions, grants and the throttle bind to. */
function stableHashOf(c: Ctx): Promise<string> {
  return ipHashStable(keys(c), c.get("ip"));
}

/** One access-log row, written after the answer (deferred). Never an address: its daily hash. */
function logVisit(c: Ctx, linkId: string, nodeId: string | null, outcome: Outcome): void {
  const cf = c.req.raw.cf as { country?: unknown } | undefined;
  const country = typeof cf?.country === "string" ? cf.country : null;
  const write = async () =>
    logAccess(db(c), {
      linkId,
      nodeId,
      outcome,
      ipHashDaily: await ipHashDaily(keys(c), c.get("ip"), dayUTC(now(c))),
      country,
      uaHash: null,
    });
  defer(
    c,
    write().catch(() => {
      metric("link", { outcome: "error", reason: "access_log" });
    }),
  );
}

/** A refusal of a link that exists: its log row, then the error. */
function refuse(c: Ctx, link: ShareLink, nodeId: string | null, outcome: Outcome, error: AppError): never {
  logVisit(c, link.id, nodeId, outcome);
  metric("link", { kind: "public", outcome: error.code });
  throw error;
}

const expired = (reason: "revoked" | "expired" | "limit_reached") =>
  new AppError("link_expired", undefined, { reason });
const paused = (reason: "traffic" | "unavailable") => new AppError("link_paused", undefined, { reason });

// ── the availability table ──────────────────────────────────────────────────────────────────

type Resolved = {
  link: ShareLink;
  /** The link's CURRENT password version, read in this request. */
  pwv: string;
  /** The caller's non-rotating address hash. */
  ipHashStable: string;
  /** False only when `password: "optional"` and the password is still to be entered. */
  unlocked: boolean;
  /** The request carried a zip grant that verifies for this link, its node, `pwv` and address. */
  granted: boolean;
};

type ResolveOptions = {
  /** `"skip"`: rows 1–8 only (the unlock route); `"optional"`: row 9 answers instead of throwing. */
  password?: "required" | "optional" | "skip";
  /** A zip grant the request carries: row 4 does not apply when it verifies. */
  zipGrant?: string;
};

/**
 * The link of `token`, or the row of the availability table that refuses it — in the table's
 * order: link state, then the password. (Rows 10–11, the file, are `nodeFor`'s.) The link scope
 * is set on success, so every access question after it is about the link alone.
 */
async function resolveLink(c: Ctx, token: string, opts: ResolveOptions = {}): Promise<Resolved> {
  // 1
  const link = await findByTokenHash(db(c), await hashLinkToken(token));
  if (!link) throw new AppError("not_found");
  const at = now(c);
  const [pwv, stable] = await Promise.all([linkPwv(link.passwordHash), stableHashOf(c)]);
  // 2, 3
  if (link.revokedAt !== null) refuse(c, link, null, "denied_expired", expired("revoked"));
  if (link.expiresAt !== null && link.expiresAt.getTime() <= at.getTime()) {
    refuse(c, link, null, "denied_expired", expired("expired"));
  }
  // 4 — not for a request under a valid grant: the zip it belongs to has been counted.
  const granted =
    opts.zipGrant !== undefined &&
    (await verifyZipGrant(keys(c), opts.zipGrant, {
      linkId: link.id,
      n: link.nodeId,
      pwv,
      ipHashStable: stable,
    })) !== null;
  if (!granted && link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) {
    refuse(c, link, null, "denied_cap", expired("limit_reached"));
  }
  // 5
  if (!(await settings(c)).linksEnabled) refuse(c, link, null, "denied_paused", paused("unavailable"));
  // 6, 7 — a set holding anything but `anomaly` (or a stored `ceiling`, which nothing writes any
  // more and which reads as `anomaly`) is `unavailable`; only such a set is `traffic`.
  if (link.lockedByAdmin) refuse(c, link, null, "denied_paused", paused("unavailable"));
  if (link.pauseReasons.length > 0) {
    const traffic = link.pauseReasons.every((reason) => reason === "anomaly" || reason === "ceiling");
    refuse(c, link, null, "denied_paused", paused(traffic ? "traffic" : "unavailable"));
  }
  // 8 — decided in THIS request: an owner suspended a moment ago is suspended here.
  if (!isActive(await userState(db(c), link.createdBy))) {
    refuse(c, link, null, "denied_owner", paused("unavailable"));
  }
  // 9
  let unlocked = true;
  if (link.passwordHash !== null && opts.password !== "skip") {
    try {
      await verifyLinkSession(keys(c), c.req.header(HEADER_LINK_SESSION), {
        linkId: link.id,
        ipHashStable: stable,
        pwv,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (opts.password !== "optional") {
        refuse(c, link, null, "denied_password", new AppError("password_required"));
      }
      unlocked = false;
    }
  }
  withLinkScope(c, { linkId: link.id, rootNodeId: link.nodeId });
  return { link, pwv, ipHashStable: stable, unlocked, granted };
}

/**
 * Rows 10–11: the node under the link, or `404` — trashed, hidden, not clean, outside the link:
 * all one answer, `getAccess`'s, the same as a token that matches no link.
 */
async function nodeFor(c: Ctx, resolved: Resolved, nodeId: string): Promise<Node> {
  const access = await getAccess(c, nodeId, { notTrashed: true });
  const node = access ? await getNode(db(c), nodeId) : null;
  if (!node || node.system !== null) {
    refuse(c, resolved.link, null, "denied_scan", new AppError("not_found"));
  }
  return node;
}

function publicNode(node: Node, link: ShareLink): PublicNodeDto {
  const file = node.kind === "file";
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    size: node.size,
    mimeCategory: file ? categoryOf(node.mimeSniffed, node.ext) : "other",
    ext: node.ext,
    thumb: file && link.allowPreview && thumbEligible(node),
  };
}

/** The link owner as the ceilings see them. */
async function ownerSubject(c: Ctx, link: ShareLink): Promise<CeilingSubject> {
  const account = await ceilingAccount(db(c), link.createdBy);
  if (!account) refuse(c, link, null, "denied_owner", paused("unavailable"));
  return { id: link.createdBy, account };
}

/**
 * The owner's daily link bytes, PREVIEWED: at the cap — when not one more byte would fit — the
 * mint answers `429` and mints nothing. Nothing is consumed or written; a mint that passes may
 * still be refused by the files host a moment later.
 */
async function previewOwnerCap(
  c: Ctx,
  link: ShareLink,
  owner: CeilingSubject,
  nodeId: string,
): Promise<void> {
  const preview = await checkCeiling(c, "download_owner", owner, { bytes: 1 });
  if (!preview.ok) refuse(c, link, nodeId, "denied_cap", ceilingExceeded(preview));
}

/**
 * The two counters of one download, in their order: the link's daily count (refused → the owner
 * is told once today, `429`, no pause), then `maxDownloads` (at the cap → `410`).
 */
async function countDownload(c: Ctx, link: ShareLink, owner: CeilingSubject, nodeId: string): Promise<void> {
  const daily = await tryConsumeCeiling(
    c,
    "download_link",
    { id: link.id, account: owner.account },
    { count: 1 },
  );
  if (!daily.ok) {
    await notifyLinkLimitOnce(deps(c), link.id, now(c));
    refuse(c, link, nodeId, "denied_cap", ceilingExceeded(daily));
  }
  if (!(await consumeDownload(db(c), link.id))) {
    refuse(c, link, nodeId, "denied_cap", expired("limit_reached"));
  }
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────

router.get(BASE, limited, async (c) => {
  const resolved = await resolveLink(c, c.req.param("token"), { password: "optional" });
  const { link } = resolved;
  if (!resolved.unlocked) {
    return c.json({
      requiresPassword: true,
      node: null,
      allowPreview: false,
      dangerous: false,
    } satisfies PublicLinkInfo);
  }
  const node = await nodeFor(c, resolved, link.nodeId);
  return c.json({
    requiresPassword: link.passwordHash !== null,
    node: publicNode(node, link),
    allowPreview: link.allowPreview,
    dangerous: node.kind === "file" && dangerousForPublicLink(node.name, node.mimeSniffed),
  } satisfies PublicLinkInfo);
});

router.post(`${BASE}/unlock`, limited, async (c) => {
  const body = parse(UnlockBody, await jsonBody(c));
  const {
    link,
    pwv,
    ipHashStable: stable,
  } = await resolveLink(c, c.req.param("token"), { password: "skip" });
  if (link.passwordHash !== null) {
    // The throttle BEFORE the hash: a caller who is locked out buys no scrypt.
    const lock = await passwordLock(db(c), link.id, stable);
    if (lock) {
      refuse(
        c,
        link,
        null,
        "denied_password",
        new AppError("rate_limited", undefined, undefined, { "Retry-After": String(lock.retryAfterSec) }),
      );
    }
    if (!(await verifyLinkPassword(body.password, link.passwordHash))) {
      const failure = await recordPasswordFailure(db(c), link.id, stable);
      const until = failure?.lockedUntil?.getTime() ?? 0;
      const retryAfterSec = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      refuse(
        c,
        link,
        null,
        "denied_password",
        new AppError("password_required", undefined, { wrongPassword: true, retryAfterSec }),
      );
    }
    await clearPasswordFailures(db(c), link.id, stable);
  }
  const session = await mintLinkSession(keys(c), { linkId: link.id, ipHashStable: stable, pwv });
  metric("link", { kind: "unlock", outcome: "ok" });
  return c.json({ linkSession: session.token, expiresAt: isoOf(session.expiresAt) } satisfies UnlockResponse);
});

router.post(`${BASE}/download-url`, limited, async (c) => {
  const body = parse(PublicDownloadUrlBody, await jsonBody(c));
  const zipGrant = body.kind === "thumb" ? undefined : body.zipGrant;
  const resolved = await resolveLink(c, c.req.param("token"), { zipGrant });
  const { link, pwv } = resolved;
  const node = await nodeFor(c, resolved, body.nodeId ?? link.nodeId);
  if (node.kind !== "file" || node.versionId === null) {
    refuse(c, link, node.id, "denied_scan", new AppError("not_found"));
  }
  if (body.kind !== "download") {
    if (!link.allowPreview)
      refuse(
        c,
        link,
        node.id,
        "denied_scan",
        new AppError("forbidden", undefined, { reason: "preview_off" }),
      );
    if (body.kind === "inline" && !inlineKindAllowed(node)) {
      refuse(
        c,
        link,
        node.id,
        "denied_scan",
        new AppError("forbidden", undefined, { reason: "inline_type" }),
      );
    }
    if (body.kind === "thumb" && !thumbEligible(node))
      refuse(c, link, node.id, "denied_scan", new AppError("not_found"));
  } else if (!body.dangerousAck && dangerousForPublicLink(node.name, node.mimeSniffed)) {
    refuse(
      c,
      link,
      node.id,
      "denied_scan",
      new AppError("forbidden", undefined, { reason: "dangerous_ack" }),
    );
  }
  const owner = await ownerSubject(c, link);
  await previewOwnerCap(c, link, owner, node.id);
  // After every other check and immediately before the mint. A grant's mint was counted at its
  // manifest; a preview is never counted.
  const counted = body.kind === "download" && !resolved.granted;
  if (counted) await countDownload(c, link, owner, node.id);

  const { token, expiresAt } = await mintDownloadToken(
    keys(c),
    {
      k: body.kind,
      n: node.id,
      ver: node.versionId,
      st: "l",
      sub: link.id,
      pwv,
      ...(body.kind === "thumb" ? { sz: body.size } : {}),
    },
    resolved.granted ? { ttlSec: TOKEN_TTL.zip } : {},
  );
  if (counted) audit(c, "file.download", { type: "node", id: node.id }, { linkId: link.id, size: node.size });
  logVisit(c, link.id, node.id, "ok");
  metric("download", { kind: body.kind, outcome: "ok", reason: "link" });
  const path =
    body.kind === "thumb" ? `t/${node.id}/${body.size}` : `${body.kind === "inline" ? "i" : "d"}/${node.id}`;
  return c.json({
    url: `${c.env.FILES_ORIGIN}/${path}/${token}`,
    expiresAt: isoOf(expiresAt),
  } satisfies PublicDownloadUrlResponse);
});

async function children(c: Ctx, nodeId: string | undefined) {
  const query = parse(ListChildrenQuery, c.req.query());
  const resolved = await resolveLink(c, c.req.param("token")!);
  const folder = await nodeFor(c, resolved, nodeId ?? resolved.link.nodeId);
  if (folder.kind !== "folder") refuse(c, resolved.link, folder.id, "denied_scan", new AppError("not_found"));
  let page: Awaited<ReturnType<typeof listChildren>>;
  try {
    page = await listChildren(db(c), {
      scope: { ownerId: folder.ownerId },
      parentId: folder.id,
      sort: query.sort,
      dir: query.dir,
      cursor: query.cursor ?? null,
      limit: query.limit,
      kind: query.kind,
      visibleStatuses: SHARED_VISIBLE_STATUSES,
    });
  } catch (error) {
    if (error instanceof QueryError && error.code === "validation")
      throw new AppError("validation", error.message);
    throw error;
  }
  return c.json({
    items: page.items.map((row) => publicNode(row, resolved.link)),
    nextCursor: page.nextCursor,
  } satisfies PublicChildrenResponse);
}

router.get(`${BASE}/children`, limited, (c) => children(c, undefined));
router.get(`${BASE}/children/${NODE}`, limited, (c) => children(c, c.req.param("nodeId")));

router.post(`${BASE}/zip-manifest`, limited, async (c) => {
  const resolved = await resolveLink(c, c.req.param("token"));
  const { link, pwv } = resolved;
  const root = await nodeFor(c, resolved, link.nodeId);
  if (root.kind !== "folder") refuse(c, link, root.id, "denied_scan", new AppError("not_found"));
  const owner = await ownerSubject(c, link);
  await previewOwnerCap(c, link, owner, root.id);
  // Every file under the root that the link could ever serve: the clean ones are entries; one
  // that is not clean is named once, as `unavailable` — never why. Hidden and trashed nodes, and
  // suspected CSAM, are in neither list.
  const manifest = await zipManifest(db(c), [{ id: root.id, label: root.name, owner: true }], {
    maxFiles: ZIP_MAX_ENTRIES,
  });
  // One zip is one download: both counters, once, here.
  await countDownload(c, link, owner, root.id);
  const grant = await mintZipGrant(keys(c), {
    linkId: link.id,
    n: root.id,
    pwv,
    ipHashStable: resolved.ipHashStable,
  });
  audit(
    c,
    "file.download",
    { type: "node", id: root.id },
    { linkId: link.id, size: manifest.totalBytes, zip: true },
  );
  logVisit(c, link.id, root.id, "ok");
  metric("download", { kind: "zip", outcome: "ok", reason: "link" });
  return c.json({
    entries: manifest.entries,
    totalBytes: manifest.totalBytes,
    skipped: manifest.skipped.map(({ nodeId, path }) => ({ nodeId, path, reason: "unavailable" as const })),
    truncated: manifest.truncated,
    zipGrant: grant.token,
  } satisfies PublicZipManifest);
});
