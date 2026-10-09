// GET /api/health → { ok, db, r2 }. No auth; rate-limited by IP like every /api path.
// `db` is a literal `select 1` through the request's client; `r2` is a HEAD on a key that need not
// exist (a miss answers null — only a throw is a failure). 503 when either fails.
// The body says which half failed and nothing more: no error text.

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

const HEALTH_PROBE_KEY = "health-probe";

async function ok(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

router.get("/health", async (c) => {
  const [database, r2] = await Promise.all([
    ok(async () => db(c).execute(sql`select 1`)),
    ok(async () => c.env.FILES.head(HEALTH_PROBE_KEY)),
  ]);
  const healthy = database && r2;
  return c.json({ ok: healthy, db: database, r2 }, healthy ? 200 : 503);
});
