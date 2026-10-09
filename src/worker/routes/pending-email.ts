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
// THE NEW ADDRESS PASSES WHAT A SIGN-UP WITH IT WOULD. Everything in the sign-up policy that
// depends on the address is applied to the new one: allowed domains, disposable domains and the
// MX check (checks 4 and 5), and the day's velocity counters (check 6) — a change COUNTS as a
// sign-up on every subject of the new address, the address's domain included, and is refused at
// a limit. The count is taken before any account is looked at and is never given back, so trying
// an address costs the same whatever the answer to "does it exist" is. The invite (check 7) is
// not re-used: the account being moved was created with one, and keeps its `invitedBy`.
//
// The account is changed only while it is unverified (the condition is part of the UPDATE), the
// old verification link stops working (it names the old address, which no account has any
// more), and a new one is sent to the new address. One sign-up may do this five times — counted
// on the server, per sign-up: the cookie's own number must agree with it, so an older copy of the
// cookie (a replay) is refused and cannot start the count again.
//
// THE ORDER (auth/preflight.ts): what costs nothing first — the cookie's signature, the captcha
// header's presence, the body's shape; then RL_AUTH for the caller's address; then the Turnstile
// token, verified once (auth/captcha.ts — this is our route, Better Auth's plugin never sees it);
// and only then anything in the database, the MX lookup, or a mail.
//
// Paths are relative to /api. The pipeline applies CSRF; RL_AUTH is applied here.

import { generateId } from "@better-auth/core/utils/id";
import { createEmailVerificationToken } from "better-auth/api";
import { Hono } from "hono";
import { z } from "zod";
import { captchaToken, verifyCaptcha } from "../auth/captcha";
import { scopeOf, VERIFICATION_EXPIRES_IN_S } from "../auth/create-auth";
import { afterAnswer, type AuthScope } from "../auth/scope";
import {
  mintPending,
  PENDING_COOKIE,
  PENDING_MAX_CHANGES,
  readPending,
  setCookieHeader,
} from "../auth/signed-cookie";
import {
  getAccount,
  pendingChanges,
  replaceUnverifiedEmail,
  takePendingChange,
} from "../db/queries/auth-lifecycle";
import { ipKey } from "../middleware/rate-limit";
import { guard, record } from "../auth/observe";
import { padStatements, STATEMENT_BUDGET } from "../auth/parity";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { sendVerification } from "../services/email";
import { AppError } from "../services/errors";
import { enforceRateLimit } from "../services/ratelimit";
import { auth, db, defer, deps, type AppEnv } from "../services/request-context";
import { emailProblem, SIGNUP_REFUSALS, SignupRefusal, takeAddressChange } from "../services/signup-policy";

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
    scope.answered.held = true;
    try {
      return await answer(scope);
    } finally {
      scope.answered.release();
    }

    async function answer(scope: AuthScope): Promise<Response> {
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
      const token = captchaToken(c.req.raw);
      const newEmail = Body.parse(await jsonBody(c))
        .email.trim()
        .toLowerCase();
      // The caller's own budget, then the challenge — and only then the database.
      await enforceRateLimit(c.env, "RL_AUTH", ipKey(c.get("ip")));
      await verifyCaptcha(c.env, token, c.get("ip"));

      // The count of changes is the SERVER's (db/queries/auth-lifecycle.ts). A cookie that says
      // another number is an older copy being sent again: refused like no cookie at all, before
      // anything is spent or looked up. (It says nothing about any account: it is about the cookie.)
      const expected = claim.viaCookie ? claim.changes : null;
      const made = await pendingChanges(db(c), claim.userId);
      if (expected !== null && expected !== made) {
        throw new AppError("forbidden", "Sign up again to change the address.", {
          reason: "no_pending_signup",
        });
      }
      if (made >= PENDING_MAX_CHANGES) {
        throw new AppError("rate_limited", "The address has been changed too many times. Sign up again.");
      }

      // Checks 4 and 5 of the sign-up policy, on the new address alone.
      const problem = await emailProblem(scope, newEmail);
      if (problem) throw new AppError("validation", SIGNUP_REFUSALS[problem], { reason: problem });

      if (newEmail !== claim.email) {
        // Check 6, taken — before anything is known about any account (see the header).
        const cf = c.req.raw.cf as { asn?: unknown; country?: unknown } | undefined;
        try {
          await takeAddressChange(scope, newEmail, {
            ip: c.get("ip"),
            asn: typeof cf?.asn === "number" ? cf.asn : null,
            country: typeof cf?.country === "string" ? cf.country : null,
            userAgent: c.req.header("user-agent") ?? null,
          });
        } catch (error) {
          if (error instanceof SignupRefusal) {
            throw new AppError("rate_limited", error.message, { reason: error.code });
          }
          throw error;
        }
      }

      // The change is taken now — atomically, and only if the count is still what it was above: the
      // same cookie sent twice at once is honoured once. Taken whether or not an account will move
      // (a look-alike sign-up, a taken address): the answer must not depend on that.
      const taken = await takePendingChange(db(c), {
        id: generateId(),
        userId: claim.userId,
        expected,
        max: PENDING_MAX_CHANGES,
      });
      if (!taken.ok) {
        if (taken.reason === "exhausted") {
          throw new AppError("rate_limited", "The address has been changed too many times. Sign up again.");
        }
        throw new AppError("forbidden", "Sign up again to change the address.", {
          reason: "no_pending_signup",
        });
      }

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
            // Sent once the request has been answered (auth/scope.ts `afterAnswer`).
            defer(
              c,
              afterAnswer(scope, () => sendVerification(deps(c), { to: newEmail, name: account.name, url })),
            );
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
          taken.count,
          at,
        );
        c.header("Set-Cookie", setCookieHeader(c.env, PENDING_COOKIE, value));
      }
      // The same number of round trips whichever of the three things happened (auth/parity.ts) —
      // and, below, the same minimum time.
      await padStatements(db(c), STATEMENT_BUDGET["/account/pending-email"]!);
      const remaining = PENDING_EMAIL_MIN_MS - (Date.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return c.json({ ok: true });
    }
  }),
);
