// PATCH /api/account/pending-email { email } — fix a mistyped address BEFORE it is verified.
//
// WHO MAY CALL IT. With verification required, Better Auth gives an unverified account no
// session, so "a session of an unverified user" (what the plan first asked for) cannot exist for
// an email-and-password sign-up. The proof used instead is the `hf_pending` cookie that the
// sign-up response set in this browser (auth/signed-cookie.ts, auth/hooks.ts): one hour, signed,
// naming the account that sign-up created. (A session of an unverified user is honoured too,
// should one ever exist.)
//
// NO ORACLE. The answer is `{ ok: true }` and a fresh cookie whenever the cookie and the new
// address are acceptable — whether the account was updated, or the sign-up was the look-alike
// answer for an address that already has an account, or the new address belongs to someone
// else. Only the new address ITSELF can make it fail (not an address, a disposable or
// disallowed domain). The response is held to a minimum time for the same reason.
//
// The account is changed only while it is unverified (the condition is part of the UPDATE), the
// old verification link stops working (it names the old address, which no account has any
// more), and a new one is sent to the new address. One sign-up may do this five times.
//
// Paths are relative to /api. The pipeline applies CSRF; RL_AUTH is applied here.

import { createEmailVerificationToken } from "better-auth/api";
import { Hono } from "hono";
import { z } from "zod";
import { scopeOf, VERIFICATION_EXPIRES_IN_S } from "../auth/create-auth";
import {
  mintPending,
  PENDING_COOKIE,
  PENDING_MAX_CHANGES,
  readPending,
  setCookieHeader,
} from "../auth/signed-cookie";
import { getAccount, replaceUnverifiedEmail } from "../db/queries/auth-lifecycle";
import { ipKey } from "../middleware/rate-limit";
import { guard, record } from "../auth/observe";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { sendVerification } from "../services/email";
import { AppError } from "../services/errors";
import { enforceRateLimit } from "../services/ratelimit";
import { auth, db, defer, deps, type AppEnv } from "../services/request-context";
import { emailProblem, SIGNUP_REFUSALS } from "../services/signup-policy";

export const router = new Hono<AppEnv>();

const Body = z.object({ email: z.email().max(254) });

/** Every answer takes at least this long, so its timing says nothing about the account. */
export const PENDING_EMAIL_MIN_MS = 400;

/** Where the verification link sends the browser afterwards (the same as at sign-up). */
const VERIFIED_CALLBACK = "/login?reason=verified";

router.patch(
  "/account/pending-email",
  guard("pending_email", async (c) => {
    const started = Date.now();
    const scope = scopeOf(auth(c));
    if (!scope) throw new Error("no auth scope");
    await enforceRateLimit(c.env, "RL_AUTH", ipKey(c.get("ip")));

    const at = now(c);
    const sessionUser = c.get("user");
    const pending = await readPending(c.env, scope.keys, c.req.header("cookie"), at);
    const claim =
      sessionUser && !sessionUser.emailVerified
        ? { userId: sessionUser.id, email: sessionUser.email.toLowerCase(), changes: 0, viaCookie: false }
        : pending
          ? { ...pending, viaCookie: true }
          : null;
    if (!claim)
      throw new AppError("forbidden", "Sign up again to change the address.", {
        reason: "no_pending_signup",
      });
    if (claim.changes >= PENDING_MAX_CHANGES) {
      throw new AppError("rate_limited", "The address has been changed too many times. Sign up again.");
    }

    const newEmail = Body.parse(await jsonBody(c))
      .email.trim()
      .toLowerCase();
    // Checks 4 and 5 of the sign-up policy, on the new address alone.
    const problem = await emailProblem(scope, newEmail);
    if (problem) throw new AppError("validation", SIGNUP_REFUSALS[problem], { reason: problem });

    if (newEmail !== claim.email) {
      const account = await getAccount(db(c), claim.userId);
      // The account this sign-up created, still unverified and still at the address the cookie names.
      if (account && !account.emailVerified && account.email === claim.email) {
        if (await replaceUnverifiedEmail(db(c), account.id, newEmail)) {
          const token = await createEmailVerificationToken(
            c.env.BETTER_AUTH_SECRET,
            newEmail,
            undefined,
            VERIFICATION_EXPIRES_IN_S,
          );
          const url = `${c.env.APP_ORIGIN}/api/auth/verify-email?token=${token}&callbackURL=${encodeURIComponent(VERIFIED_CALLBACK)}`;
          defer(c, sendVerification(deps(c), { to: newEmail, name: account.name, url }));
          record(c, "auth.pending_email_changed", { type: "user", id: account.id }, null, {
            actorUserId: account.id,
            actorType: "user",
          });
        }
      }
    }

    if (claim.viaCookie) {
      const value = await mintPending(
        scope.keys,
        { email: newEmail, userId: claim.userId },
        claim.changes + 1,
        at,
      );
      c.header("Set-Cookie", setCookieHeader(c.env, PENDING_COOKIE, value));
    }
    const remaining = PENDING_EMAIL_MIN_MS - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    return c.json({ ok: true });
  }),
);
