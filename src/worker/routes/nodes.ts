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
// path or a body goes through `requireRole` before anything is read about it (`visibleNode`
// below). So an id that was never issued, one the caller has no share to, and a node that is
// hidden from everyone but an admin all get the same `404 not_found` — this file has no branch
// for the last of these, and must never grow one. What `requireRole` does not look at is added
// here, once, for every route alike: a node in the trash (the trash routes have their own file)
// and a system node (an avatar) are `404` too.
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
  move,
  OWNER_VISIBLE_STATUSES,
  rename,
  requestRescan,
  setStar,
  touchAccessed,
} from "../db/queries/nodes";
import { liveNameHolder, zipManifest, type ZipRoot } from "../db/queries/nodes-api";
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
import {
  assertContentAccess,
  assertNotTrashed,
  requireRole,
  type Access,
  type Role,
} from "../services/permissions";
import { db, deps, keys, type AppEnv } from "../services/request-context";
import { enqueueRescan } from "../services/scanning";
import { mintDownloadToken } from "../services/tokens";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const ID = `:id{${UUID_PARAM}}`;
const RESCAN_EVERY_SEC = 3_600;

/** What a share partner's listing shows: verdicts other than `clean` are the owner's business. */
const SHARED_VISIBLE_STATUSES: ScanStatus[] = ["clean"];

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError("validation", undefined, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/**
 * The node behind an id of the request, for a caller who has at least `min` on it.
 * `404 not_found` — never anything else — when the caller has no access at all, when the node is
 * hidden (both decided by `requireRole`), in the trash, or a system node; `403 forbidden` only
 * once all of that is settled and the role is too low.
 */
async function visibleNode(c: Ctx, nodeId: string, min: Role): Promise<{ node: Node; access: Access }> {
  await requireRole(c, nodeId, "viewer");
  await assertNotTrashed(c, nodeId);
  const node = await getNode(db(c), nodeId);
  if (!node || node.system !== null) throw new AppError("not_found");
  // Answered from the request's cache: no second question is sent.
  return { node, access: await requireRole(c, nodeId, min) };
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
    const parent = await visibleNode(c, body.parentId, "editor");
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
  audit(c, "node.create_folder", target(created.id), { parentId: body.parentId });
  return c.json(await toNodeDto(db(c), created, view));
});

// ── files-host URLs ─────────────────────────────────────────────────────────────────────────

type UrlKind = "download" | "inline";
type CurrentFile = Node & { versionId: string };

const isoOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** A file the caller may see, with a current version. Anything else is `404`. */
async function visibleFile(c: Ctx, nodeId: string): Promise<{ node: CurrentFile; access: Access }> {
  const { node, access } = await visibleNode(c, nodeId, "viewer");
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
  const { node, access } = await visibleFile(c, nodeId);
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
    const found = await Promise.all(ids.map((id) => visibleNode(c, id, "viewer")));
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
  return c.json(await zipManifest(db(c), roots, { maxFiles: ZIP_MAX_ENTRIES }));
});

router.post("/nodes/download-urls", async (c) => {
  const user = requireVerified(c);
  assertContentAccess(c);
  const { nodeIds } = parse(BatchDownloadUrlsBody, await jsonBody(c));
  const items = await Promise.all(
    nodeIds.map(async (nodeId): Promise<BatchDownloadUrlItem> => {
      try {
        const { answer } = await mintUrl(c, user, nodeId, "download", true);
        return { nodeId, url: answer.url, expiresAt: answer.expiresAt };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const code: ErrorCode = error.code;
        metric("download", { kind: "download", outcome: code });
        return { nodeId, error: code };
      }
    }),
  );
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
  const { node, access } = await visibleNode(c, c.req.param("id"), "viewer");
  if (node.kind !== "folder") throw new AppError("not_found");
  const page = await listChildren(db(c), {
    scope: { ownerId: node.ownerId },
    parentId: node.id,
    ...query,
    visibleStatuses: statusesFor(access),
  });
  // A child has the role of the folder it is listed in.
  const items = await toNodeDtos(db(c), page.items, viewOf(user, access));
  return c.json({ items, nextCursor: page.nextCursor } satisfies NodePage);
});

router.get(`/nodes/${ID}`, async (c) => {
  const user = requireVerified(c);
  const { node, access } = await visibleNode(c, c.req.param("id"), "viewer");
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
  const found = await visibleNode(c, id, "viewer");
  const { access } = found;
  let node = found.node;
  // Both permissions before either write: a refused half must not leave the other half done.
  if (body.starred !== undefined && access.role !== "owner") throw new AppError("forbidden");
  if (body.name !== undefined) {
    await requireRole(c, id, "editor");
    // A share gives a role INSIDE the shared node; the node itself stays its owner's to name.
    if (access.shareRootId === id) throw new AppError("forbidden");
  }

  if (body.name !== undefined) {
    node = await rename(db(c), id, body.name);
    audit(c, "node.rename", target(id), null);
  }
  if (body.starred !== undefined) {
    if (!(await setStar(db(c), id, body.starred))) throw new AppError("not_found");
    node = { ...node, starred: body.starred };
    audit(c, "node.star", target(id), { starred: body.starred });
  }
  return c.json(await toNodeDto(db(c), node, viewOf(user, access)));
});

/**
 * The move itself. `move` takes the owner's tree lock as its first statement, so it is the first
 * thing in the transaction; the transaction is opened — and run again when Postgres ends it as a
 * deadlock victim — by `retryOnDeadlock`. DATABASE STATEMENTS ONLY inside the callback: it may
 * run more than once. The audit row and the metrics come after it has returned.
 *
 * ONE ANSWER for every move that cannot be: a cycle, a taken name, and a node that may not leave
 * the folder it is in — the same `409 conflict`, with the same words and nothing else, so that
 * none of the three can be told from the others. `LegalHoldError` is caught here because
 * nothing may ever show it: not its causes, not that it happened.
 */
async function moveNode(c: Ctx, nodeId: string, parentId: string | null): Promise<Node> {
  try {
    return await retryOnDeadlock(deps(c).db, (tx) => move(tx, nodeId, parentId));
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
  const { node, access } = await visibleNode(c, id, "editor");
  if (access.shareRootId === id) throw new AppError("forbidden");
  if (body.parentId === null) {
    // The top level of a tree is its owner's alone: no share reaches it.
    if (access.role !== "owner") throw new AppError("forbidden");
  } else {
    await visibleNode(c, body.parentId, "editor");
  }
  const moved = await moveNode(c, id, body.parentId);
  audit(c, "node.move", target(id), { from: node.parentId, to: body.parentId });
  metric("node", { kind: "move", outcome: "ok" });
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
  const { node } = await visibleFile(c, c.req.param("id"));
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
  const { node } = await visibleNode(c, id, "owner");
  if (node.kind !== "file") throw new AppError("not_found");
  // Before the throttle: a request that cannot be granted must not use up the hour.
  if (node.scanStatus !== "error" && node.scanStatus !== "skipped") throw new AppError("conflict");
  if (!(await requestRescan(db(c), id))) {
    const since = node.rescanRequestedAt ? (now(c).getTime() - node.rescanRequestedAt.getTime()) / 1000 : 0;
    const wait = Math.min(RESCAN_EVERY_SEC, Math.max(1, Math.ceil(RESCAN_EVERY_SEC - since)));
    throw new AppError("rate_limited", undefined, undefined, { "Retry-After": String(wait) });
  }
  // Decides on the locked row, and answers `404` itself for a file that may not be rescanned.
  await enqueueRescan(deps(c), id, { by: "owner" });
  audit(c, "node.rescan", target(id), null);
  return c.json({ ok: true }, 202);
});
