// What a click on a mailed verification link may do — decided BEFORE Better Auth acts on it.
//
// Better Auth's verification token is a stateless JWT over the ADDRESS alone
// (better-auth/dist/api/routes/email-verification.mjs): `GET /verify-email` marks whatever
// account has that address as verified and, with auto sign-in, creates a session for whoever
// opened the link. Nothing ties the click to the browser that chose the account's password. So:
//
//   stranger signs up `victim@x` with the stranger's own password → the mail goes to the victim
//   → the victim clicks → the account is verified and still opens with the stranger's password.
//
// A click proves that the clicker reads the MAILBOX. It says nothing about who created the
// account. The rule here:
//
//   SIGN-UP LINK, opened in the browser that signed up — it holds the `hf_pending` proof
//   (auth/signed-cookie.ts) naming that very account at that very address:
//       Better Auth proceeds. The password stays, the browser is signed in.
//   SIGN-UP LINK, opened anywhere else (another browser, another device, another person):
//       the address is PROVEN, by someone we cannot tie to the password. In one transaction,
//       under the row lock, while the account is still unverified (and so can hold no session):
//       every credential is deleted and the address is marked verified. NO session is created.
//       The person is redirected to "set your password" with a single-use token of Better
//       Auth's own reset kind — delivered in this very response, to the one who has the mailbox.
//   ADDRESS-CHANGE LINK (the second step, mailed to the NEW address): Better Auth would create
//       a session for the account when the clicker has none — so the owner of the new address,
//       clicking a mail they did not ask for, would be signed in to a stranger's account that
//       now carries their address. Here it needs that account's own session; otherwise nothing
//       changes and the browser is sent to sign in.
//
// Why "before": afterwards is too late. Once the row is verified its creator can sign in, and
// anything deleted after that races a request already in flight (a passkey registration). While
// it is unverified nothing but its sign-up password can exist (Better Auth gives an unverified
// account no session), so "delete and mark verified" under the lock is complete.
//
// The token is verified HERE first (the same HS256 check Better Auth makes): nothing is deleted
// on the strength of a link that is forged or expired.

import { generateId } from "@better-auth/core/utils/id";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { clearForMailboxProof, getAccountByEmail } from "../db/queries/auth-lifecycle";
import { activatePendingShares } from "../db/queries/shares";
import { now } from "../services/clock";
import { record } from "./observe";
import type { AuthScope } from "./scope";
import { readPending } from "./signed-cookie";

/** The screen that takes the token (src/client/routes/auth/Password.tsx). */
export const SET_PASSWORD_PATH = "/set-password";
/** How long the set-password token of a cross-browser verification lasts. */
export const SET_PASSWORD_TOKEN_S = 60 * 60;
/** Where an address-change link sends a browser that is not signed in to the account. */
export const CHANGE_EMAIL_SIGN_IN = "/login?reason=change_email";
/** Where it sends the account's own browser when the new address has been taken meanwhile. */
export const CHANGE_EMAIL_UNAVAILABLE = "/account?email=unavailable";

export type VerifyClaims = { email: string; updateTo: string | null; requestType: string | null };

/** The claims of a verification token this Worker signed and that has not expired; otherwise null. */
export async function readVerifyToken(secret: string, token: string): Promise<VerifyClaims | null> {
  const payload = (await verifyJWT(token, secret)) as Record<string, unknown> | null;
  if (!payload || typeof payload.email !== "string" || payload.email === "") return null;
  if (payload.updateTo !== undefined && typeof payload.updateTo !== "string") return null;
  if (payload.requestType !== undefined && typeof payload.requestType !== "string") return null;
  return {
    email: payload.email.toLowerCase(),
    updateTo: typeof payload.updateTo === "string" ? payload.updateTo.toLowerCase() : null,
    requestType: typeof payload.requestType === "string" ? payload.requestType : null,
  };
}

type VerifyContext = Parameters<typeof getSessionFromCtx>[0] & {
  request?: Request;
  headers?: Headers;
  context: {
    internalAdapter: {
      createVerificationValue(data: { value: string; identifier: string; expiresAt: Date }): Promise<unknown>;
    };
  };
};

const redirect = (env: Pick<Env, "APP_ORIGIN">, path: string) =>
  new APIError("FOUND", undefined, { Location: `${env.APP_ORIGIN}${path}` });

/**
 * `hooks.before` for `GET /verify-email`. Returns to let Better Auth handle the link; throws the
 * redirect that answers it otherwise.
 */
export async function beforeVerifyEmail(scope: AuthScope, ctx: VerifyContext): Promise<void> {
  const { env, db } = scope;
  if (!ctx.request) return;
  const token = new URL(ctx.request.url).searchParams.get("token");
  if (!token) return;
  const claims = await readVerifyToken(env.BETTER_AUTH_SECRET, token);
  // Forged, expired, malformed: Better Auth's own answer, and nothing is touched.
  if (!claims) return;

  if (claims.updateTo !== null) {
    // Step one (mailed to the CURRENT address) only sends the second mail.
    if (claims.requestType === "change-email-confirmation") return;
    const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
    if (!session || session.user.email.toLowerCase() !== claims.email) {
      throw redirect(env, CHANGE_EMAIL_SIGN_IN);
    }
    // Taken since the change was asked for: Better Auth would run into the unique index (a 500
    // on a link the person clicked).
    if (await getAccountByEmail(db, claims.updateTo)) throw redirect(env, CHANGE_EMAIL_UNAVAILABLE);
    return;
  }

  const account = await getAccountByEmail(db, claims.email);
  // Nobody, or already proven: Better Auth answers (a proven account gets no session from a link).
  if (!account || account.emailVerified) return;

  const cookies = ctx.headers?.get("cookie") ?? ctx.request.headers.get("cookie");
  const pending = await readPending(env, scope.keys, cookies, now());
  if (pending && pending.userId === account.id && pending.email === account.email.toLowerCase()) {
    // The browser that signed up: its password, its session.
    return;
  }

  const removed = await clearForMailboxProof(db, account.id, account.email);
  // It stopped being "unverified at this address" a moment ago (another click, or the address
  // was moved): Better Auth answers for the state as it is now — verified → no session; moved →
  // no such user.
  if (removed === null) return;
  record(
    scope.deps,
    "auth.prehijack_cleanup",
    { type: "user", id: account.id },
    { ...removed, phase: "mailbox" },
    { actorUserId: account.id, actorType: "user" },
  );
  try {
    await activatePendingShares(db, account.id, account.email);
  } catch {
    // The address is proven and emptied; a share that did not activate now does on first use.
  }
  const setToken = generateId(24);
  await ctx.context.internalAdapter.createVerificationValue({
    value: account.id,
    identifier: `reset-password:${setToken}`,
    expiresAt: new Date(Date.now() + SET_PASSWORD_TOKEN_S * 1000),
  });
  // In the FRAGMENT: it is never sent to a server, so it is in no request log and no Referer.
  throw redirect(env, `${SET_PASSWORD_PATH}#token=${setToken}`);
}
