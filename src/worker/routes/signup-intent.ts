// POST /api/auth-intent — the step before "Continue with Google" on the sign-up screen.
//
// A Google sign-up cannot carry the invite code, the age check or the terms assent through
// Google and back, so the sign-up screen states them here first. This route applies what can be
// checked without an address — the kill switch, assent, age, and that the invite would admit a
// sign-up (nothing is consumed) — and answers with a short-lived signed cookie (`hf_intent`,
// auth/signed-cookie.ts). When Google's callback is about to create the account, the sign-up
// policy reads that cookie, checks the address (allowed domains, disposable, velocity), uses the
// invite and deletes the intent's single-use marker. Without the cookie a Google SIGN-UP is
// refused; a Google sign-in of an existing account never needs it.
//
// Paths are relative to /api. CSRF and RL_AUTH are applied by the pipeline.

import { generateId } from "@better-auth/core/utils/id";
import { Hono } from "hono";
import { scopeOf } from "../auth/create-auth";
import { INTENT_COOKIE, mintIntent, setCookieHeader } from "../auth/signed-cookie";
import { insertIntent } from "../db/queries/auth-lifecycle";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { auth, type AppEnv } from "../services/request-context";
import { parseStatement, precheckSignup, SignupRefusal } from "../services/signup-policy";

export const router = new Hono<AppEnv>();

router.post("/auth-intent", async (c) => {
  const scope = scopeOf(auth(c));
  if (!scope) throw new Error("no auth scope");
  const at = now(c);
  try {
    const statement = parseStatement(await jsonBody(c), at);
    await precheckSignup(scope, null, statement);
    const intent = await mintIntent(scope.keys, statement.inviteCode, at);
    await insertIntent(scope.db, {
      id: generateId(),
      nonce: intent.nonce,
      expiresAt: intent.expiresAt,
      now: at,
    });
    c.header("Set-Cookie", setCookieHeader(c.env, INTENT_COOKIE, intent.value));
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof SignupRefusal)
      throw new AppError("validation", error.message, { reason: error.code });
    throw error;
  }
});
