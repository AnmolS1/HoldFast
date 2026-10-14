// The tree, except its bytes and its trash. Paths are relative to /api.
//
//   GET   /api/nodes/root                 the caller's own top level
//   GET   /api/nodes/:id/children         a folder's content, folders first, keyset-paged
//   GET   /api/nodes/:id                  { node, breadcrumbs }
//   POST  /api/nodes/folder               create a folder
//   PATCH /api/nodes/:id                  rename, star
//   POST  /api/nodes/:id/move
//   POST  /api/nodes/:id/download-url     a files-host URL for one file
//   GET   /api/nodes/:id/thumb-url
//   POST  /api/nodes/zip-manifest         what a zip of these nodes would hold (no URLs)
//   POST  /api/nodes/download-urls        the URLs for one window of that manifest
//   POST  /api/nodes/:id/rescan
//   GET   /api/account/usage
//
// WHO MAY SEE WHAT is decided in services/permissions.ts and nowhere else: every node id of a
// path or a body goes through `requireRole` before anything is read about it (`liveNode` below).
// So an id that was never issued, one the caller has no share to, a node that is hidden from
// everyone but an admin, one in the trash, and a file a share partner's listing would not show
// them all get the same `404 not_found`, for the same work — this file has no branch for any of
// these, and must never grow one. (The trash has its own routes, in their own file.) The zip
// manifest reads a tree, not ids: its query is handed the terms of the same rule.
//
// `403 forbidden` is only ever answered to a caller who can already see the node.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { THUMB_SIZES, TOKEN_TTL, ZIP_MAX_ENTRIES, type ThumbSize } from "../../shared/constants";
import type { ErrorCode } from "../../shared/errors";
import { UUID_PARAM } from "../../shared/ids";
import type { UsageDto } from "../../shared/schemas/account";
import {
  BatchDownloadUrlsBody,
  CreateFolderBody,
  DownloadUrlBody,
  ListChildrenQuery,
  MoveBody,
  RenameBody,
  ZipManifestBody,
  type BatchDownloadUrlItem,
  type BatchDownloadUrlsResponse,
  type DownloadUrlResponse,
  type NodeDetailDto,
  type NodePage,
  type ThumbUrlResponse,
} from "../../shared/schemas/node";
import type { SessionUser } from "../auth/types";
import { LegalHoldError, QueryError } from "../db/errors";
import {
  createFolder,
  getNode,
  listChildren,
  moveNode,
  type Moved,
  OWNER_VISIBLE_STATUSES,
  SHARED_VISIBLE_STATUSES,
  UPLOADER_VISIBLE_STATUSES,
  rename,
  requestRescan,
  setStar,
  touchAccessed,
} from "../db/queries/nodes";
import {
  liveNameHolder,
  lockForEdit,
  ownEditorShares,
  releaseRescan,
  zipManifest,
  type ZipRoot,
} from "../db/queries/nodes-api";
import { usageBreakdown } from "../db/queries/quota";
import { ancestors, ownedRoots } from "../db/queries/tree";
import { retryOnDeadlock } from "../db/retry";
import type { Node, ScanStatus } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { nameKeyOf, sanitizeName } from "../services/filename";
import { metric } from "../services/metrics";
import { inlineKindAllowed, thumbEligible } from "../services/mime";
import { toNodeDto, toNodeDtos, type NodeView } from "../services/node-dto";
import { assertContentAccess, requireRole, type Access, type Role } from "../services/permissions";
import { db, deps, keys, type AppEnv } from "../services/request-context";
import { enqueueRescan } from "../services/scanning";
import { mintDownloadToken } from "../services/tokens";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const ID = `:id{${UUID_PARAM}}`;
const RESCAN_EVERY_SEC = 3_600;
/** What an owner may ask to have scanned again (see the rescan route). */
const RESCANNABLE: readonly ScanStatus[] = ["error", "skipped", "pending"];

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError("validation", undefined, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/**
 * The node behind an id of the request, for a caller who has at least `min` on it. WHETHER IT IS
 * THERE FOR THEM is `requireRole`'s answer alone — no access, hidden, in the trash (asked with
 * `notTrashed`), a file a share partner may not see: one `404 not_found` from one fixed amount of
 * work — and too low a role is its `403`. Only then is the row read. The one thing added here: a
 * system node (an avatar) is no node of this API — `404` for its own owner, the only caller who
 * can get this far.
 */
async function liveNode(c: Ctx, nodeId: string, min: Role): Promise<{ node: Node; access: Access }> {
  const access = await requireRole(c, nodeId, min, { notTrashed: true });
  const node = await getNode(db(c), nodeId);
  if (!node || node.system !== null) throw new AppError("not_found");
  return { node, access };
}

const statusesFor = (access: Access) =>
  access.role === "owner" ? OWNER_VISIBLE_STATUSES : SHARED_VISIBLE_STATUSES;

/** Who the mapper answers for: the role, and the node a share partner's role comes from. */
const viewOf = (user: SessionUser, access: Access): NodeView => ({
  viewerId: user.id,
  role: access.role,
  shareRootId: access.shareRootId,
});

const target = (nodeId: string) => ({ type: "node", id: nodeId });

// Static paths first, then the ones with an id (the registry test holds the file to it).

// ── the top level ───────────────────────────────────────────────────────────────────────────

router.get("/nodes/root", async (c) => {
  const user = requireVerified(c);
  const query = parse(ListChildrenQuery, c.req.query());
  const page = await listChildren(db(c), {
    scope: { ownerId: user.id },
    parentId: null,
    ...query,
    visibleStatuses: OWNER_VISIBLE_STATUSES,
  });
  const items = await toNodeDtos(db(c), page.items, { viewerId: user.id, role: "owner" });
  return c.json({ items, nextCursor: page.nextCursor } satisfies NodePage);
});

// ── create a folder ─────────────────────────────────────────────────────────────────────────

/**
 * The `details` of the `409` for a folder name that is taken: the id of the node that holds the
 * name — when, and only when, it is a FOLDER the caller may see, which `requireRole` decides as
 * it does for every other id. Undefined in every other case (a file holds the name; a folder
 * the caller may not see does): the answer then says nothing about what holds it.
 */
async function existingFolder(
  c: Ctx,
  where: { ownerId: string; parentId: string | null; name: string },
): Promise<{ existingId: string } | undefined> {
  const holder = await liveNameHolder(db(c), {
    ownerId: where.ownerId,
    parentId: where.parentId,
    nameKey: nameKeyOf(sanitizeName(where.name)),
  });
  if (holder?.kind !== "folder") return undefined;
  try {
    await requireRole(c, holder.id, "viewer");
  } catch (error) {
    if (error instanceof AppError) return undefined;
    throw error;
  }
  return { existingId: holder.id };
}

router.post("/nodes/folder", async (c) => {
  const user = requireVerified(c);
  const body = parse(CreateFolderBody, await jsonBody(c));
  let ownerId = user.id;
  let view: NodeView = { viewerId: user.id, role: "owner" };
  if (body.parentId !== null) {
    const parent = await liveNode(c, body.parentId, "editor");
    if (parent.node.kind !== "folder") throw new AppError("not_found");
    // Inside a shared folder the new folder belongs to the tree's owner, not to its maker.
    ownerId = parent.node.ownerId;
    view = viewOf(user, parent.access);
  }
  let created: Node;
  try {
    created = await createFolder(db(c), {
      ownerId,
      createdBy: user.id,
      parentId: body.parentId,
      name: body.name,
    });
  } catch (error) {
    if (!(error instanceof QueryError) || error.code !== "conflict") throw error;
    // The same status, code and message whatever holds the name; only `details` differs.
    const details = await existingFolder(c, { ownerId, parentId: body.parentId, name: body.name });
    throw new AppError("conflict", error.message, details);
  }
  audit(c, "node.create_folder", target(created.id), { parentId: created.parentId });
  return c.json(await toNodeDto(db(c), created, view));
});

// ── files-host URLs ─────────────────────────────────────────────────────────────────────────

type UrlKind = "download" | "inline";
type CurrentFile = Node & { versionId: string };

const isoOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** A file the caller may see, with a current version. Anything else is `404`. */
async function liveFile(c: Ctx, nodeId: string): Promise<{ node: CurrentFile; access: Access }> {
  const { node, access } = await liveNode(c, nodeId, "viewer");
  if (node.kind !== "file" || node.versionId === null) throw new AppError("not_found");
  return { node: node as CurrentFile, access };
}

/**
 * The scan rows of the download matrix, in its order. Returns whether the file goes out with the
 * `unscanned` warning. (A file locked as suspected CSAM never gets here: it is hidden.)
 */
function scanGate(node: Node, access: Access, kind: UrlKind): { unscanned: boolean } {
  if (node.scanStatus === "pending") throw new AppError("scan_pending");
  if (node.scanStatus === "skipped" || node.scanStatus === "error") {
    // Never scanned: the owner may take their own file back, as a download, with a warning.
    if (access.role === "owner" && kind === "download") return { unscanned: true };
    throw new AppError("scan_blocked");
  }
  if (node.scanStatus !== "clean") throw new AppError("scan_blocked");
  return { unscanned: false };
}

/**
 * One file's URL, or the matrix row that refuses it. Every `download` mint is one `file.download`
 * audit row — "a download was authorised for this user" — and an inline mint is none.
 */
async function mintUrl(
  c: Ctx,
  user: SessionUser,
  nodeId: string,
  kind: UrlKind,
  zip: boolean,
): Promise<{ answer: DownloadUrlResponse; owner: boolean }> {
  const { node, access } = await liveFile(c, nodeId);
  const { unscanned } = scanGate(node, access, kind);
  if (kind === "inline" && !inlineKindAllowed(node)) throw new AppError("forbidden");

  const { token, expiresAt } = await mintDownloadToken(
    keys(c),
    { k: kind, n: node.id, ver: node.versionId, st: "u", sub: user.id },
    zip ? { ttlSec: TOKEN_TTL.zip } : {},
  );
  if (kind === "download") {
    audit(c, "file.download", target(node.id), zip ? { size: node.size, zip: true } : { size: node.size });
  }
  metric("download", { kind, outcome: "ok" });
  const answer: DownloadUrlResponse = {
    url: `${c.env.FILES_ORIGIN}/${kind === "inline" ? "i" : "d"}/${node.id}/${token}`,
    expiresAt: isoOf(expiresAt),
    ...(unscanned ? { warning: "unscanned" as const } : {}),
  };
  return { answer, owner: access.role === "owner" };
}

// ── zip ─────────────────────────────────────────────────────────────────────────────────────

/** "name", then "name (2)", "name (3)" …: two selected nodes of one name must not share a path. */
function uniqueLabels(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let label = name;
    for (let n = 2; taken.has(nameKeyOf(label)); n++) label = `${stem} (${n})${ext}`;
    taken.add(nameKeyOf(label));
    return label;
  });
}

router.post("/nodes/zip-manifest", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const body = parse(ZipManifestBody, await jsonBody(c));
  let roots: ZipRoot[];
  if ("nodeIds" in body) {
    const ids = [...new Set(body.nodeIds)];
    // One after the other: the first root the caller may not see ends the request, and nothing
    // more is asked about the rest.
    const found: Awaited<ReturnType<typeof liveNode>>[] = [];
    for (const id of ids) found.push(await liveNode(c, id, "viewer"));
    const labels = uniqueLabels(found.map(({ node }) => node.name));
    roots = found.map(({ node, access }, index) => ({
      id: node.id,
      label: labels[index]!,
      owner: access.role === "owner",
    }));
  } else {
    // Everything the caller owns. The list has trashed and hidden roots in it; the manifest
    // query leaves those out.
    const owned = await ownedRoots(db(c), user.id);
    roots = owned.map((node) => ({ id: node.id, label: node.name, owner: true }));
  }
  return c.json(
    await zipManifest(db(c), roots, {
      maxFiles: ZIP_MAX_ENTRIES,
      partner: { viewerId: user.id, uploaderSees: UPLOADER_VISIBLE_STATUSES },
    }),
  );
});

router.post("/nodes/download-urls", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const { nodeIds } = parse(BatchDownloadUrlsBody, await jsonBody(c));
  // One after the other, in the order asked: a failure that is nobody's refusal ends the request
  // there, with nothing minted or recorded for the nodes after it.
  const items: BatchDownloadUrlItem[] = [];
  for (const nodeId of nodeIds) {
    try {
      const { answer } = await mintUrl(c, user, nodeId, "download", true);
      items.push({ nodeId, url: answer.url, expiresAt: answer.expiresAt });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const code: ErrorCode = error.code;
      metric("download", { kind: "download", outcome: code });
      items.push({ nodeId, error: code });
    }
  }
  return c.json({ items } satisfies BatchDownloadUrlsResponse);
});

// ── usage ───────────────────────────────────────────────────────────────────────────────────

router.get("/account/usage", async (c) => {
  const user = requireVerified(c);
  const usage = await usageBreakdown(db(c), user.id);
  if (!usage) throw new AppError("not_found");
  return c.json(usage satisfies UsageDto);
});

// ── by id: read ─────────────────────────────────────────────────────────────────────────────

router.get(`/nodes/${ID}/children`, async (c) => {
  const user = requireVerified(c);
  const query = parse(ListChildrenQuery, c.req.query());
  const { node, access } = await liveNode(c, c.req.param("id"), "viewer");
  if (node.kind !== "folder") throw new AppError("not_found");
  const page = await listChildren(db(c), {
    scope: { ownerId: node.ownerId },
    parentId: node.id,
    ...query,
    visibleStatuses: statusesFor(access),
  });
  // A child has the role of the folder it is listed in — unless a share on the child itself gives
  // more, which for a viewer of the folder can only be an editor share. One read for the page.
  const raised =
    access.role === "viewer"
      ? await ownEditorShares(
          db(c),
          user.id,
          page.items.map((row) => row.id),
        )
      : new Set<string>();
  const items = await toNodeDtos(db(c), page.items, {
    ...viewOf(user, access),
    role: (row) => (raised.has(row.id) ? "editor" : access.role),
  });
  return c.json({ items, nextCursor: page.nextCursor } satisfies NodePage);
});

router.get(`/nodes/${ID}`, async (c) => {
  const user = requireVerified(c);
  const { node, access } = await liveNode(c, c.req.param("id"), "viewer");
  // Root first, the node itself not included. Anyone but the owner sees the chain from the node
  // that was shared with them: what lies above it is not theirs to know.
  const chain = await ancestors(db(c), node.id);
  const from =
    access.shareRootId === null
      ? 0
      : access.shareRootId === node.id
        ? chain.length
        : chain.findIndex((row) => row.id === access.shareRootId);
  const breadcrumbs = (from < 0 ? [] : chain.slice(from)).map((row) => ({ id: row.id, name: row.name }));
  const dto = await toNodeDto(db(c), node, viewOf(user, access));
  return c.json({ node: dto, breadcrumbs } satisfies NodeDetailDto);
});

// ── by id: rename, star, move ───────────────────────────────────────────────────────────────

router.patch(`/nodes/${ID}`, async (c) => {
  const user = requireVerified(c);
  const id = c.req.param("id");
  const body = parse(RenameBody, await jsonBody(c));
  const found = await liveNode(c, id, "viewer");
  const { access } = found;
  let node = found.node;
  // Both permissions before either write: a refused half must not leave the other half done.
  if (body.starred !== undefined && access.role !== "owner") throw new AppError("forbidden");
  if (body.name !== undefined) {
    await requireRole(c, id, "editor");
    // A share gives a role INSIDE the shared node; the node itself stays its owner's to name.
    if (access.shareRootId === id) throw new AppError("forbidden");
  }

  // Both writes in one transaction, the row locked first: what each CHANGED is decided against
  // the row as it was under the lock — not as this request read it — so a rename to the name the
  // node already has, or a star it already has, writes no audit row, and a real one always does.
  // DATABASE STATEMENTS ONLY inside the callback (it may run again); the rows are written after.
  const edit = await retryOnDeadlock(deps(c).db, async (tx) => {
    const before = await lockForEdit(tx, id);
    if (!before) throw new AppError("not_found");
    let after = node;
    if (body.name !== undefined) after = await rename(tx, id, body.name);
    if (body.starred !== undefined) {
      if (!(await setStar(tx, id, body.starred))) throw new AppError("not_found");
      after = { ...after, starred: body.starred };
    }
    return { before, after };
  });
  node = edit.after;
  if (body.name !== undefined && edit.after.name !== edit.before.name) {
    audit(c, "node.rename", target(id), null);
  }
  if (body.starred !== undefined && edit.after.starred !== edit.before.starred) {
    audit(c, "node.star", target(id), { starred: edit.after.starred });
  }
  return c.json(await toNodeDto(db(c), node, viewOf(user, access)));
});

/**
 * The move itself. `moveNode` takes the owner's tree lock as its first statement, so it is the first
 * thing in the transaction; the transaction is opened — and run again when Postgres ends it as a
 * deadlock victim — by `retryOnDeadlock`. DATABASE STATEMENTS ONLY inside the callback: it may
 * run more than once. The audit row and the metrics come after it has returned.
 *
 * ONE ANSWER for every move that cannot be: a cycle, a taken name, and a node that may not leave
 * the folder it is in — the same `409 conflict`, with the same words and nothing else, so that
 * none of the three can be told from the others. `LegalHoldError` is caught here because
 * nothing may ever show it: not its causes, not that it happened.
 */
async function moveTo(c: Ctx, nodeId: string, parentId: string | null): Promise<Moved> {
  try {
    // Where the node was and whether anything moved are decided by `moveNode` under the tree
    // lock it holds — not from what the request read before, which another move may overtake.
    return await retryOnDeadlock(deps(c).db, (tx) => moveNode(tx, nodeId, parentId));
  } catch (error) {
    if (error instanceof LegalHoldError) {
      metric("node", { kind: "move", outcome: "refused" });
      throw new AppError("conflict");
    }
    if (error instanceof QueryError && error.code === "conflict") throw new AppError("conflict");
    throw error;
  }
}

router.post(`/nodes/${ID}/move`, async (c) => {
  const user = requireVerified(c);
  const id = c.req.param("id");
  const body = parse(MoveBody, await jsonBody(c));
  const { access } = await liveNode(c, id, "editor");
  if (access.shareRootId === id) throw new AppError("forbidden");
  if (body.parentId === null) {
    // The top level of a tree is its owner's alone: no share reaches it.
    if (access.role !== "owner") throw new AppError("forbidden");
  } else {
    await liveNode(c, body.parentId, "editor");
  }
  const { node: moved, previousParentId, changed } = await moveTo(c, id, body.parentId);
  // A move to where the node already is changes nothing and is not recorded as one: the same
  // request sent twice, or raced, is one move and one row.
  if (changed) {
    audit(c, "node.move", target(id), { from: previousParentId, to: moved.parentId });
    metric("node", { kind: "move", outcome: "ok" });
  }
  return c.json(await toNodeDto(db(c), moved, viewOf(user, access)));
});

// ── by id: URLs ─────────────────────────────────────────────────────────────────────────────

router.post(`/nodes/${ID}/download-url`, async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const id = c.req.param("id");
  const { kind } = parse(DownloadUrlBody, await jsonBody(c));
  let minted: Awaited<ReturnType<typeof mintUrl>>;
  try {
    minted = await mintUrl(c, user, id, kind, false);
  } catch (error) {
    if (error instanceof AppError) metric("download", { kind, outcome: error.code });
    throw error;
  }
  // What Recent orders by: the owner opened this file (at most one write per ten minutes).
  if (minted.owner) await touchAccessed(db(c), id);
  return c.json(minted.answer);
});

const ThumbQuery = z.strictObject({
  size: z.coerce
    .number()
    .refine((size): size is ThumbSize => (THUMB_SIZES as readonly number[]).includes(size)),
});

router.get(`/nodes/${ID}/thumb-url`, async (c) => {
  const user = requireVerified(c);
  // A GET: the read-only rule for an impersonated session does not cover it, so this does.
  assertContentAccess(c);
  const { size } = parse(ThumbQuery, c.req.query());
  const { node } = await liveFile(c, c.req.param("id"));
  if (node.scanStatus === "pending") throw new AppError("scan_pending");
  if (node.scanStatus === "infected" || node.scanStatus === "under_review") {
    throw new AppError("scan_blocked");
  }
  // No thumbnail for this file: the client shows the icon.
  if (!thumbEligible(node)) throw new AppError("not_found");
  const { token, expiresAt } = await mintDownloadToken(keys(c), {
    k: "thumb",
    n: node.id,
    ver: node.versionId,
    st: "u",
    sub: user.id,
    sz: size,
  });
  return c.json({
    url: `${c.env.FILES_ORIGIN}/t/${node.id}/${size}/${token}`,
    expiresAt: isoOf(expiresAt),
  } satisfies ThumbUrlResponse);
});

// ── by id: rescan ───────────────────────────────────────────────────────────────────────────

router.post(`/nodes/${ID}/rescan`, async (c) => {
  requireVerified(c);
  const id = c.req.param("id");
  const { node } = await liveNode(c, id, "owner");
  if (node.kind !== "file") throw new AppError("not_found");
  // Before the throttle: a request that cannot be granted must not use up the hour. `pending` goes
  // through: with no live scan job its message never arrived and is sent again; with one, the
  // service answers `409` (and the hour is given back below).
  if (!RESCANNABLE.includes(node.scanStatus)) throw new AppError("conflict");
  if (!(await requestRescan(db(c), id))) {
    const since = node.rescanRequestedAt ? (now(c).getTime() - node.rescanRequestedAt.getTime()) / 1000 : 0;
    const wait = Math.min(RESCAN_EVERY_SEC, Math.max(1, Math.ceil(RESCAN_EVERY_SEC - since)));
    throw new AppError("rate_limited", undefined, undefined, { "Retry-After": String(wait) });
  }
  // Decides on the locked row, and answers `404` itself for a file that may not be rescanned.
  try {
    await enqueueRescan(deps(c), id, { by: "owner" });
  } catch (error) {
    // The message could not be sent, or a scan is already under way (`409`): the hour it took is
    // given back, so that neither is also a throttle. (A `404` — the file was hidden meanwhile —
    // keeps it: that answer must equal an unknown id's, which writes nothing back.)
    const giveBack = !(error instanceof AppError) || error.code === "conflict";
    if (giveBack) await releaseRescan(db(c), id, node.rescanRequestedAt);
    throw error;
  }
  audit(c, "node.rescan", target(id), null);
  return c.json({ ok: true }, 202);
});
