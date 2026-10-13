// Shares with people.

import { z } from "zod";
import { Email, NodeId, RowId, Timestamp, UserRef } from "./common";
import { LinkDto } from "./link";
import { hasAField, NodeDto, NodeKind, NOTHING_TO_CHANGE } from "./node";

export const ShareRole = z.enum(["viewer", "editor"]);
export type ShareRole = z.infer<typeof ShareRole>;

/**
 * IDENTICAL whether or not the address has an account: no "pending" flag and no display name.
 * That is what keeps a share to an unknown address from telling the owner who has an account.
 * `email` is the address as the owner typed it.
 */
export const ShareDto = z.object({
  id: RowId,
  nodeId: NodeId,
  email: z.string(),
  role: ShareRole,
  canUpload: z.boolean(),
  createdAt: Timestamp,
});
export type ShareDto = z.infer<typeof ShareDto>;

export const CreateShareBody = z.strictObject({
  email: Email,
  role: ShareRole,
  canUpload: z.boolean().optional(),
});
export type CreateShareBody = z.infer<typeof CreateShareBody>;

/** `mutedByGrantee` is the recipient's own switch; the other two are the owner's. */
export const PatchShareBody = z
  .strictObject({
    role: ShareRole.optional(),
    canUpload: z.boolean().optional(),
    mutedByGrantee: z.boolean().optional(),
  })
  .refine(hasAField, NOTHING_TO_CHANGE);
export type PatchShareBody = z.infer<typeof PatchShareBody>;

/** `GET /api/nodes/:id/sharing`. `inheritedFrom`: the ancestor whose shares also reach this node. */
export const NodeSharingDto = z.object({
  shares: z.array(ShareDto),
  links: z.array(LinkDto),
  inheritedFrom: z.object({ nodeId: NodeId, name: z.string() }).nullable(),
});
export type NodeSharingDto = z.infer<typeof NodeSharingDto>;

export const SharedWithMeDto = z.object({
  node: NodeDto,
  role: ShareRole,
  owner: UserRef,
  sharedAt: Timestamp,
});
export type SharedWithMeDto = z.infer<typeof SharedWithMeDto>;

export const SharesMineDto = z.object({
  node: z.object({ id: NodeId, name: z.string(), kind: NodeKind }),
  shares: z.array(ShareDto),
});
export type SharesMineDto = z.infer<typeof SharesMineDto>;
