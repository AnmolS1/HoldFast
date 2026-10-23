// The scan state of many files in one request (R1 m16: perfops-2, func-n2). Paths are relative to
// /api.
//
//   POST /api/nodes/scan-status   { ids: [≤ SCAN_STATUS_MAX_IDS node ids] }  →  { items: NodeDto[] }
//
// What the upload ribbon (and anything else following scans) asks instead of one
// `GET /api/nodes/:id` per file and per second: ≈ 10 statements per file before, a handful per
// request now.
//
// THE ANSWER IS `GET /api/nodes/:id`'S, FILE BY FILE. An item is there exactly when that route would
// answer the id with a file — and as that route's `node`; every other id is simply LEFT OUT: one
// that was never issued, one the caller has no share to, a node hidden from everyone but an admin
// (taken down itself or by a folder above, locked as suspected CSAM), one in the trash, a file a
// share partner may not see, a system node (an avatar), a folder. Left out alike, and for the same
// work: such an id always reaches `getAccess` (services/permissions.ts, the one place that
// decides), whatever the reason. Only the caller's own VISIBLE files take the fast path — one
// statement for all of them — and those they can read one by one anyway.
//
// Bounded (zod: 1 … SCAN_STATUS_MAX_IDS ids, a repeated id asked once), behind RL_API and the
// identity pin like every /api request.

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { NodeId } from "../../shared/schemas/common";
import { NodeDto } from "../../shared/schemas/node";
import { nodes, type Node } from "../db/schema";
import { notEffectivelyTrashedOrHidden } from "../db/queries/tree";
import { requireVerified } from "../middleware/guards";
import { jsonBody } from "../services/body";
import { AppError } from "../services/errors";
import { toNodeDtos } from "../services/node-dto";
import { getAccess, type Access } from "../services/permissions";
import { db, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

/** The most ids one request may ask about (the client's batch is the same size). */
export const SCAN_STATUS_MAX_IDS = 100;

export const ScanStatusBody = z.strictObject({ ids: z.array(NodeId).min(1).max(SCAN_STATUS_MAX_IDS) });
export const ScanStatusResponse = z.object({ items: z.array(NodeDto) });
export type ScanStatusResponse = z.infer<typeof ScanStatusResponse>;

router.post("/nodes/scan-status", async (c) => {
  const user = requireVerified(c);
  const parsed = ScanStatusBody.safeParse(await jsonBody(c));
  if (!parsed.success) {
    throw new AppError("validation", undefined, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const ids = [...new Set(parsed.data.ids)];

  // The caller's own files that `GET /api/nodes/:id` would show them — the owner's rules of
  // `getAccess` as one statement: not hidden (itself, or a folder above), not locked, not in the
  // trash (itself, or a folder above), no system node, a file.
  const owned = await db(c)
    .select()
    .from(nodes)
    .where(
      and(
        inArray(nodes.id, ids),
        eq(nodes.ownerId, user.id),
        eq(nodes.kind, "file"),
        isNull(nodes.system),
        ne(nodes.scanStatus, "suspected_csam"),
        notEffectivelyTrashedOrHidden("nodes"),
      ),
    );
  const mine = new Set(owned.map((row) => row.id));

  // Everything else, one id at a time, through the one decision — the same statements for an id
  // that was never issued as for one that is hidden or someone else's — then ONE read of all of
  // them, whatever was granted (what is answered is decided after it).
  const rest = ids.filter((id) => !mine.has(id));
  const granted = new Map<string, Access>();
  for (const id of rest) {
    const access = await getAccess(c, id, { notTrashed: true });
    if (access) granted.set(id, access);
  }
  const shared: Node[] =
    rest.length === 0
      ? []
      : (await db(c).select().from(nodes).where(inArray(nodes.id, rest))).filter(
          (row) => granted.has(row.id) && row.kind === "file" && row.system === null,
        );

  const items: NodeDto[] = [];
  if (owned.length > 0) {
    items.push(...(await toNodeDtos(db(c), owned, { viewerId: user.id, role: "owner" })));
  }
  // A partner's view starts at the node their share is on: one batch per such root (a file that
  // IS the root goes out without its parent, as `GET /api/nodes/:id` sends it).
  const byRoot = new Map<string | null, Node[]>();
  for (const row of shared) {
    const root = granted.get(row.id)!.viewRootId;
    byRoot.set(root, [...(byRoot.get(root) ?? []), row]);
  }
  for (const [root, rows] of byRoot) {
    items.push(
      ...(await toNodeDtos(db(c), rows, {
        viewerId: user.id,
        role: (row) => granted.get(row.id)!.role,
        shareRootId: root,
      })),
    );
  }
  return c.json({ items } satisfies ScanStatusResponse);
});
