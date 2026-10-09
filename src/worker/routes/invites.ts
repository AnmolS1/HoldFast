// GET /api/invites/:code → { valid: boolean } — for the /invite/:code prefill on the sign-up
// screen. It says only whether the code would admit a sign-up right now, never why not (unknown,
// used up, expired and revoked are one answer). Nothing is consumed.
//
// Paths are relative to /api. The pipeline applies RL_AUTH to this path: a code is guessable.

import { Hono } from "hono";
import { inviteUsable } from "../db/queries/auth-lifecycle";
import { db, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

router.get("/invites/:code{[A-Za-z0-9_-]{1,128}}", async (c) => {
  return c.json({ valid: await inviteUsable(db(c), c.req.param("code")) });
});
