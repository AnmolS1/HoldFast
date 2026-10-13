// What must be KEPT: one definition, shared by the purge gate (`trash.assertPurgeable`) and by
// every retention delete of records ABOUT a node or an account (uploader addresses, finished
// upload sessions, the retention jobs' own) — so that they cannot disagree about it.
//
// A NODE IS PROTECTED for any of the gate's five causes (`HoldCause`, db/errors.ts): its own
// legal hold, its OWNER's legal hold, `under_review`, `suspected_csam`, or an open DMCA notice
// that names it. `holdCauses` is those five as SQL, keyed by cause: the gate reports them one by
// one, `nodeProtected` is their OR, and the type makes a sixth cause a compile error here until
// it has its SQL.
//
// The predicates are for a query over some OTHER table; the argument is that query's column
// holding a user id or a node id. An id with no row is not held — `upload_ips` keeps no foreign
// key and outlives both the node and the account.

import { sql, type SQL } from "drizzle-orm";
import type { HoldCause } from "../errors";
import { OPEN_NOTICE_STATUSES } from "./moderation";

const openStatuses = sql.join(
  OPEN_NOTICE_STATUSES.map((status) => sql.raw(`'${status}'`)),
  sql`, `,
);

/**
 * The gate's causes over ONE node row and its owner's `user` row, given the SQL names the query
 * uses for the two (`n` and `u`, say). Inside, the names `dn` and `d` are taken.
 */
export function holdCauses(node: SQL, owner: SQL): Record<HoldCause, SQL> {
  return {
    node_legal_hold: sql`${node}.legal_hold`,
    owner_legal_hold: sql`${owner}.legal_hold`,
    under_review: sql`${node}.scan_status = 'under_review'`,
    suspected_csam: sql`${node}.scan_status = 'suspected_csam'`,
    open_notice: sql`EXISTS (
      SELECT 1 FROM dmca_notice_nodes dn JOIN dmca_notices d ON d.id = dn.notice_id
      WHERE dn.node_id = ${node}.id AND d.status IN (${openStatuses}))`,
  };
}

/** Any of the causes: the node row `node` (owner row `owner`) may not be purged now. */
export function anyHoldCause(node: SQL, owner: SQL): SQL {
  return sql`(${sql.join(Object.values(holdCauses(node, owner)), sql` OR `)})`;
}

/** The user with this id exists and is on legal hold. (Inside, the name `held_user` is taken.) */
export function userHeld(userId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM "user" held_user WHERE held_user.id = ${userId} AND held_user.legal_hold)`;
}

/**
 * The node with this id exists and the purge gate would refuse it for a cause of its own —
 * exactly `assertPurgeable`'s five, the owner's hold included. Records about such a node are
 * kept. (Inside, the names `kept_node` and `kept_owner` are taken.)
 *
 * A node that no longer exists is not protected: nothing but the id is left of it. For a row
 * about such a node, test the row's own flag and `userHeld` of the users the row names.
 */
export function nodeProtected(nodeId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM nodes kept_node JOIN "user" kept_owner ON kept_owner.id = kept_node.owner_id
    WHERE kept_node.id = ${nodeId} AND ${anyHoldCause(sql`kept_node`, sql`kept_owner`)})`;
}
