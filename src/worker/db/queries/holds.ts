// What must be KEPT: one definition, shared by the purge gate (`trash.assertPurgeable`) and by
// every retention delete of records ABOUT a node or an account (uploader addresses, finished
// upload sessions, the retention jobs' own) — so that they cannot disagree about it.
//
// A NODE IS PROTECTED for any of the gate's five causes (`HoldCause`, db/errors.ts): a legal
// hold on it, its OWNER's legal hold, `under_review`, `suspected_csam`, or an open DMCA notice
// that names it.
//
// TWO OF THEM REACH DOWN FROM A FOLDER: a legal hold and an open notice on any ANCESTOR protect
// everything under it — a folder taken down as `csam` is held as ONE row, and a file inside it
// must not be purged on its own (it was trashed earlier, its old version is due, its uploader's
// address is 90 days old). `under_review` and `suspected_csam` are states of one file and are
// not inherited; the owner is the same for the whole tree.
//
// `ownCauses` is the five as SQL over one node row, `inheritedCauses` the two over its
// ancestors, `holdCauses` their OR per cause — keyed by cause, so the type makes a sixth cause a
// compile error here until it has its SQL. The gate reports them one by one (for a subtree:
// every row's own causes, and the ROOT's inherited ones — the ancestors of a row inside the
// subtree are rows of the subtree or ancestors of the root); `nodeProtected` is their OR.
//
// The predicates are for a query over some OTHER table; the argument is that query's column
// holding a user id or a node id. An id with no row is not held — `upload_ips` keeps no foreign
// key and outlives both the node and the account.

import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import type { HoldCause } from "../errors";
import { OPEN_NOTICE_STATUSES } from "./moderation";

const openStatuses = sql.join(
  OPEN_NOTICE_STATUSES.map((status) => sql.raw(`'${status}'`)),
  sql`, `,
);

const openNoticeOn = (nodeId: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM dmca_notice_nodes dn JOIN dmca_notices d ON d.id = dn.notice_id
  WHERE dn.node_id = ${nodeId} AND d.status IN (${openStatuses}))`;

/**
 * The causes a node row has OF ITS OWN, given the SQL names the query uses for the row and for
 * its owner's `user` row (`n` and `u`, say). Inside, the names `dn` and `d` are taken.
 */
export function ownCauses(node: SQL, owner: SQL): Record<HoldCause, SQL> {
  return {
    node_legal_hold: sql`${node}.legal_hold`,
    owner_legal_hold: sql`${owner}.legal_hold`,
    under_review: sql`${node}.scan_status = 'under_review'`,
    suspected_csam: sql`${node}.scan_status = 'suspected_csam'`,
    open_notice: openNoticeOn(sql`${node}.id`),
  };
}

/** The causes that reach down from a folder. */
export const INHERITED_CAUSES = ["node_legal_hold", "open_notice"] as const satisfies readonly HoldCause[];
export type InheritedCause = (typeof INHERITED_CAUSES)[number];

/** Some folder above the node row satisfies `test` (over the walk's row `held_up`): ONE walk. */
const above = (node: SQL, test: SQL): SQL => sql`EXISTS (
  WITH RECURSIVE held_up(id, parent_id, legal_hold) AS (
    SELECT ha.id, ha.parent_id, ha.legal_hold FROM nodes ha WHERE ha.id = ${node}.parent_id
    UNION ALL
    SELECT hp.id, hp.parent_id, hp.legal_hold FROM nodes hp JOIN held_up ON hp.id = held_up.parent_id
  ) CYCLE id SET is_cycle USING path
  SELECT 1 FROM held_up WHERE ${test})`;

const INHERITED_TESTS: Record<InheritedCause, SQL> = {
  node_legal_hold: sql`held_up.legal_hold`,
  open_notice: openNoticeOn(sql`held_up.id`),
};

/**
 * The causes a node row has THROUGH AN ANCESTOR, one by one (a walk up `parent_id` from the
 * row's parent each). Inside, the names `held_up`, `ha`, `hp`, `dn` and `d` are taken.
 */
export function inheritedCauses(node: SQL): Record<InheritedCause, SQL> {
  return {
    node_legal_hold: above(node, INHERITED_TESTS.node_legal_hold),
    open_notice: above(node, INHERITED_TESTS.open_notice),
  };
}

/**
 * The gate's causes for ONE node row: its own, or — for the two that reach down — an ancestor's.
 */
export function holdCauses(node: SQL, owner: SQL): Record<HoldCause, SQL> {
  const own = ownCauses(node, owner);
  const inherited = inheritedCauses(node);
  return {
    ...own,
    node_legal_hold: sql`(${own.node_legal_hold} OR ${inherited.node_legal_hold})`,
    open_notice: sql`(${own.open_notice} OR ${inherited.open_notice})`,
  };
}

/**
 * Any of the causes: the node row `node` (owner row `owner`) may not be purged now. The same
 * tests as `holdCauses`, with the inherited ones asked in ONE walk up the tree instead of two.
 */
export function anyHoldCause(node: SQL, owner: SQL): SQL {
  const own = sql.join(Object.values(ownCauses(node, owner)), sql` OR `);
  const inherited = above(node, sql`(${sql.join(Object.values(INHERITED_TESTS), sql` OR `)})`);
  return sql`(${own} OR ${inherited})`;
}

/** The user with this id exists and is on legal hold. (Inside, the name `held_user` is taken.) */
export function userHeld(userId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM "user" held_user WHERE held_user.id = ${userId} AND held_user.legal_hold)`;
}

/**
 * The node with this id exists and the purge gate would refuse it — exactly `assertPurgeable`'s
 * five causes, the owner's hold included, and a hold or an open notice on any ancestor. Records
 * about such a node are kept. (Inside, the names `kept_node` and `kept_owner` are taken.)
 *
 * A node that no longer exists is not protected: nothing but the id is left of it. For a row
 * about such a node, test the row's own flag and `userHeld` of the users the row names.
 */
export function nodeProtected(nodeId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM nodes kept_node JOIN "user" kept_owner ON kept_owner.id = kept_node.owner_id
    WHERE kept_node.id = ${nodeId} AND ${anyHoldCause(sql`kept_node`, sql`kept_owner`)})`;
}

/**
 * What a re-parenting would strip from the node: the causes of every folder above it that
 * PROTECTS it where it stands (is on legal hold, or named by an open notice) and would no
 * longer be above it under `newParentId` (null = the top level). Empty = the move is safe.
 *
 * It compares the FOLDERS, not the kinds of protection: from under one held folder into
 * another held folder is a loss — the second hold may be released tomorrow while the first
 * still stands. So a node stays inside the subtree of every folder that protects it (with
 * nested ones, under the deepest); moving within it, or deeper into further protection, is free.
 *
 * ONE statement, whatever the answer — protected or not, known destination or not — so the
 * refusal cannot be told from an ordinary move by the work done here. Call it under the owner's
 * tree lock (queries/tree.ts): the answer is about the tree's shape. Empty for an unknown node.
 */
export async function lostByLeaving(
  tx: Executor,
  nodeId: string,
  newParentId: string | null,
): Promise<InheritedCause[]> {
  const result = await tx.execute<Record<InheritedCause, boolean>>(sql`
    WITH RECURSIVE held_up(id, parent_id, legal_hold) AS (
      SELECT ha.id, ha.parent_id, ha.legal_hold FROM nodes ha
      WHERE ha.id = (SELECT moved.parent_id FROM nodes moved WHERE moved.id = ${nodeId})
      UNION ALL
      SELECT hp.id, hp.parent_id, hp.legal_hold FROM nodes hp JOIN held_up ON hp.id = held_up.parent_id
    ) CYCLE id SET is_cycle USING path,
    dest(id, parent_id) AS (
      SELECT da.id, da.parent_id FROM nodes da WHERE da.id = ${newParentId}::uuid
      UNION ALL
      SELECT dp.id, dp.parent_id FROM nodes dp JOIN dest ON dp.id = dest.parent_id
    ) CYCLE id SET dest_cycle USING dest_path,
    left_behind AS (
      SELECT held_up.legal_hold AS node_legal_hold, ${openNoticeOn(sql`held_up.id`)} AS open_notice
      FROM held_up WHERE held_up.id NOT IN (SELECT id FROM dest)
    )
    SELECT COALESCE(bool_or(node_legal_hold), false) AS node_legal_hold,
           COALESCE(bool_or(open_notice), false) AS open_notice
    FROM left_behind`);
  const row = result.rows[0];
  return row ? INHERITED_CAUSES.filter((cause) => row[cause] === true) : [];
}
