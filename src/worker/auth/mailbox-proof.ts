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
//   SIGN-UP LINK, opened anywhere else (another browser, another device, another person — or
//   fetched by a mail gateway's link scanner, which GETs every link without cookies before the
//   mail is even delivered):
//       THE GET CHANGES NOTHING. Not a row. It answers with a redirect to a page of ours
//       (`/set-password#token=<the link's own token>` — in the fragment, so a scanner that
//       follows it fetches the bare shell). There the person states their age, accepts the terms
//       and chooses a password, and ONE same-origin POST from that page's button
//       (`POST /api/account/confirm-email`, routes/pending-email.ts → `confirmMailbox` below)
//       does everything at once: in one transaction, under the row lock, while the account is
//       still unverified (and so can hold no session): every credential its creator chose is
//       deleted, the address is marked verified, and the terms / age statement on the row
//       becomes THIS person's (the invite reference is cleared: they brought none) — and then the
//       password they typed is set. No session is created; they sign in.
//       So a scanner's fetch leaves the sign-up browser's own click working, with the password
//       chosen a minute ago; and nobody is handed a password-setting token by a GET.
//   ADDRESS-CHANGE CONFIRMATION (the first step, mailed to the CURRENT address — the owner's
//       consent): inert on a GET, like the sign-up link opened elsewhere. It lands on our
//       `/confirm-email-change` page; the page's button sends one same-origin POST, and that is
//       what mails the new address. (And asking for a change at all needs the owner AGAIN —
//       `beforeChangeEmail`: the password, or a marked or fresh session when there is none.)
//   ADDRESS-CHANGE LINK (the second step, mailed to the NEW address): Better Auth would create
//       a session for the account when the clicker has none — so the owner of the new address,
//       clicking a mail they did not ask for, would be signed in to a stranger's account that
//       now carries their address. Here it needs that account's own session; otherwise nothing
//       changes and the browser is sent to sign in.
//
// Why the GET's decision is made "before": afterwards is too late. Once the row is verified its creator can sign in, and
// anything deleted after that races a request already in flight (a passkey registration). While
// it is unverified nothing but its sign-up password can exist (Better Auth gives an unverified
// account no session), so "delete and mark verified" under the lock is complete.
//
// The token is verified HERE first (the same HS256 check Better Auth makes): nothing is deleted
// on the strength of a link that is forged or expired — and every state in which the POST cannot
// act (forged, expired, an address-change token, no such account, already verified, moved) is
// answered with the one generic "this link is no longer valid".

import { generateId } from "@better-auth/core/utils/id";
import { APIError, createEmailVerificationToken, getSessionFromCtx } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import {
  clearForMailboxProof,
  getAccountByEmail,
  putAuthMarker,
  takeAuthMarker,
} from "../db/queries/auth-lifecycle";
import { activatePendingShares } from "../db/queries/shares";
import { now } from "../services/clock";
import { recordAfterAnswer } from "./observe";
import type { AuthScope } from "./scope";
import { readPending } from "./signed-cookie";
import { HANG, watched } from "./watchdog";

/**
 * `hooks.after` for `POST /change-email`. Better Auth answers `{ status: true }` either way, but
 * mails the caller's CURRENT address only when the new address is free
 * (api/routes/update-user.mjs) — so the caller's own inbox said which addresses have an
 * account. When the address is taken, the same mail is sent here, with a link of the same kind;
 * following it does nothing (`beforeVerifyEmail`, step one).
 */
export async function afterChangeEmail(
  scope: AuthScope,
  ctx: {
    body?: unknown;
    context: {
      returned?: unknown;
      baseURL: string;
      session?: { user: { id: string; email: string; name: string; emailVerified: boolean } } | null;
    };
  },
  send: (mail: {
    to: string;
    name: string;
    newEmail: string;
    url: string;
    by: { user: string };
  }) => Promise<unknown>,
): Promise<void> {
  if (ctx.context.returned instanceof Error) return;
  const user = ctx.context.session?.user;
  const body = (ctx.body ?? {}) as { newEmail?: unknown; callbackURL?: unknown };
  // Only a verified address gets the confirmation step from Better Auth at all.
  if (!user || !user.emailVerified || typeof body.newEmail !== "string") return;
  const newEmail = body.newEmail.toLowerCase();
  if (newEmail === user.email.toLowerCase()) return;
  // What the confirmation will take (`confirmAddressChange`): this account, that address, for
  // as long as the link lives. Written whether the address is free or taken.
  await putAuthMarker(scope.db, {
    id: generateId(),
    identifier: changeMarker(user.id, newEmail),
    userId: user.id,
    expiresAt: new Date(Date.now() + VERIFY_LINK_EXPIRES_IN_S * 1000),
  });
  const holder = await getAccountByEmail(scope.db, newEmail);
  if (!holder || holder.id === user.id) return;
  const token = await createEmailVerificationToken(
    scope.env.BETTER_AUTH_SECRET,
    user.email,
    newEmail,
    VERIFY_LINK_EXPIRES_IN_S,
    { requestType: "change-email-confirmation" },
  );
  const callback = typeof body.callbackURL === "string" ? body.callbackURL : "/";
  const url = `${ctx.context.baseURL}/verify-email?token=${token}&callbackURL=${encodeURIComponent(callback)}`;
  await send({ to: user.email, name: user.name, newEmail, url, by: { user: user.id } });
}

/** The page of ours a link opened elsewhere lands on (src/client/routes/auth/Password.tsx). */
export const SET_PASSWORD_PATH = "/set-password";
/** The lifetime of a verification link (create-auth.ts `emailVerification.expiresIn`). */
export const VERIFY_LINK_EXPIRES_IN_S = 60 * 60;
const changeMarker = (userId: string, newEmail: string) => `email-change:${userId}:${newEmail}`;

/** The page of ours the address-change CONFIRMATION link lands on. */
export const CONFIRM_CHANGE_PATH = "/confirm-email-change";
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
    // Step one (mailed to the CURRENT address) is the owner's CONSENT to the change — and a GET
    // is not consent: a mail gateway's scanner fetches every link before a person sees it, so
    // with a stolen session the scanner's fetch would send the second mail and the thief (who
    // has the session the second link needs) would own the address. The GET changes nothing and
    // sends nothing: it lands on a page of ours, whose button sends ONE same-origin POST
    // (`POST /api/account/confirm-email-change` → `confirmAddressChange` below).
    if (claims.requestType === "change-email-confirmation") {
      throw redirect(env, `${CONFIRM_CHANGE_PATH}#token=${token}`);
    }
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

  // Anybody else — the owner on another device, another person, a mail scanner. A GET is not
  // where anything is deleted: the page behind this redirect asks, and its POST acts.
  throw redirect(env, `${SET_PASSWORD_PATH}#token=${token}`);
}

export type MailboxStatement = { termsAcceptedAt: Date; termsVersion: string; ageVerifiedAt: Date };

/**
 * The destructive step, for `POST /api/account/confirm-email`: the holder of a sign-up
 * verification link proves the mailbox, and the account becomes theirs — emptied of what its
 * creator chose, verified, carrying THEIR statement. Returns the account's id, or null when the
 * link cannot do that (any reason: the caller answers with the one generic sentence).
 */
export async function confirmMailbox(
  scope: AuthScope,
  claims: VerifyClaims,
  statement: MailboxStatement,
): Promise<string | null> {
  if (claims.updateTo !== null) return null;
  const account = await getAccountByEmail(scope.db, claims.email);
  if (!account || account.emailVerified) return null;
  const removed = await clearForMailboxProof(scope.db, account.id, account.email, statement);
  // It stopped being "unverified at this address" a moment ago (another confirmation, or the
  // address was moved).
  if (removed === null) return null;
  // Written after the answer, like every row of a padded request (auth/observe.ts).
  recordAfterAnswer(
    scope,
    scope.deps,
    "auth.prehijack_cleanup",
    { type: "user", id: account.id },
    { ...removed, phase: "mailbox" },
    { actorUserId: account.id, actorType: "user" },
  );
  try {
    await activatePendingShares(scope.db, account.id, account.email);
  } catch {
    // The address is proven and emptied; a share that did not activate now does on first use.
  }
  return account.id;
}

/** The part of a Better Auth instance `setFirstPassword` uses. */
type PasswordSetter = {
  $context: Promise<{
    internalAdapter: {
      createVerificationValue(data: { value: string; identifier: string; expiresAt: Date }): Promise<unknown>;
    };
  }>;
  api: { resetPassword(input: { body: { newPassword: string; token: string } }): Promise<unknown> };
};

/**
 * Sets the password of the account `confirmMailbox` has just emptied, through Better Auth's own
 * reset step (the hash, the credential row, `onPasswordReset`) — with a reset token minted and
 * used here, in one call: it is never in a response, a redirect or a mail. Under the watchdog
 * like every call into Better Auth (auth/watchdog.ts): false when it did not answer in time.
 */
export async function setFirstPassword(
  instance: PasswordSetter,
  userId: string,
  password: string,
): Promise<boolean> {
  const token = generateId(24);
  const context = await instance.$context;
  await context.internalAdapter.createVerificationValue({
    value: userId,
    identifier: `reset-password:${token}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const body = { newPassword: password, token };
  const outcome = await watched(instance.api.resetPassword({ body }));
  return outcome !== HANG;
}

/**
 * `POST /api/account/confirm-email-change`: the owner's consent, given by a button. Sends the
 * second mail — the link that changes the address, to the NEW address — exactly as Better Auth's
 * own step would have (email-verification.mjs, `change-email-confirmation`), and nothing when the
 * new address has been taken meanwhile (the answer is the same: the address's owner is not
 * mailed on a stranger's say-so). False: the token cannot do this (the caller answers with the
 * one generic sentence).
 */
export async function confirmAddressChange(
  scope: AuthScope,
  token: string,
  send: (mail: { to: string; url: string; by: { user: string } }) => Promise<unknown>,
): Promise<boolean> {
  const claims = await readVerifyToken(scope.env.BETTER_AUTH_SECRET, token);
  if (!claims || claims.updateTo === null || claims.requestType !== "change-email-confirmation") return false;
  const account = await getAccountByEmail(scope.db, claims.email);
  // The account moved or is gone since the mail was sent.
  if (!account || !account.emailVerified) return false;
  // ONCE, and for the account that ASKED: the request left a marker naming the account and the
  // new address (`afterChangeEmail`), and the confirmation takes it — one statement. A second
  // POST finds none; so does a token whose current address has since passed to another account
  // (the token names two addresses, the marker names the account).
  if (!(await takeAuthMarker(scope.db, changeMarker(account.id, claims.updateTo), account.id))) return false;
  if (await getAccountByEmail(scope.db, claims.updateTo)) return true;
  const next = await createEmailVerificationToken(
    scope.env.BETTER_AUTH_SECRET,
    claims.email,
    claims.updateTo,
    VERIFY_LINK_EXPIRES_IN_S,
    { requestType: "change-email-verification" },
  );
  const url = `${scope.env.APP_ORIGIN}/api/auth/verify-email?token=${next}&callbackURL=${encodeURIComponent("/account")}`;
  await send({ to: claims.updateTo, url, by: { user: account.id } });
  return true;
}

type ChangeContext = Parameters<typeof getSessionFromCtx>[0] & {
  body?: unknown;
  context: {
    sessionConfig: { freshAge: number };
    password: { verify(data: { hash: string; password: string }): Promise<boolean> };
    internalAdapter: {
      findCredentialAccount(userId: string): Promise<{ password?: string | null } | null | undefined>;
    };
  };
};

/** The endpoints whose body may carry `password` for `ownerAgain` (routes/auth.ts hands it over). */
export const REAUTH_PATHS: ReadonlySet<string> = new Set([
  "/change-email",
  "/unlink-account",
  // ADDING a sign-in method is the sibling of removing one: a session alone may not start a
  // link (Better Auth: `sessionMiddleware` only — api/routes/account.mjs `linkSocialAccount`).
  "/link-social",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);

type Throttle = { admit(email: string): Promise<void>; settle(): Promise<void> };

/**
 * THE OWNER AGAIN — a session alone is not enough for what follows. Used by `POST /change-email`
 * (Better Auth asks for nothing more than a session there — api/routes/update-user.mjs
 * `changeEmail`), by `POST /unlink-account` and by the management of a passkey that counts as a
 * second factor (auth/second-factor.ts):
 *   - the account has a password → the request carries it (`password`), and it is checked
 *     through the per-account throttle like every other password a session offers (`admit` /
 *     `settle` are auth/signin-throttle.ts's — counted before the hash). `markSuffices`: where
 *     the thing protected IS second-factor standing, a session that carries the mark has
 *     already shown more than the password, and passes without it;
 *   - it has none (made with Google, a passkey) → the session carries the second-factor mark,
 *     or is FRESH by Better Auth's own rule (`session.freshAge`, api/routes/session.mjs
 *     `freshSessionMiddleware`: created less than that long ago — a new sign-in).
 *     `freshAge` is not configured here, so it is Better Auth's default: 86 400 s — ONE DAY
 *     (dist/context/create-context.mjs:149).
 *     RESIDUAL, ACCEPTED (orchestrator, 2026-10-11): for such an account a stolen session
 *     under a day old passes this gate; the consent step (the button on the mailed link's
 *     page) is what protects its address.
 * Returns silently with no session (Better Auth answers 401). `password`: what the route read
 * from the request body.
 */
export async function ownerAgain(
  ctx: ChangeContext,
  password: unknown,
  throttle: Throttle,
  hasMark: (session: unknown) => boolean,
  markSuffices = false,
): Promise<void> {
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  if (!session) return;
  if (markSuffices && hasMark(session.session)) return;
  const credential = await ctx.context.internalAdapter.findCredentialAccount(session.user.id);
  if (credential?.password) {
    const wrong = new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "Invalid password" });
    if (typeof password !== "string" || password === "" || password.length > 128) throw wrong;
    await throttle.admit(session.user.email);
    const right = await ctx.context.password.verify({ hash: credential.password, password });
    await throttle.settle();
    if (!right) throw wrong;
    return;
  }
  if (hasMark(session.session)) return;
  const fresh = ctx.context.sessionConfig.freshAge * 1000;
  const age = Date.now() - new Date(session.session.createdAt).getTime();
  if (fresh === 0 || age < fresh) return;
  throw new APIError("FORBIDDEN", {
    code: "SESSION_NOT_FRESH",
    message: "Sign in again to continue.",
  });
}

/** `hooks.before` for `POST /change-email`: the owner again (see `ownerAgain`). */
export const beforeChangeEmail = (
  ctx: ChangeContext,
  password: unknown,
  throttle: Throttle,
  hasMark: (session: unknown) => boolean,
): Promise<void> => ownerAgain(ctx, password, throttle, hasMark);

export const UNLINK_NOT_AVAILABLE = {
  code: "UNLINK_NOT_AVAILABLE",
  message: "A password cannot be removed from an account.",
} as const;

/**
 * `hooks.before` for `POST /unlink-account` (Better Auth: a fresh session, nothing else —
 * api/routes/account.mjs `unlinkAccount`). Removing the PASSWORD row is refused outright: it is
 * not a product feature, and with the row gone `ownerAgain` would stop asking for a password.
 * Removing a provider link needs the owner again, like a change of address. (The account's last
 * sign-in method can never go: Better Auth refuses `FAILED_TO_UNLINK_LAST_ACCOUNT`, and the
 * password row — which every account that reaches the second branch with a password has —
 * stays.)
 */
export async function beforeUnlinkAccount(
  ctx: ChangeContext,
  linked: (
    accountRowId: string,
    userId: string,
  ) => Promise<{ providerId: string; hasPassword: boolean } | null>,
  password: unknown,
  throttle: Throttle,
  hasMark: (session: unknown) => boolean,
): Promise<void> {
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  if (!session) return;
  const id = (ctx.body as { accountId?: unknown } | null | undefined)?.accountId;
  const row = typeof id === "string" ? await linked(id, session.user.id) : null;
  // The password row — by its provider id, or by simply HOLDING a password — never goes.
  if (row !== null && (row.providerId === "credential" || row.hasPassword)) {
    throw new APIError("FORBIDDEN", { ...UNLINK_NOT_AVAILABLE });
  }
  // EVERY other unlink needs the owner again — whatever the body names (a row of this account,
  // of another account, of nobody, a provider's name): the gate does not depend on what the
  // look-up found. Only then does Better Auth judge the request (ACCOUNT_NOT_FOUND, the last
  // method).
  await ownerAgain(ctx, password, throttle, hasMark);
}
