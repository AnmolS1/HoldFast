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
//   7. invite             when sign-up is invite-only — for EVERY address. An `ADMIN_EMAILS`
//                         address needs one like any other (the first admin's is made with
//                         scripts/create-invite.ts): an exemption would answer a sign-up without
//                         an invite differently for an admin address, telling anyone who asks
//                         which addresses are admins. `ADMIN_EMAILS` only decides who is given
//                         the admin role at their first VERIFIED session (`checkSessionStart`).
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

import { isThirteenOrOlder as sharedIsThirteenOrOlder } from "../../shared/age";
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
import { todayTotals, utcDay } from "../db/queries/ledger";
import { record } from "../auth/observe";
import { isTestMode, now } from "./clock";
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
 * Certainly thirteen — the rule itself is src/shared/age.ts, the one copy the sign-up form uses
 * too. Here it reads the server's clock.
 */
export function isThirteenOrOlder(birthYear: number, birthMonth: number, at: Date = now()): boolean {
  return sharedIsThirteenOrOlder(birthYear, birthMonth, at);
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

/** RFC 2606 / 6761: names under these can never be anyone's real mailbox. */
const RESERVED_TEST_DOMAIN = /@[a-z0-9.-]+\.(?:example|test)$/;

type AdminListEnv = Pick<Env, "ADMIN_EMAILS"> & {
  E2E_ADMIN_EMAILS?: string;
  EMAIL_TRANSPORT?: string;
  SENTRY_ENVIRONMENT?: string;
  APP_ORIGIN?: string;
};

/**
 * The addresses that are given the admin role: `ADMIN_EMAILS`.
 *
 * TEST SEAM (never on a deploy — `isTestMode`: the memory mail transport, a non-production
 * environment AND a plain-http origin): when the e2e run passes `E2E_ADMIN_EMAILS`
 * (playwright.config.ts → vite.config.ts), that list is used INSTEAD, and only its addresses at
 * a reserved test domain (`.example`, `.test`) count; `*@domain` there names every address at
 * that domain. So an end-to-end run has admins without ever creating an account for the
 * operator's real address — no test reads `ADMIN_EMAILS`. In `ADMIN_EMAILS` itself a `*` is an
 * ordinary character: no real list can name a domain.
 */
function adminList(env: AdminListEnv): { addresses: string[]; domains: string[] } {
  if (isTestMode(env) && typeof env.E2E_ADMIN_EMAILS === "string" && env.E2E_ADMIN_EMAILS.trim() !== "") {
    const entries = listOf(env.E2E_ADMIN_EMAILS).filter((entry) => RESERVED_TEST_DOMAIN.test(entry));
    return {
      addresses: entries.filter((entry) => !entry.startsWith("*@")),
      // `*@domain`: every address at exactly that (reserved) domain — the e2e seam only.
      domains: entries.filter((entry) => entry.startsWith("*@")).map((entry) => entry.slice(1)),
    };
  }
  return { addresses: listOf(env.ADMIN_EMAILS), domains: [] };
}

/**
 * Is the address one of `ADMIN_EMAILS`? Used for ONE thing: granting the admin role when a
 * verified account signs in. It must never change what a sign-up is answered.
 */
export function isAdminEmail(env: AdminListEnv, email: string): boolean {
  const address = email.trim().toLowerCase();
  if (address === "") return false;
  const list = adminList(env);
  if (list.addresses.includes(address)) return true;
  const at = address.lastIndexOf("@");
  return at > 0 && list.domains.includes(address.slice(at));
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

/** Is an invite needed right now? The same answer for every address (see check 7 above). */
export async function inviteRequired(scope: AuthScope): Promise<boolean> {
  return (await scope.settings()).signupMode === "invite";
}

/**
 * Checks 1, 4, 5 and — read-only — 6 and 7, for an address (`email` null: the address is not known
 * yet, as in the pre-OAuth intent step). Nothing is taken. Used before the expensive part of a
 * sign-up (password hashing, the breach lookup) and by the intent route; the binding checks are
 * `takeSignup`'s. Checks 2 and 3 are `parseStatement`'s.
 */
export async function precheckSignup(
  scope: AuthScope,
  email: string | null,
  statement: SignupStatement,
  client: ClientFacts | null = null,
): Promise<void> {
  const settings = await scope.settings();
  if (settings.readOnly) throw new SignupRefusal("SIGNUP_PAUSED");
  if (email !== null) {
    const problem = await emailProblem(scope, email);
    if (problem) throw new SignupRefusal(problem);
  }
  // Velocity, read-only. The binding check is the reservation in `takeSignup` — but that runs
  // only for an address with no account, so without this an address over its limit would be
  // told "limit" for a new address and "200" for one that exists: an existence oracle.
  if (client !== null) {
    const day = utcDay(now());
    const subjects = await velocitySubjects(scope, email ?? "", client, day);
    const counts = await Promise.all(
      subjects.map((subject) => todayTotals(scope.db, subject.type, subject.id)),
    );
    if (subjects.some((subject, index) => counts[index]!.count >= subject.limit)) {
      throw new SignupRefusal("SIGNUP_LIMIT");
    }
  }
  const needsInvite = settings.signupMode === "invite";
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

  const needsInvite = await inviteRequired(scope);
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

/**
 * What changing an unverified account's address costs: one count on every velocity subject of
 * the NEW address — the same budget a sign-up with that address takes (check 6), in the same
 * transaction shape. Throws `SignupRefusal("SIGNUP_LIMIT")` at a limit. No invite is involved:
 * the account being moved already used one.
 *
 * The caller takes this BEFORE it looks at any account, and never gives it back: whether the
 * change then moved an account, or the address belongs to someone, or the cookie names nobody,
 * costs the same — so the route cannot be used to try addresses for free.
 */
export async function takeAddressChange(
  scope: AuthScope,
  newEmail: string,
  client: ClientFacts,
): Promise<void> {
  const at = now();
  const day = utcDay(at);
  const result = await reserveSignup(scope.db, {
    day,
    subjects: await velocitySubjects(scope, newEmail, client, day),
    inviteCode: null,
    intentNonce: null,
    now: at,
  });
  if (!result.ok) throw new SignupRefusal("SIGNUP_LIMIT");
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────

/**
 * May this account start a session now? Throws `SessionRefusal`. Reads the DATABASE (never a
 * cached session). Also the admin bootstrap: a verified `ADMIN_EMAILS` address gets the `admin`
 * role here, before its session exists — never an unverified one, never through an
 * impersonated session, and never for a session that a mailed link creates (`mayGrantAdmin`).
 */
export async function checkSessionStart(
  scope: AuthScope,
  userId: string,
  impersonated: boolean,
  /**
   * False for a session that a mailed LINK creates (the verification click): a click proves a
   * mailbox, not a credential, and the admin role is granted only by a sign-in.
   */
  mayGrantAdmin = true,
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
    mayGrantAdmin &&
    !impersonated &&
    account.emailVerified &&
    isAdminEmail(scope.env, account.email) &&
    !hasAdminRole(account.role)
  ) {
    if (await grantAdminRole(scope.db, userId)) {
      record(scope.deps, "auth.admin_granted", { type: "user", id: userId }, { source: "ADMIN_EMAILS" });
    }
  }
}
