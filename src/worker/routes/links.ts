// Public links, as their owner manages them. Paths are relative to /api; every route needs a
// verified, signed-in user. (What a visitor of a link may do is routes/public-links.ts.)
//
//   POST   /nodes/:id/links      create a link to a file or a folder (the owner)
//   GET    /links/mine           every link the caller created
//   PATCH  /links/:id            expiry, password, download limit, preview, the owner's pause
//   DELETE /links/:id            revoke — the one irreversible link action
//   GET    /links/:id/activity   by day, by country, by outcome: no address, no hash
//
// THE TOKEN is 16 random bytes, base64url. The database keeps its SHA-256 (the lookup key) and the
// token sealed under `link-token-enc` with the row's own id bound in, so "Copy link" works at any
// time: `url` is opened again on every read by the link's owner — and is null for anyone else,
// for an impersonated session, and for a sealed value that does not open for this row. The
// plaintext token is never stored and never logged.
//
// A PASSWORD CHANGE REVOKES NOTHING EXPLICITLY. Link sessions, files-host URLs and zip grants all
// carry the link's password version (`linkPwv`), which every check compares with the current one;
// writing `passwordHash` is the whole of it.
//
// A DAILY CEILING IS NOT A PAUSE. A link whose daily download count or bytes are used up is
// refused with `429` until the day rolls over; it is listed live, with `limitedToday: true`.

import { Hono, type Context } from "hono";
import type { z } from "zod";
import { UUID_PARAM } from "../../shared/ids";
import {
  CreateLinkBody,
  ownerCanUnpause,
  PatchLinkBody,
  publicLinkOutcomes,
  publicPauseReasons,
  type LinkActivityDto,
  type LinkDto,
  type LinkState,
} from "../../shared/schemas/link";
import { uuidv7 } from "../db/ids";
import { pauseLinks, unpauseLinks } from "../db/queries/links";
import { getNode } from "../db/queries/nodes";
import {
  ceilingAccount,
  insertLink,
  linkActivity,
  linksOfOwner,
  linkTotalsOn,
  linkWithNodeById,
  revokeLink,
  updateLinkSettings,
  type LinkWithNode,
} from "../db/queries/sharing";
import { utcDay } from "../db/queries/ledger";
import { retryOnDeadlock } from "../db/retry";
import type { Node, PauseReason } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { requireSwitch } from "../middleware/kill-switch";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { consumeCeiling, effectiveLimits } from "../services/ceilings";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { hashLinkPassword } from "../services/link-password";
import { metric } from "../services/metrics";
import { requireRole, type Access } from "../services/permissions";
import { db, deps, keys, settings, type AppEnv } from "../services/request-context";
import {
  hashLinkToken,
  LINK_TOKEN_KEY_VERSION,
  newLinkToken,
  openLinkToken,
  sealLinkToken,
} from "../services/tokens";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const ID = `:id{${UUID_PARAM}}`;
/** How far back the owner's activity view reaches. */
export const ACTIVITY_DAYS = 30;
const DAY_MS = 86_400_000;

/** The stored reasons the owner's own resume removes: their pause, and a `ceiling` nothing writes. */
const OWNER_LIFTS: readonly PauseReason[] = ["owner", "ceiling"];

const target = (nodeId: string) => ({ type: "node", id: nodeId });

/** A body or a query through its schema, or `400 validation` naming each problem. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError("validation", undefined, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/**
 * The node behind an id, for a caller with at least `min` on it and not in the trash; a system
 * node is no node of this API. Whether it is there for them is `requireRole`'s answer alone —
 * hidden, unknown and not theirs are one `404`.
 */
export async function sharedNode(
  c: Ctx,
  nodeId: string,
  min: "editor" | "owner",
): Promise<{ node: Node; access: Access }> {
  const access = await requireRole(c, nodeId, min, { notTrashed: true });
  const node = await getNode(db(c), nodeId);
  if (!node || node.system !== null) throw new AppError("not_found");
  return { node, access };
}

/** A file is shared, or linked, only once the scanner has passed it (the matrix's session codes). */
export function scanGate(node: Node): void {
  if (node.kind !== "file") return;
  if (node.scanStatus === "pending") throw new AppError("scan_pending");
  if (node.scanStatus !== "clean") throw new AppError("scan_blocked");
}

/** An expiry the owner sets must lie ahead. */
function futureExpiry(c: Ctx, value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const at = new Date(value);
  if (at.getTime() <= now(c).getTime()) {
    throw new AppError("validation", "The expiry must be in the future.", { reason: "expiry_past" });
  }
  return at;
}

/** One state, the first that holds: revoked, expired, locked, at its download limit, paused, active. */
function stateOf(link: LinkWithNode, at: Date): LinkState {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt.getTime() <= at.getTime()) return "expired";
  if (link.lockedByAdmin) return "locked";
  if (link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) return "limit_reached";
  if (link.pauseReasons.length > 0) return "paused";
  return "active";
}

/** The public URL of a link, for its owner only; null when the sealed token does not open. */
async function urlOf(c: Ctx, link: LinkWithNode): Promise<string | null> {
  try {
    const token = await openLinkToken(
      keys(c),
      { ciphertext: link.tokenEnc, iv: link.tokenIv, keyVersion: link.tokenKeyVersion },
      { linkId: link.id },
    );
    return `${c.env.APP_ORIGIN}/s/${token}`;
  } catch {
    // Never the value, never the row's token: only that one did not open.
    console.error("links: a sealed link token did not open for its row");
    return null;
  }
}

/**
 * Links as their owner is shown them. `url` only for the caller's own links outside an
 * impersonation. `limitedToday` from today's `download_link` ledger row against the link's
 * limits — one read of the rows, one of each owner's account.
 */
export async function linkDtos(c: Ctx, links: LinkWithNode[]): Promise<LinkDto[]> {
  if (links.length === 0) return [];
  const viewer = c.get("user");
  const impersonating = c.get("impersonating") === true;
  const at = now(c);
  const totals = await linkTotalsOn(
    db(c),
    utcDay(at),
    links.map((link) => link.id),
  );
  const stored = await settings(c);
  const accounts = new Map<string, Awaited<ReturnType<typeof ceilingAccount>>>();
  for (const ownerId of new Set(links.map((link) => link.createdBy))) {
    accounts.set(ownerId, await ceilingAccount(db(c), ownerId));
  }
  const out: LinkDto[] = [];
  for (const link of links) {
    const state = stateOf(link, at);
    const account = accounts.get(link.createdBy);
    const used = totals.get(link.id) ?? { bytes: 0, count: 0 };
    const limits = account ? effectiveLimits(c.env, stored, "download_link", account, at) : {};
    const live = state !== "revoked" && state !== "expired";
    const limitedToday =
      live &&
      ((limits.count !== undefined && used.count >= limits.count) ||
        (limits.bytes !== undefined && used.bytes >= limits.bytes));
    const own = viewer !== null && viewer.id === link.createdBy && !impersonating;
    out.push({
      id: link.id,
      nodeId: link.nodeId,
      node: { name: link.nodeName, kind: link.nodeKind },
      url: own ? await urlOf(c, link) : null,
      state,
      pausedReasons: publicPauseReasons(link.pauseReasons),
      canUnpause: ownerCanUnpause(link.pauseReasons, link.lockedByAdmin),
      expiresAt: link.expiresAt?.toISOString() ?? null,
      hasPassword: link.passwordHash !== null,
      maxDownloads: link.maxDownloads,
      downloadCount: link.downloadCount,
      bytesServed: link.bytesServed,
      allowPreview: link.allowPreview,
      createdAt: link.createdAt.toISOString(),
      lastAccessAt: link.lastAccessAt?.toISOString() ?? null,
      limitedToday,
    });
  }
  return out;
}

/** The caller's own link: anyone else's — or one on a node they no longer see — is `404`. */
async function ownLink(c: Ctx, linkId: string, userId: string): Promise<LinkWithNode> {
  const link = await linkWithNodeById(db(c), linkId);
  if (!link || link.createdBy !== userId) throw new AppError("not_found");
  await requireRole(c, link.nodeId, "owner");
  return link;
}

// Static paths first, then the ones with an id (the registry test holds the file to it).

router.get("/links/mine", async (c) => {
  const user = requireVerified(c);
  return c.json((await linkDtos(c, await linksOfOwner(db(c), user.id))) satisfies LinkDto[]);
});

router.post(`/nodes/${ID}/links`, requireSwitch("linksEnabled"), async (c) => {
  const user = requireVerified(c);
  const body = parse(CreateLinkBody, await jsonBody(c));
  const { node } = await sharedNode(c, c.req.param("id"), "owner");
  scanGate(node);
  const expiresAt = futureExpiry(c, body.expiresAt) ?? null;

  // Everything that costs time comes before the transaction: the id the token is sealed to, the
  // token, its hash and the password's (≈ 0.1 s of CPU).
  const id = uuidv7();
  const token = newLinkToken();
  const [tokenHash, sealed, passwordHash] = await Promise.all([
    hashLinkToken(token),
    sealLinkToken(keys(c), token, { linkId: id }),
    body.password === undefined ? null : hashLinkPassword(body.password),
  ]);
  const account = { quotaBytes: user.quotaBytes, createdAt: user.createdAt };
  // ONE transaction: the ceiling FIRST — it takes the creator's `user` row lock itself and counts
  // the live links under it — then the row it admits. Refused → rolled back, `429`, no row.
  // DATABASE STATEMENTS ONLY inside: it may run again.
  const row = await retryOnDeadlock(deps(c).db, async (tx) => {
    await consumeCeiling(c, "link_user", { id: user.id, account }, { count: 1 }, { tx });
    return insertLink(tx, {
      id,
      nodeId: node.id,
      createdBy: user.id,
      tokenHash,
      tokenEnc: sealed.ciphertext,
      tokenIv: sealed.iv,
      tokenKeyVersion: LINK_TOKEN_KEY_VERSION,
      passwordHash,
      expiresAt,
      maxDownloads: body.maxDownloads ?? null,
      allowPreview: body.allowPreview,
    });
  });
  audit(c, "link.create", target(node.id), { linkId: row.id });
  metric("link", { kind: "create", outcome: "ok" });
  const [dto] = await linkDtos(c, [{ ...row, nodeName: node.name, nodeKind: node.kind }]);
  return c.json(dto!, 201);
});

router.patch(`/links/${ID}`, async (c) => {
  const user = requireVerified(c);
  const body = parse(PatchLinkBody, await jsonBody(c));
  const link = await ownLink(c, c.req.param("id"), user.id);
  if (link.revokedAt !== null)
    throw new AppError("conflict", "This link was revoked.", { reason: "revoked" });
  // Every decision before any write.
  const lifts = OWNER_LIFTS.filter((reason) => link.pauseReasons.includes(reason));
  if (
    body.paused === false &&
    link.pauseReasons.length > 0 &&
    !ownerCanUnpause(link.pauseReasons, link.lockedByAdmin)
  ) {
    throw new AppError("forbidden", "This link cannot be resumed by its owner.", {
      reason: "not_owner_pause",
    });
  }
  const expiresAt = futureExpiry(c, body.expiresAt);
  const passwordHash =
    body.password === undefined
      ? undefined
      : body.password === null
        ? null
        : await hashLinkPassword(body.password);
  const settingsPatch = {
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(passwordHash !== undefined ? { passwordHash } : {}),
    ...(body.maxDownloads !== undefined ? { maxDownloads: body.maxDownloads } : {}),
    ...(body.allowPreview !== undefined ? { allowPreview: body.allowPreview } : {}),
  };
  // DATABASE STATEMENTS ONLY inside; the audit row after.
  await retryOnDeadlock(deps(c).db, async (tx) => {
    await updateLinkSettings(tx, link.id, settingsPatch);
    if (body.paused === true) await pauseLinks(tx, { linkId: link.id }, "owner");
    if (body.paused === false) {
      for (const reason of lifts) await unpauseLinks(tx, { linkId: link.id }, reason);
    }
  });
  audit(c, "link.update", target(link.nodeId), {
    linkId: link.id,
    changed: Object.keys(body).sort(),
  });
  if (body.paused !== undefined) metric("link", { kind: body.paused ? "pause" : "resume", outcome: "ok" });
  const after = await linkWithNodeById(db(c), link.id);
  if (!after) throw new AppError("not_found");
  const [dto] = await linkDtos(c, [after]);
  return c.json(dto!);
});

router.delete(`/links/${ID}`, async (c) => {
  const user = requireVerified(c);
  // Decided by who created the link, not by the node (Addendum 6, as ruling #23 for the
  // activity): a link the owner is shown — paused on a node that is hidden now — is theirs to end.
  // Revoking only narrows access, and tells them nothing the list has not. The row is kept: a
  // revoked link is a stamped row, never a deleted one (a legal hold keeps its log with it).
  const link = await linkWithNodeById(db(c), c.req.param("id"));
  if (!link || link.createdBy !== user.id) throw new AppError("not_found");
  if (await revokeLink(db(c), link.id)) {
    audit(c, "link.revoke", target(link.nodeId), { linkId: link.id });
    metric("link", { kind: "revoke", outcome: "ok" });
  }
  return c.body(null, 204);
});

router.get(`/links/${ID}/activity`, async (c) => {
  const user = requireVerified(c);
  // Decided by who created the link, not by the node: a link on a node that is hidden now is
  // still the owner's to look at — and what it says is the neutral enum only.
  const link = await linkWithNodeById(db(c), c.req.param("id"));
  if (!link || link.createdBy !== user.id) throw new AppError("not_found");
  const since = new Date(now(c).getTime() - ACTIVITY_DAYS * DAY_MS);
  const activity = await linkActivity(db(c), link.id, since);
  return c.json({
    days: activity.days,
    countries: activity.countries,
    outcomes: publicLinkOutcomes(activity.outcomes),
  } satisfies LinkActivityDto);
});
