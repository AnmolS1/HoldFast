// The account-lifecycle endpoints that are ours. Paths are relative to /api.
//
//   POST /api/account/accept-terms { version }   accept the current terms (the terms gate refuses
//                                                 every other mutation with 403 terms_required
//                                                 until this succeeds, and re-reads the database,
//                                                 so the accept takes effect at once)
//   POST /api/account/deletion/cancel            cancel a scheduled deletion — the ONLY way one
//                                                 is cancelled (signing in never does)
//   GET  /api/account/deletion-status            { scheduledFor: string | null }
//
// There is no "request deletion" route here: a deletion is requested through Better Auth's own
// POST /api/auth/delete-user, which mails a link; following it reaches `deleteUser.beforeDelete`
// (auth/create-auth.ts), which schedules the deletion instead of performing it.
//
// A held account answers exactly like any other on all three.

import { Hono } from "hono";
import { z } from "zod";
import { guard } from "../auth/observe";
import { getAccount } from "../db/queries/auth-lifecycle";
import { requireUser } from "../middleware/guards";
import { acceptTerms, cancelDeletion } from "../services/account-state";
import { jsonBody } from "../services/body";
import { db, deps, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

const AcceptTermsBody = z.object({ version: z.string().min(1).max(64) });

router.post(
  "/account/accept-terms",
  guard("accept_terms", async (c) => {
    const user = requireUser(c);
    const { version } = AcceptTermsBody.parse(await jsonBody(c));
    await acceptTerms(deps(c), user.id, version);
    return c.json({ ok: true, termsVersion: version });
  }),
);

router.post(
  "/account/deletion/cancel",
  guard("deletion_cancel", async (c) => {
    const user = requireUser(c);
    await cancelDeletion(deps(c), user.id);
    return c.json({ scheduledFor: null });
  }),
);

router.get(
  "/account/deletion-status",
  guard("deletion_status", async (c) => {
    const user = requireUser(c);
    // From the database: a cancel shows at once.
    const account = await getAccount(db(c), user.id);
    return c.json({ scheduledFor: account?.deleteScheduledAt?.toISOString() ?? null });
  }),
);
