// GET /api/health → { ok, db, r2, config }. No auth; rate-limited by IP like every /api path.
// `db` is a literal `select 1` through the request's client; `r2` is a HEAD on a key that need not
// exist (a miss answers null — only a throw is a failure). 503 when either fails.
// The body says which half failed and nothing more: no error text.

import { parseAdminList } from "../../shared/admin-emails";
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
  // `config`: false when a configuration value is malformed in a way that silently grants or
  // denies something — today, an ADMIN_EMAILS entry that is not one plain address (it is ignored;
  // shared/admin-emails.ts). A boolean only: never a count, never a value. Gate A checks it.
  const config = parseAdminList(c.env.ADMIN_EMAILS).invalid === 0;
  return c.json({ ok: healthy, db: database, r2, config }, healthy ? 200 : 503);
});
