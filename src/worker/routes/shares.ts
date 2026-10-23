// Shares to people. Paths are relative to /api; every route needs a verified, signed-in user.
//
//   GET    /nodes/:id/sharing   the node's sharing panel: shares, links, the folder above it shares
//   POST   /nodes/:id/shares    the owner shares the node with an address (an account or not yet)
//   GET    /shares/mine         everything the caller shared with people, grouped by node
//   PATCH  /shares/:id          the owner: role, upload toggle; the grantee: mute
//   DELETE /shares/:id          the owner removes it; the grantee leaves
//   GET    /shared-with-me      the shares other people made to the caller
//
// WHO MAY SEE WHAT is services/permissions.ts: a node id goes through `requireRole` / `getAccess`
// before anything is read about it, so a node that does not exist, one the caller has no share to
// and one that is HIDDEN (taken down — itself or by a folder above — or locked) are the same
// `404 not_found`. This file has no test of its own for any of these.
//
// A SHARE TO AN ADDRESS SAYS NOTHING ABOUT THE ADDRESS. Whether an account has it, whether that
// account is verified: the answer is the same `ShareDto` (no name, no "pending" flag), and the
// work is the same — one read of the address, one insert, one mail.

import { Hono, type Context } from "hono";
import { UUID_PARAM } from "../../shared/ids";
import {
  CreateShareBody,
  PatchShareBody,
  type NodeSharingDto,
  type ShareDto,
  type SharedWithMeDto,
  type SharesMineDto,
} from "../../shared/schemas/share";
import { QueryError } from "../db/errors";
import { retryOnDeadlock } from "../db/retry";
import { SHARED_VISIBLE_STATUSES } from "../db/queries/nodes";
import { countGrantees, sharedByMe, sharedWithMe } from "../db/queries/shares";
import {
  deleteShare,
  insertShare,
  linksOnNode,
  nearestSharedAncestor,
  shareById,
  shareRecipient,
  sharesOnNode,
  updateShare,
} from "../db/queries/sharing";
import type { Share } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { consumeCeiling } from "../services/ceilings";
import { sendShareInvitation } from "../services/email";
import { AppError } from "../services/errors";
import { metric } from "../services/metrics";
import { toNodeDtos } from "../services/node-dto";
import { getAccess } from "../services/permissions";
import { db, defer, deps, type AppEnv } from "../services/request-context";
import { linkDtos, parse, scanGate, sharedNode } from "./links";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const ID = `:id{${UUID_PARAM}}`;

/** People one node may be shared with, pending addresses included. */
export const MAX_GRANTEES = 100;

const target = (nodeId: string) => ({ type: "node", id: nodeId });

export function shareDto(share: Share): ShareDto {
  return {
    id: share.id,
    nodeId: share.nodeId,
    email: share.granteeEmail,
    role: share.role,
    canUpload: share.canUpload,
    createdAt: share.createdAt.toISOString(),
  };
}

// Static paths first, then the ones with an id (the registry test holds the file to it).

router.get("/shares/mine", async (c) => {
  const user = requireVerified(c);
  const rows = await sharedByMe(db(c), user.id);
  const groups = new Map<string, SharesMineDto>();
  for (const { share, node } of rows) {
    let group = groups.get(node.id);
    if (!group) {
      group = { node: { id: node.id, name: node.name, kind: node.kind }, shares: [] };
      groups.set(node.id, group);
    }
    group.shares.push(shareDto(share));
  }
  return c.json([...groups.values()] satisfies SharesMineDto[]);
});

router.get("/shared-with-me", async (c) => {
  const user = requireVerified(c);
  const rows = await sharedWithMe(db(c), user.id, { visibleStatuses: SHARED_VISIBLE_STATUSES });
  // Mapped in ONE batch: the owners' names and the rest are read once for the page (R1 perfops-8).
  // The role is the share's own (an outer share of another role is listed as its own row).
  const roleOf = new Map(rows.map(({ node, share }) => [node, share.role]));
  const dtos = await toNodeDtos(db(c), [...roleOf.keys()], {
    viewerId: user.id,
    role: (node) => roleOf.get(node)!,
  });
  const items = rows.map(({ share }, index): SharedWithMeDto => {
    // Each row is the root of the caller's view of it: it goes out without its parent (what
    // `shareRootId` does for one node; this page has one root per row).
    const node = { ...dtos[index]!, parentId: null };
    return { node, role: share.role, owner: node.owner, sharedAt: share.createdAt.toISOString() };
  });
  return c.json(items satisfies SharedWithMeDto[]);
});

router.get(`/nodes/${ID}/sharing`, async (c) => {
  requireVerified(c);
  const id = c.req.param("id");
  const { node, access } = await sharedNode(c, id, "editor");
  const [shares, links, inheritedFrom] = [
    await sharesOnNode(db(c), node.id),
    await linksOnNode(db(c), node.id),
    // Never above where the caller's view of the tree starts (the owner: the whole chain).
    await nearestSharedAncestor(db(c), node.id, access.viewRootId),
  ];
  return c.json({
    shares: shares.map(shareDto),
    links: await linkDtos(c, links),
    inheritedFrom,
  } satisfies NodeSharingDto);
});

router.post(`/nodes/${ID}/shares`, async (c) => {
  const user = requireVerified(c);
  const id = c.req.param("id");
  const body = parse(CreateShareBody, await jsonBody(c));
  const { node } = await sharedNode(c, id, "owner");
  scanGate(node);
  if (body.email.toLowerCase() === user.email.toLowerCase()) {
    throw new AppError("validation", "You cannot share with yourself.", { reason: "self_share" });
  }
  // A first look, so that a full node charges no ceiling; the insert decides again under a lock.
  if ((await countGrantees(db(c), node.id)) >= MAX_GRANTEES) {
    throw new AppError("conflict", "This item is shared with as many people as it can be.", {
      reason: "grantee_limit",
    });
  }
  // The same statement whoever has the address — or nobody.
  const recipient = await shareRecipient(db(c), body.email);
  const active = recipient !== null && recipient.emailVerified;
  // The last check before the insert. It throws `429` itself; nothing is charged then. A share
  // whose insert fails afterwards stays charged.
  await consumeCeiling(
    c,
    "share_user",
    { id: user.id, account: { quotaBytes: user.quotaBytes, createdAt: user.createdAt } },
    { count: 1 },
  );
  const grantees = () =>
    new AppError("conflict", "This item is shared with as many people as it can be.", {
      reason: "grantee_limit",
    });
  let share: Share;
  try {
    // The cap is decided again under the node's row lock, with the insert: two creations at 99
    // cannot both pass. DATABASE STATEMENTS ONLY inside (it may run again).
    const made = await retryOnDeadlock(deps(c).db, (tx) =>
      insertShare(
        tx,
        {
          nodeId: node.id,
          grantedBy: user.id,
          email: body.email,
          granteeUserId: active ? recipient.id : null,
          role: body.role,
          canUpload: body.canUpload ?? true,
        },
        MAX_GRANTEES,
      ),
    );
    if ("refused" in made) {
      if (made.refused === "gone") throw new AppError("not_found");
      throw grantees();
    }
    share = made.share;
  } catch (error) {
    if (error instanceof QueryError && error.code === "conflict") {
      throw new AppError("conflict", "This item is already shared with that address.", {
        reason: "duplicate",
      });
    }
    throw error;
  }
  audit(c, "share.create", target(node.id), { shareId: share.id, role: share.role });
  metric("share", { kind: "create", outcome: "ok" });
  // The mail is decided in deferred work that starts the SAME way for every address — one read
  // of the address, then a mail or none — so neither the answer nor the work before it says
  // whether an account has it, or whether that account switched share mails off (the notice is
  // theirs to refuse; a stranger's invitation is not).
  const notify = async () => {
    const now = await shareRecipient(deps(c).db, body.email);
    if (now !== null && now.emailVerified && !now.emailShares) return;
    await sendShareInvitation(deps(c), {
      to: body.email,
      sharerName: user.name,
      itemName: node.name,
      role: share.role,
      hasAccount: active,
      senderId: user.id,
    });
  };
  defer(
    c,
    notify().catch(() => {}),
  );
  return c.json(shareDto(share), 201);
});

/** The share and who the caller is to it. Anyone else — or a node they cannot see — is `404`. */
async function shareFor(c: Ctx, shareId: string, userId: string) {
  const share = await shareById(db(c), shareId);
  if (!share) throw new AppError("not_found");
  const access = await getAccess(c, share.nodeId, { notTrashed: true });
  const isOwner = access?.role === "owner";
  const isGrantee = access !== null && share.granteeUserId === userId;
  if (!isOwner && !isGrantee) throw new AppError("not_found");
  return { share, isOwner, isGrantee };
}

router.patch(`/shares/${ID}`, async (c) => {
  const user = requireVerified(c);
  const body = parse(PatchShareBody, await jsonBody(c));
  const { share, isOwner, isGrantee } = await shareFor(c, c.req.param("id"), user.id);
  // Both permissions before any write.
  const ownerPart = body.role !== undefined || body.canUpload !== undefined;
  if (ownerPart && !isOwner) throw new AppError("forbidden", undefined, { reason: "role" });
  if (body.mutedByGrantee !== undefined && !isGrantee)
    throw new AppError("forbidden", undefined, { reason: "role" });
  const updated = await updateShare(db(c), share.id, body);
  if (!updated) throw new AppError("not_found");
  if (ownerPart) {
    audit(c, "share.update", target(share.nodeId), {
      shareId: share.id,
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.canUpload !== undefined ? { canUpload: body.canUpload } : {}),
    });
  }
  return c.json(shareDto(updated));
});

router.delete(`/shares/${ID}`, async (c) => {
  const user = requireVerified(c);
  const { share, isOwner } = await shareFor(c, c.req.param("id"), user.id);
  if (!(await deleteShare(db(c), share.id))) throw new AppError("not_found");
  audit(c, "share.delete", target(share.nodeId), { shareId: share.id, by: isOwner ? "owner" : "grantee" });
  metric("share", { kind: "delete", outcome: "ok" });
  return c.body(null, 204);
});
