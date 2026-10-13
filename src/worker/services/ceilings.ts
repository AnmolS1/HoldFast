// Daily ceilings — the ONE home of them. Routes ask here whether a download, an upload, a
// thumbnail transform, a share or a link still fits today; nothing else reads the limit vars or
// `settings.ceilings`.
//
//   kind             ledger subject     base limit (var, overridden per key by settings.ceilings)   scales with quota               new-account factor
//   download_user    user               bytes CEIL_USER_BYTES_DAY                                    max(base, quotaBytes)           yes
//   download_link    link               bytes CEIL_LINK_BYTES_DAY, count CEIL_LINK_DOWNLOADS_DAY     no                              yes — by the link OWNER's age
//   download_ip      ip                 bytes CEIL_IP_BYTES_DAY                                      no                              no
//   upload_user      upload_user        bytes CEIL_UPLOAD_BYTES_DAY, count CEIL_UPLOAD_COUNT_DAY     bytes max(base, quota);         yes
//   (subject = the OWNER being filled)                                                               count max(base, quota / 10 MiB)
//   upload_editor    upload_editor      bytes CEIL_EDITOR_UPLOAD_BYTES_DAY                           no                              yes
//   (subject = an editor uploading into someone else's tree)
//   transform_user   transform_user     count CEIL_TRANSFORMS_DAY                                    no                              yes
//   share_user       share_user         count CEIL_SHARES_DAY                                        no                              yes
//   link_user        link_user          count CEIL_LINKS_DAY                                         no                              yes
//
// ORDER: base (var, then the settings override) → quota scaling → × NEW_ACCOUNT_FACTOR while the
// account is younger than NEW_ACCOUNT_DAYS. Link and address limits never scale with a quota:
// they protect against strangers.
//
// USED = today's ledger total + OPEN WORK. The ledger is written when an upload completes, so for
// the two upload kinds the bytes and count of unfinished sessions are added — otherwise an editor
// could pin an owner's whole day with sessions that are merely open. Callers pass only the NEW
// amount. A check passes when `used + amount <= limit` on every dimension the kind has.
// Days are UTC.
//
// `link_user` also carries the new-account cap on LIVE links (NEW_ACCOUNT_MAX_LINKS).
//
// FAIL CLOSED: a limit that cannot be read — a var that is missing or not a number — is 0, and
// everything of that kind is refused. An account is REQUIRED for every kind but `download_ip`
// (the new-account factor needs its age): leaving it out is a programming error and throws.
//
// REQUEST-ONLY: called from request handlers, so these keep the Hono context (they read
// `settings(c)`, memoised for the request).
//
// CHECK-THEN-RECORD IS NOT ATOMIC. `checkCeiling` / `enforceCeiling` read, the caller acts, and
// `recordUsage` writes later (a download is recorded when its bytes have been sent): requests
// that run together each see the total before the others' — the ceiling can be overshot by what
// is in flight. Where a kind is counted BEFORE the action and its `used` is the ledger alone
// (a share, a link, a transform), use `consumeCeiling`: one statement that adds only if the total
// stays within the limit.
//
// Every refusal emits one `ceiling` metric (kind, reason = the dimension). Callers add none.

import type { Context } from "hono";
import type { CeilingKey } from "../../shared/constants";
import { addUsage, addUsageIfUnder, todayTotals, utcDay } from "../db/queries/ledger";
import { countLive } from "../db/queries/links";
import type { Settings } from "../db/queries/settings";
import { openBytes } from "../db/queries/uploads";
import type { LedgerSubject } from "../db/schema";
import { now } from "./clock";
import { AppError } from "./errors";
import { writeMetric } from "./metrics";
import { db, settings, type AppEnv } from "./request-context";

export type CeilingKind =
  | "download_user"
  | "download_link"
  | "download_ip"
  | "upload_user"
  | "upload_editor"
  | "transform_user"
  | "share_user"
  | "link_user";

/** `account`: the user the limit scales with — for `download_link`, the link's owner. */
export interface CeilingSubject {
  id: string;
  account?: { quotaBytes: number; createdAt: Date };
}

export interface Amount {
  bytes?: number;
  count?: number;
}

export type CeilingResult =
  | { ok: true }
  | {
      ok: false;
      kind: CeilingKind;
      dimension: "bytes" | "count";
      limit: number;
      used: number;
      retryAfterSec: number;
    };

type LimitEnv = Pick<Env, Exclude<CeilingKey, `signup${string}`>>;
type LimitSettings = Pick<Settings, "ceilings">;

type Rule = {
  subject: LedgerSubject;
  bytes?: Exclude<CeilingKey, `signup${string}`>;
  count?: Exclude<CeilingKey, `signup${string}`>;
  /** Scale with the account's quota. */
  scales?: boolean;
  /** Shrink for a new account. False only for limits that are not about an account. */
  newAccountFactor: boolean;
  /** `used` also counts unfinished upload sessions. */
  open?: "owner" | "editor";
};

const RULES: Record<CeilingKind, Rule> = {
  download_user: { subject: "user", bytes: "CEIL_USER_BYTES_DAY", scales: true, newAccountFactor: true },
  download_link: {
    subject: "link",
    bytes: "CEIL_LINK_BYTES_DAY",
    count: "CEIL_LINK_DOWNLOADS_DAY",
    newAccountFactor: true,
  },
  download_ip: { subject: "ip", bytes: "CEIL_IP_BYTES_DAY", newAccountFactor: false },
  upload_user: {
    subject: "upload_user",
    bytes: "CEIL_UPLOAD_BYTES_DAY",
    count: "CEIL_UPLOAD_COUNT_DAY",
    scales: true,
    newAccountFactor: true,
    open: "owner",
  },
  upload_editor: {
    subject: "upload_editor",
    bytes: "CEIL_EDITOR_UPLOAD_BYTES_DAY",
    newAccountFactor: true,
    open: "editor",
  },
  transform_user: { subject: "transform_user", count: "CEIL_TRANSFORMS_DAY", newAccountFactor: true },
  share_user: { subject: "share_user", count: "CEIL_SHARES_DAY", newAccountFactor: true },
  link_user: { subject: "link_user", count: "CEIL_LINKS_DAY", newAccountFactor: true },
};

export const CEILING_KINDS = Object.keys(RULES) as CeilingKind[];

/** One uploaded file is counted as at least this many bytes of quota when the count limit scales. */
const BYTES_PER_COUNTED_UPLOAD = 10_485_760;
const DAY_MS = 86_400_000;

/** A limit value: the settings override when there is one, else the var. Unreadable → null. */
function read(env: LimitEnv, stored: LimitSettings, key: keyof LimitEnv): number | null {
  const override = stored.ceilings?.[key];
  const value = override !== undefined ? override : Number(env[key] === "" ? Number.NaN : env[key]);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** True while the account is younger than NEW_ACCOUNT_DAYS. An unreadable setting counts as new. */
function isNewAccount(env: LimitEnv, stored: LimitSettings, createdAt: Date, at: Date): boolean {
  const days = read(env, stored, "NEW_ACCOUNT_DAYS");
  if (days === null) return true;
  const created = createdAt.getTime();
  // An unreadable creation time is treated as "just now".
  return Number.isNaN(created) || at.getTime() - created < days * DAY_MS;
}

function requireAccount(kind: CeilingKind, account: CeilingSubject["account"]) {
  if (!account) throw new Error(`ceilings: ${kind} needs the account the limit belongs to`);
  return account;
}

/**
 * Today's limits of one kind for one account, after quota scaling and the new-account factor.
 * A dimension the kind does not have is absent. `at` is "now" (for the account's age).
 */
export function effectiveLimits(
  env: LimitEnv,
  stored: LimitSettings,
  kind: CeilingKind,
  account?: CeilingSubject["account"],
  at: Date = new Date(),
): { bytes?: number; count?: number } {
  const rule = RULES[kind];
  const forAccount = rule.newAccountFactor ? requireAccount(kind, account) : undefined;
  const quota =
    forAccount && Number.isFinite(forAccount.quotaBytes) && forAccount.quotaBytes > 0
      ? forAccount.quotaBytes
      : 0;

  let factor = 1;
  if (forAccount && isNewAccount(env, stored, forAccount.createdAt, at)) {
    const configured = read(env, stored, "NEW_ACCOUNT_FACTOR");
    factor = configured === null ? 0 : Math.min(configured, 1);
  }

  const out: { bytes?: number; count?: number } = {};
  if (rule.bytes) {
    const base = read(env, stored, rule.bytes) ?? 0;
    out.bytes = Math.floor((rule.scales ? Math.max(base, quota) : base) * factor);
  }
  if (rule.count) {
    const base = read(env, stored, rule.count) ?? 0;
    const scaled = rule.scales ? Math.max(base, Math.floor(quota / BYTES_PER_COUNTED_UPLOAD)) : base;
    out.count = Math.floor(scaled * factor);
  }
  return out;
}

function validAmount(amount: Amount): { bytes: number; count: number } {
  const bytes = amount.bytes ?? 0;
  const count = amount.count ?? 0;
  for (const value of [bytes, count]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AppError("validation", "Invalid amount.");
  }
  return { bytes, count };
}

/** Seconds until the next 00:00 UTC — the `Retry-After` of a refusal. At least 1. */
function secondsToMidnightUTC(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

function refuse(
  c: Context<AppEnv>,
  kind: CeilingKind,
  dimension: "bytes" | "count",
  limit: number,
  used: number,
): CeilingResult {
  writeMetric(c.env, "ceiling", { kind, outcome: "refused", reason: dimension });
  return { ok: false, kind, dimension, limit, used, retryAfterSec: secondsToMidnightUTC(now(c)) };
}

/** The new-account cap on live links, or null when it does not apply or is not reached. */
async function liveLinkCap(
  c: Context<AppEnv>,
  stored: LimitSettings,
  subject: CeilingSubject,
): Promise<{ limit: number; used: number } | null> {
  const account = requireAccount("link_user", subject.account);
  if (!isNewAccount(c.env, stored, account.createdAt, now(c))) return null;
  const limit = read(c.env, stored, "NEW_ACCOUNT_MAX_LINKS") ?? 0;
  const used = await countLive(db(c), subject.id);
  return used >= limit ? { limit, used } : null;
}

/** Whether `amount` more of `kind` still fits today for this subject. Emits the refusal metric. */
export async function checkCeiling(
  c: Context<AppEnv>,
  kind: CeilingKind,
  subject: CeilingSubject,
  amount: Amount,
): Promise<CeilingResult> {
  const rule = RULES[kind];
  const add = validAmount(amount);
  const stored = await settings(c);
  const limits = effectiveLimits(c.env, stored, kind, subject.account, now(c));

  if (kind === "link_user") {
    const cap = await liveLinkCap(c, stored, subject);
    if (cap) return refuse(c, kind, "count", cap.limit, cap.used);
  }

  const used = await todayTotals(db(c), rule.subject, subject.id);
  if (rule.open) {
    const open = await openBytes(
      db(c),
      rule.open === "owner" ? { ownerId: subject.id } : { editorId: subject.id },
    );
    used.bytes += open.bytes;
    used.count += open.count;
  }
  for (const dimension of ["bytes", "count"] as const) {
    const limit = limits[dimension];
    if (limit !== undefined && used[dimension] + add[dimension] > limit) {
      return refuse(c, kind, dimension, limit, used[dimension]);
    }
  }
  return { ok: true };
}

function exceeded(result: Extract<CeilingResult, { ok: false }>): AppError {
  return new AppError(
    "ceiling_exceeded",
    undefined,
    { kind: result.kind, dimension: result.dimension },
    { "Retry-After": String(result.retryAfterSec) },
  );
}

/** `checkCeiling`, throwing `429 ceiling_exceeded` with `Retry-After` to 00:00 UTC on a refusal. */
export async function enforceCeiling(
  c: Context<AppEnv>,
  kind: CeilingKind,
  subject: CeilingSubject,
  amount: Amount,
): Promise<void> {
  const result = await checkCeiling(c, kind, subject, amount);
  if (!result.ok) throw exceeded(result);
}

/** Adds to today's ledger row of the kind's subject. It enforces nothing. */
export async function recordUsage(
  c: Context<AppEnv>,
  kind: CeilingKind,
  subjectId: string,
  amount: Amount,
): Promise<void> {
  const add = validAmount(amount);
  await addUsage(db(c), utcDay(), RULES[kind].subject, subjectId, add.bytes, add.count);
}

/**
 * Check AND record in one statement: the amount is added only if today's total stays within the
 * limit, so requests that run together cannot take the counter past it. Throws
 * `429 ceiling_exceeded` otherwise. For kinds counted before the action whose `used` is the
 * ledger alone — not the two upload kinds (their open sessions are not in the ledger).
 */
export async function consumeCeiling(
  c: Context<AppEnv>,
  kind: Exclude<CeilingKind, "upload_user" | "upload_editor">,
  subject: CeilingSubject,
  amount: Amount,
): Promise<void> {
  const rule = RULES[kind];
  if (rule.open) throw new Error(`ceilings: ${kind} cannot be consumed atomically`);
  const add = validAmount(amount);
  const stored = await settings(c);
  const limits = effectiveLimits(c.env, stored, kind, subject.account, now(c));
  if (kind === "link_user") {
    const cap = await liveLinkCap(c, stored, subject);
    if (cap)
      throw exceeded(refuse(c, kind, "count", cap.limit, cap.used) as Extract<CeilingResult, { ok: false }>);
  }
  if (await addUsageIfUnder(db(c), utcDay(), rule.subject, subject.id, add, limits)) return;
  // Refused by the statement: say which dimension, from a fresh read.
  const used = await todayTotals(db(c), rule.subject, subject.id);
  const dimension = limits.count !== undefined && used.count + add.count > limits.count ? "count" : "bytes";
  const result = refuse(c, kind, dimension, limits[dimension] ?? 0, used[dimension]);
  throw exceeded(result as Extract<CeilingResult, { ok: false }>);
}
