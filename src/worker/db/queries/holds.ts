// What "on legal hold" means to a retention delete: one definition, so that the deletes that
// must skip held rows (uploader addresses, finished upload sessions, the retention jobs' own)
// cannot disagree about it.
//
// Each is a predicate for a query over some other table; the argument is that query's column
// holding a user id or a node id. An id with no row is not held — `upload_ips` keeps no foreign
// key and outlives both the node and the account.

import { sql, type SQL } from "drizzle-orm";

/** The user with this id exists and is on legal hold. (Inside, the name `held_user` is taken.) */
export function userHeld(userId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM "user" held_user WHERE held_user.id = ${userId} AND held_user.legal_hold)`;
}

/** The node with this id exists and is on legal hold. (Inside, the name `held_node` is taken.) */
export function nodeHeld(nodeId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM nodes held_node WHERE held_node.id = ${nodeId} AND held_node.legal_hold)`;
}
