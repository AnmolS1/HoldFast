// GET /api/recent  → RecentResponse: the caller's own most recently opened files, newest first.
// GET /api/starred → StarredResponse: the caller's own starred nodes by name, folders first.
//
// Both are the caller's OWN nodes only — nothing shared with them — through T05's `listRecent`
// and `listStarred`, which leave out what is in the trash, the avatar and anything taken down
// (itself or by a folder above it). This file writes no SQL and filters nothing afterwards.
//
// `lastAccessedAt` is written where a file is opened (the download mint and the files host);
// here it is only read.
//
// Paths are relative to /api.

import { Hono } from "hono";
import {
  RecentQuery,
  StarredQuery,
  type RecentResponse,
  type StarredResponse,
} from "../../shared/schemas/search";
import { listRecent, listStarred, OWNER_VISIBLE_STATUSES } from "../db/queries/nodes";
import { requireVerified } from "../middleware/guards";
import { toNodeDtos } from "../services/node-dto";
import { db, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

router.get("/recent", async (c) => {
  const user = requireVerified(c);
  const query = RecentQuery.parse(c.req.query());
  const rows = await listRecent(db(c), user.id, {
    limit: query.limit,
    visibleStatuses: OWNER_VISIBLE_STATUSES,
  });
  const body: RecentResponse = {
    items: await toNodeDtos(db(c), rows, { viewerId: user.id, role: "owner" }),
  };
  return c.json(body);
});

router.get("/starred", async (c) => {
  const user = requireVerified(c);
  const query = StarredQuery.parse(c.req.query());
  const page = await listStarred(db(c), user.id, {
    cursor: query.cursor,
    limit: query.limit,
    visibleStatuses: OWNER_VISIBLE_STATUSES,
  });
  const body: StarredResponse = {
    items: await toNodeDtos(db(c), page.items, { viewerId: user.id, role: "owner" }),
    nextCursor: page.nextCursor,
  };
  return c.json(body);
});
