// The two things an account that is not verified yet can have done to it without a session.
//
// ── PATCH /api/account/pending-email { email } — fix a mistyped address BEFORE it is verified ──
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
// sign-up on every subject a sign-up with the new address would count on (with invites required:
// the caller's own address; in open mode also the network, the ASN and the address's domain —
// services/signup-policy.ts `velocitySubjects`), and is refused at a limit. The count is taken before any account is looked at and is never given back, so trying
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
// ── POST /api/account/confirm-email { token, newPassword, acceptTerms, birthYear, birthMonth } ──
//
// The step a verification link takes when it is opened anywhere but the sign-up browser
// (auth/mailbox-proof.ts). The GET of the link changes nothing and lands on our set-password
// page; that page's button sends THIS request — same-origin (the pipeline's CSRF step), with
// the link's own token. It proves the mailbox, and in one go: the account is emptied of what its
// creator chose and marked verified, the terms / age statement on it becomes this person's
// (the same rules as at sign-up: `parseStatement` — a JSON `true`, integers, thirteen or older),
// and the password they typed is set (Better Auth's own reset step, with a token minted and
// used inside this request — none is ever handed to a browser). No session: they sign in.
// THE ORDER is the same as above: body shape, statement, password length and the token's
// signature cost nothing; then RL_AUTH; then Turnstile; then the breach look-up; then the
// database. Every state in which the link cannot do this is one answer: `invalid_token`,
// "This link is no longer valid." One more answer exists: `409 conflict`, reason
// `password_not_set` — the proof committed and the password step failed; the page offers the
// reset link.
//
// Paths are relative to /api. The pipeline applies CSRF; RL_AUTH is applied here.

import { generateId } from "@better-auth/core/utils/id";
import { createEmailVerificationToken } from "better-auth/api";
import { Hono } from "hono";
import { z } from "zod";
import { isBreached, BREACH_CHECK_UNAVAILABLE, PASSWORD_COMPROMISED_MESSAGE } from "../auth/breach-check";
import { captchaToken, verifyCaptcha } from "../auth/captcha";
import { confirmAddressChange, confirmMailbox, readVerifyToken } from "../auth/mailbox-proof";
import { isStoredFormAddress, PASSWORD_MAX, PASSWORD_MIN } from "../auth/preflight";
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
import { countFor, guard, recordAfterAnswer, reportError } from "../auth/observe";
import { LINK_ERROR_BUDGET, padStatements, STATEMENT_BUDGET } from "../auth/parity";
import { jsonBody } from "../services/body";
import { now } from "../services/clock";
import { chargeUnsent, sendNewAddressVerification, sendVerification } from "../services/email";
import { AppError } from "../services/errors";
import { enforceRateLimit } from "../services/ratelimit";
import { auth, db, defer, deps, type AppEnv } from "../services/request-context";
import {
  emailProblem,
  parseStatement,
  SIGNUP_REFUSALS,
  SignupRefusal,
  takeAddressChange,
} from "../services/signup-policy";

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
      // Only an address already in the form it is stored in (auth/preflight.ts): nothing typed is
      // trimmed or folded into another address here.
      const submitted = Body.parse(await jsonBody(c)).email;
      if (!isStoredFormAddress(submitted)) {
        throw new AppError("validation", "Enter the address in lower case, without spaces.", {
          fields: ["email"],
        });
      }
      const newEmail = submitted;
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

      let mailed = false;
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
            mailed = true;
            defer(
              c,
              afterAnswer(scope, () =>
                // Counted as mail ANYBODY can cause (not the address's own budget): this browser
                // has proven its sign-up, not that the NEW address is its own.
                sendVerification(deps(c), { to: newEmail, url, by: { client: c.get("ip") } }),
              ),
            );
            // The row too: started now, its INSERT would race the padding below (auth/observe.ts).
            recordAfterAnswer(scope, c, "auth.pending_email_changed", { type: "user", id: account.id }, null, {
              actorUserId: account.id,
              actorType: "user",
            });
          }
        }
      }

      // A change that mailed nobody (a look-alike sign-up, a taken address) charges the mail
      // budgets exactly as the one that did (services/email.ts `chargeUnsent`) — after the answer.
      if (newEmail !== claim.email && !mailed) {
        defer(
          c,
          afterAnswer(scope, () => chargeUnsent(deps(c), "verification", newEmail, { client: c.get("ip") })),
        );
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

const ConfirmBody = z.object({
  token: z.string().min(1).max(2048),
  newPassword: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  acceptTerms: z.unknown(),
  birthYear: z.unknown(),
  birthMonth: z.unknown(),
});

/** `details.reason` when the mailbox proof committed and the password step did not. */
export const PASSWORD_NOT_SET = "password_not_set";

const linkInvalid = () => new AppError("invalid_token", "This link is no longer valid.");

router.post(
  "/account/confirm-email",
  guard("confirm_email", async (c) => {
    const instance = auth(c);
    const scope = scopeOf(instance);
    if (!scope) throw new Error("no auth scope");
    scope.answered.held = true;
    try {
      return await answer(scope);
    } finally {
      scope.answered.release();
    }

    async function answer(scope: AuthScope): Promise<Response> {
      // What costs nothing: the captcha header, the body, the statement, the token's signature.
      const captcha = captchaToken(c.req.raw);
      const body = ConfirmBody.parse(await jsonBody(c));
      try {
        parseStatement(body, now(c));
      } catch (error) {
        if (error instanceof SignupRefusal) {
          throw new AppError("validation", error.message, { reason: error.code });
        }
        throw error;
      }
      const claims = await readVerifyToken(c.env.BETTER_AUTH_SECRET, body.token);
      if (!claims || claims.updateTo !== null) throw linkInvalid();
      // The caller's own budget, then the challenge — and only then anything else.
      await enforceRateLimit(c.env, "RL_AUTH", ipKey(c.get("ip")));
      await verifyCaptcha(c.env, captcha, c.get("ip"));
      // The password is judged before anything is deleted for it (auth/breach-check.ts: fail closed).
      let breached: boolean;
      try {
        breached = await isBreached(body.newPassword);
      } catch {
        countFor(c.env, "auth", { outcome: "error", kind: "breach_check" });
        throw new AppError("feature_disabled", BREACH_CHECK_UNAVAILABLE.message, {
          reason: BREACH_CHECK_UNAVAILABLE.code,
        });
      }
      if (breached) {
        throw new AppError("validation", PASSWORD_COMPROMISED_MESSAGE, { reason: "PASSWORD_COMPROMISED" });
      }

      const at = now(c);
      const settings = await scope.settings();
      const userId = await confirmMailbox(scope, claims, {
        termsAcceptedAt: at,
        termsVersion: settings.termsVersion,
        ageVerifiedAt: at,
      });
      if (userId === null) {
        await padStatements(db(c), LINK_ERROR_BUDGET);
        throw linkInvalid();
      }
      // The password: Better Auth's own reset step (hash, credential row, `onPasswordReset`),
      // with a token that exists only inside the Worker (auth/create-auth.ts).
      // TWO steps, not one: the proof above has committed. If this one fails the link is spent
      // and the account has no credential — so the answer says what to do next, and the page
      // turns it into "request a reset link" (which works: the address is verified).
      let set = false;
      try {
        if (!instance.setFirstPassword) throw new Error("no auth instance");
        set = await instance.setFirstPassword(userId, body.newPassword);
        if (!set) countFor(c.env, "auth", { outcome: "hang", kind: "handler" });
      } catch (error) {
        reportError(error, { kind: "confirm_email_password" });
      }
      if (!set) {
        countFor(c.env, "auth", { outcome: "error", kind: "confirm_email_password" });
        throw new AppError(
          "conflict",
          "Your email address is confirmed, but the password could not be saved. Request a reset link to choose one.",
          { reason: PASSWORD_NOT_SET },
        );
      }
      recordAfterAnswer(
        scope,
        c,
        "auth.password_changed",
        { type: "user", id: userId },
        { via: "mailbox_proof" },
        { actorUserId: userId, actorType: "user" },
      );
      await padStatements(db(c), STATEMENT_BUDGET["/account/confirm-email"]!);
      return c.json({ ok: true });
    }
  }),
);

// ── POST /api/account/confirm-email-change { token } ─────────────────────────────────────────
// The button on the page the address-change CONFIRMATION link lands on (auth/mailbox-proof.ts):
// the owner's consent to the change. Same-origin (the pipeline's CSRF step); no session is
// asked for — the link was mailed to the current address, and its owner may open it anywhere.
// The order as above: body and captcha header free, RL_AUTH, Turnstile, then the database.
const ChangeBody = z.object({ token: z.string().min(1).max(2048) });

router.post(
  "/account/confirm-email-change",
  guard("confirm_email_change", async (c) => {
    const scope = scopeOf(auth(c));
    if (!scope) throw new Error("no auth scope");
    scope.answered.held = true;
    try {
      const captcha = captchaToken(c.req.raw);
      const body = ChangeBody.parse(await jsonBody(c));
      // A token nobody signed is refused before anything is spent on it.
      const claims = await readVerifyToken(c.env.BETTER_AUTH_SECRET, body.token);
      if (!claims || claims.requestType !== "change-email-confirmation") throw linkInvalid();
      await enforceRateLimit(c.env, "RL_AUTH", ipKey(c.get("ip")));
      await verifyCaptcha(c.env, captcha, c.get("ip"));
      const done = await confirmAddressChange(scope, body.token, async (mail) => {
        defer(
          c,
          afterAnswer(scope, () => sendNewAddressVerification(deps(c), mail)),
        );
      });
      await padStatements(db(c), LINK_ERROR_BUDGET);
      if (!done) throw linkInvalid();
      return c.json({ ok: true });
    } finally {
      scope.answered.release();
    }
  }),
);
