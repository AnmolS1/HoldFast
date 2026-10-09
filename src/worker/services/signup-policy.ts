// The sign-up and sign-in policy: the single owner of who may create an account and who may
// start a session. Better Auth calls it through its database hooks (auth/hooks.ts); the intent
// route and the pending-address route call the same checks. Later tasks supply data (settings,
// invites) and call the exported helpers — they do not re-implement a gate.
//
// A NEW ACCOUNT passes these, in order — each refusal is a plain sentence and a stable code:
//   1. kill switch        `settings.readOnly` → no sign-ups
//   2. assent             `acceptTerms === true`; the accepted version is the CURRENT one
//   3. age                birth month and year, 13 or older — and the date is then thrown away:
//                         only `ageVerifiedAt` is stored, nowhere a year, a month or an age
//   4. allowed domains    when `SIGNUP_ALLOWED_DOMAINS` is set, only those (and 5 is skipped)
//   5. disposable email   the vendored list, then an MX lookup (a failed lookup does not block)
//   6. velocity           per address, per network, per ASN, per email domain — a day's counters
//   7. invite             when sign-up is invite-only; `ADMIN_EMAILS` are exempt (bootstrap)
// 6 and 7 are TAKEN, not just checked: one transaction counts the sign-up on every velocity
// subject and uses the invite, or does neither (db/queries/auth-lifecycle.ts `reserveSignup`).
// That is what makes them hold under concurrency — a check here and an increment after the
// account exists would let any number of simultaneous sign-ups through on the same stale count.
// A sign-up that then fails to create its account gives the reservation back (`releaseSignup`).
// The velocity subjects are `signup_*` rows of the ledger, so file traffic from the same address
// can never block a sign-up.
//
// A SESSION is refused for a suspended account (403, said plainly), and for an account whose
// deletion date has passed or whose purge has begun — with Better Auth's ordinary
// wrong-credentials answer, so such an account is indistinguishable from one that is gone,
// whether or not the purge has run (a held account must not reveal itself). A deletion date in
// the FUTURE refuses nothing and cancels nothing: the owner signs in, sees the banner, and
// cancels explicitly. A banned account is refused by the admin plugin's own session hook.

import { hasAdminRole } from "../../shared/roles";
import { isDisposableDomain } from "../auth/data/disposable-domains";
import { PUBLIC_MAIL_PROVIDERS } from "../auth/data/public-mail-providers";
import type { AuthScope, ClientFacts } from "../auth/scope";
import {
  getAccount,
  grantAdminRole,
  inviteUsable,
  purgeStartedAt,
  reserveSignup,
  type VelocitySubject,
} from "../db/queries/auth-lifecycle";
import { utcDay } from "../db/queries/ledger";
import { audit } from "./audit";
import { now } from "./clock";
import { ipHashDaily, ipPrefix } from "./ip-hash";

// ── refusals ────────────────────────────────────────────────────────────────────────────────

export const SIGNUP_REFUSALS = {
  SIGNUP_PAUSED: "Sign-up is paused right now. Try again later.",
  TERMS_NOT_ACCEPTED: "You need to accept the Terms and Privacy Policy.",
  // Neutral on purpose: it does not say which answer would have been accepted.
  SIGNUP_NOT_AVAILABLE: "We can't create an account with these details.",
  EMAIL_NOT_ALLOWED: "This email address can't be used to sign up.",
  SIGNUP_LIMIT: "Too many sign-ups from this network today. Try again tomorrow.",
  INVITE_INVALID: "This invite code isn't valid.",
  SIGNUP_INTENT_REQUIRED: "Start sign-up from the Holdfast sign-up page.",
  PROVIDER_EMAIL_UNVERIFIED: "Verify your email address with Google first, then try again.",
} as const;

export type SignupRefusalCode = keyof typeof SIGNUP_REFUSALS;

/** Thrown by every check below. Callers turn it into their own error type (never a 403 — see auth/hooks.ts). */
export class SignupRefusal extends Error {
  readonly code: SignupRefusalCode;
  constructor(code: SignupRefusalCode) {
    super(SIGNUP_REFUSALS[code]);
    this.name = "SignupRefusal";
    this.code = code;
  }
}

/** Thrown by `beforeSessionCreate`. `invalid_credentials` must be answered as a wrong password. */
export class SessionRefusal extends Error {
  constructor(readonly kind: "suspended" | "invalid_credentials") {
    super(kind);
    this.name = "SessionRefusal";
  }
}

export const ACCOUNT_SUSPENDED_MESSAGE = "This account is suspended. Contact support.";

// ── inputs ──────────────────────────────────────────────────────────────────────────────────

/** What a person states at sign-up. None of it is stored as given. */
export type SignupStatement = {
  inviteCode: string | null;
  birthYear: number;
  birthMonth: number;
  acceptTerms: true;
};

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/**
 * The statement out of a request body. Strict: the values must be a JSON `true` and JSON
 * integers — a string "true" or "1990" is not an assent and not a year.
 */
export function parseStatement(raw: unknown, at: Date = now()): SignupStatement {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (body.acceptTerms !== true) throw new SignupRefusal("TERMS_NOT_ACCEPTED");
  const { birthYear, birthMonth } = body;
  if (!isInt(birthYear) || !isInt(birthMonth)) throw new SignupRefusal("SIGNUP_NOT_AVAILABLE");
  if (!isThirteenOrOlder(birthYear, birthMonth, at)) throw new SignupRefusal("SIGNUP_NOT_AVAILABLE");
  const code = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  return { inviteCode: code && code.length <= 128 ? code : null, birthYear, birthMonth, acceptTerms: true };
}

/**
 * Certainly thirteen, from a birth month and year (the day is never asked). Counted in whole
 * months and strictly: someone whose thirteenth birthday falls in the current month may not have
 * had it yet, so that month does not count. A date in the future, or before 1900, is not an age.
 */
export function isThirteenOrOlder(birthYear: number, birthMonth: number, at: Date = now()): boolean {
  if (!isInt(birthYear) || !isInt(birthMonth) || birthMonth < 1 || birthMonth > 12) return false;
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  if (birthYear < 1900 || birthYear > year) return false;
  const monthsOld = (year - birthYear) * 12 + (month - birthMonth);
  return monthsOld > 13 * 12;
}

// ── addresses ───────────────────────────────────────────────────────────────────────────────

/** The domain of an address, lower-cased, without a trailing dot. Null when there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain) ? domain : null;
}

function listOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Is the address one of `ADMIN_EMAILS`? (Exempt from the invite; `admin` once verified.) */
export function isAdminEmail(env: Pick<Env, "ADMIN_EMAILS">, email: string): boolean {
  return listOf(env.ADMIN_EMAILS).includes(email.trim().toLowerCase());
}

export const MX_LOOKUP_TIMEOUT_MS = 2_000;
const DOH = "https://cloudflare-dns.com/dns-query";
const DNS_TYPE_MX = 15;
const DNS_NXDOMAIN = 3;

/**
 * Can the domain receive mail at all? False ONLY on a definite answer: the domain does not
 * exist (NXDOMAIN), or it publishes the null MX (`0 .`, RFC 7505: "accepts no mail"). A domain
 * with no MX record but an address record may still receive mail, and a lookup that fails or
 * takes longer than 2 s says nothing — both count as "can".
 */
export async function domainAcceptsMail(domain: string): Promise<boolean> {
  try {
    const response = await fetch(`${DOH}?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(MX_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return true;
    const answer = (await response.json()) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (answer.Status === DNS_NXDOMAIN) return false;
    const mx = (answer.Answer ?? []).filter((record) => record.type === DNS_TYPE_MX);
    if (mx.length > 0 && mx.every((record) => /^\s*0\s+\.\s*$/.test(record.data ?? ""))) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Checks 4 and 5 for one address. Returns null when it may sign up, else the refusal code.
 * Memoized per request on the scope (sign-up runs it twice: early, and at creation).
 */
export function emailProblem(scope: AuthScope, email: string): Promise<SignupRefusalCode | null> {
  const domain = emailDomain(email);
  if (!domain) return Promise.resolve("EMAIL_NOT_ALLOWED");
  let pending = scope.domainChecks.get(domain) as Promise<SignupRefusalCode | null> | undefined;
  if (!pending) {
    pending = (async () => {
      const allowed = listOf(scope.env.SIGNUP_ALLOWED_DOMAINS);
      // An allow-list replaces the disposable check: the operator has named the domains.
      if (allowed.length > 0) return allowed.includes(domain) ? null : "EMAIL_NOT_ALLOWED";
      if (isDisposableDomain(domain)) return "EMAIL_NOT_ALLOWED";
      return (await domainAcceptsMail(domain)) ? null : "EMAIL_NOT_ALLOWED";
    })();
    scope.domainChecks.set(domain, pending);
  }
  return pending;
}

// ── velocity ────────────────────────────────────────────────────────────────────────────────

/** Sign-ups a day per subject. Overridable through `settings.ceilings` under these keys. */
export const SIGNUP_VELOCITY_DEFAULTS = {
  signupIpDay: 3,
  signupIp24Day: 20,
  signupAsnDay: 100,
  signupDomainDay: 50,
} as const;

function limitOf(
  ceilings: Record<string, number> | undefined,
  key: keyof typeof SIGNUP_VELOCITY_DEFAULTS,
): number {
  const override = ceilings?.[key];
  return typeof override === "number" && Number.isInteger(override) && override >= 0
    ? override
    : SIGNUP_VELOCITY_DEFAULTS[key];
}

/**
 * The ledger subjects one sign-up counts against, in the fixed order every sign-up takes them.
 * `signup_domain` is left out for the large public mailbox providers; `signup_asn` when the
 * request carries no ASN (local development).
 */
export async function velocitySubjects(
  scope: AuthScope,
  email: string,
  client: ClientFacts,
  day: string,
): Promise<VelocitySubject[]> {
  const ceilings = (await scope.settings()).ceilings;
  const subjects: VelocitySubject[] = [
    {
      type: "signup_ip",
      id: await ipHashDaily(scope.keys, client.ip, day),
      limit: limitOf(ceilings, "signupIpDay"),
    },
    {
      type: "signup_ip24",
      id: await ipHashDaily(scope.keys, ipPrefix(client.ip), day),
      limit: limitOf(ceilings, "signupIp24Day"),
    },
  ];
  if (client.asn !== null) {
    subjects.push({ type: "signup_asn", id: String(client.asn), limit: limitOf(ceilings, "signupAsnDay") });
  }
  const domain = emailDomain(email);
  if (domain && !PUBLIC_MAIL_PROVIDERS.has(domain)) {
    subjects.push({ type: "signup_domain", id: domain, limit: limitOf(ceilings, "signupDomainDay") });
  }
  return subjects;
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────

/** Is an invite needed for this address right now? */
export async function inviteRequired(scope: AuthScope, email: string): Promise<boolean> {
  return (await scope.settings()).signupMode === "invite" && !isAdminEmail(scope.env, email);
}

/**
 * Checks 1, 4, 5 and — read-only — 7, for an address (`email` null: the address is not known
 * yet, as in the pre-OAuth intent step). Nothing is taken. Used before the expensive part of a
 * sign-up (password hashing, the breach lookup) and by the intent route; the binding checks are
 * `takeSignup`'s. Checks 2 and 3 are `parseStatement`'s.
 */
export async function precheckSignup(
  scope: AuthScope,
  email: string | null,
  statement: SignupStatement,
): Promise<void> {
  const settings = await scope.settings();
  if (settings.readOnly) throw new SignupRefusal("SIGNUP_PAUSED");
  if (email !== null) {
    const problem = await emailProblem(scope, email);
    if (problem) throw new SignupRefusal(problem);
  }
  const needsInvite = settings.signupMode === "invite" && !(email !== null && isAdminEmail(scope.env, email));
  if (needsInvite && !(statement.inviteCode && (await inviteUsable(scope.db, statement.inviteCode)))) {
    throw new SignupRefusal("INVITE_INVALID");
  }
}

export type SignupGrant = {
  termsAcceptedAt: Date;
  termsVersion: string;
  ageVerifiedAt: Date;
  invitedBy: string | null;
  quotaBytes: number;
};

/**
 * The whole policy for one new account, ending in the reservation (6, 7). On success the scope
 * holds what was taken (`scope.reservation`) until the account exists; the caller writes the
 * returned fields on the new `user` row. `intentNonce`: the single-use marker of an OAuth
 * sign-up's intent, consumed with the invite.
 */
export async function takeSignup(
  scope: AuthScope,
  email: string,
  statement: SignupStatement,
  client: ClientFacts,
  intentNonce: string | null,
): Promise<SignupGrant> {
  const at = now();
  const settings = await scope.settings();
  if (settings.readOnly) throw new SignupRefusal("SIGNUP_PAUSED");
  const problem = await emailProblem(scope, email);
  if (problem) throw new SignupRefusal(problem);

  const needsInvite = await inviteRequired(scope, email);
  if (needsInvite && !statement.inviteCode) throw new SignupRefusal("INVITE_INVALID");

  const day = utcDay(at);
  const result = await reserveSignup(scope.db, {
    day,
    subjects: await velocitySubjects(scope, email, client, day),
    // A code that is not needed is not used up.
    inviteCode: needsInvite ? statement.inviteCode : null,
    intentNonce,
    now: at,
  });
  if (!result.ok) {
    if (result.reason === "velocity") throw new SignupRefusal("SIGNUP_LIMIT");
    if (result.reason === "invite") throw new SignupRefusal("INVITE_INVALID");
    throw new SignupRefusal("SIGNUP_INTENT_REQUIRED");
  }
  scope.reservation = { taken: result.reservation, email };

  const quota = Number(scope.env.QUOTA_BYTES);
  return {
    termsAcceptedAt: at,
    termsVersion: settings.termsVersion,
    ageVerifiedAt: at,
    invitedBy: result.invitedBy,
    quotaBytes: Number.isSafeInteger(quota) && quota > 0 ? quota : 5_368_709_120,
  };
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────

/**
 * May this account start a session now? Throws `SessionRefusal`. Reads the DATABASE (never a
 * cached session). Also the admin bootstrap: a verified `ADMIN_EMAILS` address gets the `admin`
 * role here, before its session exists — never an unverified one, and never through an
 * impersonated session.
 */
export async function checkSessionStart(
  scope: AuthScope,
  userId: string,
  impersonated: boolean,
): Promise<void> {
  const account = await getAccount(scope.db, userId);
  // No such user: Better Auth's own insert fails on the foreign key.
  if (!account) return;
  const at = now().getTime();
  // From the scheduled moment the account behaves as deleted, whether or not the purge has run.
  if (account.deleteScheduledAt && account.deleteScheduledAt.getTime() <= at) {
    throw new SessionRefusal("invalid_credentials");
  }
  if ((await purgeStartedAt(scope.db, userId)) !== null) throw new SessionRefusal("invalid_credentials");
  if (account.suspendedAt) throw new SessionRefusal("suspended");

  if (
    !impersonated &&
    account.emailVerified &&
    isAdminEmail(scope.env, account.email) &&
    !hasAdminRole(account.role)
  ) {
    if (await grantAdminRole(scope.db, userId)) {
      audit(scope.deps, "auth.admin_granted", { type: "user", id: userId }, { source: "ADMIN_EMAILS" });
    }
  }
}
