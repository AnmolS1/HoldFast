// Daily ceilings — the ONE home of them. Routes ask here whether a download, an upload, a
// thumbnail transform, a share or a link still fits today; nothing else reads the limit vars or
// `settings.ceilings`.
//
//   kind             ledger subject     base limit (var, overridden per key by settings.ceilings)   scales with quota               new-account factor
//   download_user    user               bytes CEIL_USER_BYTES_DAY                                    max(base, quotaBytes)           yes
//   download_link    link               bytes CEIL_LINK_BYTES_DAY, count CEIL_LINK_DOWNLOADS_DAY     no                              yes — by the link OWNER's age
//   download_ip      ip                 bytes CEIL_IP_BYTES_DAY                                      no                              no
//   download_owner   link_owner         bytes CEIL_OWNER_LINK_BYTES_DAY                              no                              yes
//   (subject = the OWNER of the link being served: the sum over all of one owner's links)
//   upload_user      upload_user        bytes CEIL_UPLOAD_BYTES_DAY, count CEIL_UPLOAD_COUNT_DAY     bytes max(base, quota);         yes
//   (subject = the OWNER being filled)                                                               count max(base, quota / 10 MB)
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
// A LIMIT THAT IS READ IN ONE STATEMENT AND ACTED ON IN ANOTHER IS NOT A LIMIT: requests that run
// together each see the same total and all pass. So there is no check-then-record call here:
//
//   the ledger-only kinds        consumeCeiling(c, kind, subject, amount)
//   (downloads, transforms,      ONE statement that adds the amount only if the day's total stays
//   shares)                      within the limit. The amount is charged up front: a download
//                                that is then aborted stays charged (conservative, on purpose).
//   the upload kinds             enforceUploadCeilings(c, { owner, editor? }, amount, { tx })
//                                ONE call for one upload: `upload_user` for the owner being
//                                filled and, for an editor in someone else's tree, `upload_editor`
//                                too. `used` includes open sessions, so the check and the INSERT
//                                of the caller's `uploads` row are one transaction: this takes
//                                the `user` row locks ITSELF — in the one safe order — reads the
//                                totals through `tx`, and the caller inserts its session row in
//                                that transaction.
//   link_user                    consumeCeiling(c, "link_user", subject, amount, { tx })
//                                The cap on live links is a count of rows: under the same lock,
//                                and the caller inserts the link in that transaction.
//
// LOCK ORDER: the `user` row before anything else, and two users in ascending id order — decided
// HERE, never by the order a caller happens to name them in (two uploads between the same two
// people, each in the other's tree, would otherwise deadlock). Call the `tx` forms FIRST in the
// transaction (before reserving quota, which takes the owner's row too).
//
// `checkCeiling` remains as a READ-ONLY PREVIEW ("this will not fit"). It authorises nothing.
// `recordUsage` adds to the ledger and enforces nothing: it is for corrections.
//
// Every refusal emits one `ceiling` metric (kind, reason = the dimension). Callers add none.

import type { Context } from "hono";
import type { CeilingKey } from "../../shared/constants";
import type { Executor, Tx } from "../db/client";
import { addUsage, addUsageIfUnder, todayTotals, utcDay } from "../db/queries/ledger";
import { countLive } from "../db/queries/links";
import type { Settings } from "../db/queries/settings";
import { openBytes } from "../db/queries/uploads";
import { lockUser } from "../db/queries/users";
import type { LedgerSubject } from "../db/schema";
import { now } from "./clock";
import { AppError } from "./errors";
import { writeMetric } from "./metrics";
import { db, settings, type AppEnv } from "./request-context";

export type CeilingKind =
  | "download_user"
  | "download_link"
  | "download_ip"
  | "download_owner"
  | "upload_user"
  | "upload_editor"
  | "transform_user"
  | "share_user"
  | "link_user";

/** The kinds whose `used` is the ledger alone: enforced by `consumeCeiling`, in one statement. */
export type LedgerOnlyKind =
  "download_user" | "download_link" | "download_ip" | "download_owner" | "transform_user" | "share_user";
/** The kinds whose `used` includes open upload sessions: enforced inside the caller's transaction. */
export type UploadKind = "upload_user" | "upload_editor";

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

/**
 * The ledger subjects a ceiling is counted on. Never `notice` (once-a-day markers live there, and
 * a marker must not be summed into a total) and never a sign-up velocity subject.
 */
export type CeilingLedgerSubject = Extract<
  LedgerSubject,
  | "user"
  | "link"
  | "ip"
  | "link_owner"
  | "upload_user"
  | "upload_editor"
  | "transform_user"
  | "share_user"
  | "link_user"
>;

type Rule = {
  subject: CeilingLedgerSubject;
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
  // Everything one owner's public links serve in a day. Only link-subject downloads consume it.
  download_owner: { subject: "link_owner", bytes: "CEIL_OWNER_LINK_BYTES_DAY", newAccountFactor: true },
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

/** When the upload COUNT limit scales with the quota: one file a day per this many bytes of it. */
const BYTES_PER_COUNTED_UPLOAD = 10_000_000;
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
  exec: Executor,
  stored: LimitSettings,
  subject: CeilingSubject,
): Promise<{ limit: number; used: number } | null> {
  const account = requireAccount("link_user", subject.account);
  if (!isNewAccount(c.env, stored, account.createdAt, now(c))) return null;
  const limit = read(c.env, stored, "NEW_ACCOUNT_MAX_LINKS") ?? 0;
  const used = await countLive(exec, subject.id);
  return used >= limit ? { limit, used } : null;
}

/** The decision, read through `exec` (the request's client, or a transaction that holds the lock). */
async function evaluate(
  c: Context<AppEnv>,
  exec: Executor,
  kind: CeilingKind,
  subject: CeilingSubject,
  amount: Amount,
): Promise<CeilingResult> {
  const rule = RULES[kind];
  const add = validAmount(amount);
  const stored = await settings(c);
  const limits = effectiveLimits(c.env, stored, kind, subject.account, now(c));

  if (kind === "link_user") {
    const cap = await liveLinkCap(c, exec, stored, subject);
    if (cap) return refuse(c, kind, "count", cap.limit, cap.used);
  }

  const used = await todayTotals(exec, rule.subject, subject.id);
  if (rule.open) {
    const open = await openBytes(
      exec,
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

/**
 * A READ-ONLY PREVIEW: would `amount` more of `kind` still fit today? For a route that wants to
 * say "this will not fit" before doing work. IT AUTHORISES NOTHING — another request can use the
 * room before this one acts. What admits is `consumeCeiling` / `enforceUploadCeilings`.
 * Emits the refusal metric.
 */
export async function checkCeiling(
  c: Context<AppEnv>,
  kind: CeilingKind,
  subject: CeilingSubject,
  amount: Amount,
): Promise<CeilingResult> {
  return evaluate(c, db(c), kind, subject, amount);
}

function exceeded(result: CeilingResult): AppError {
  if (result.ok) throw new Error("ceilings: not a refusal");
  return new AppError(
    "ceiling_exceeded",
    undefined,
    { kind: result.kind, dimension: result.dimension },
    { "Retry-After": String(result.retryAfterSec) },
  );
}

function requireTx(kind: CeilingKind, opts: { tx?: Tx } | undefined): Tx {
  if (!opts?.tx)
    throw new Error(`ceilings: ${kind} is enforced inside the caller's transaction (pass { tx })`);
  return opts.tx;
}

/** Locks the users' rows, lowest id first. `404 not_found` when one of them does not exist. */
async function lockUsers(tx: Tx, userIds: string[]): Promise<void> {
  for (const userId of [...new Set(userIds)].sort()) {
    if (!(await lockUser(tx, userId))) throw new AppError("not_found");
  }
}

/**
 * THE admission of one new upload session, in the caller's transaction: `upload_user` for the
 * owner whose tree is filled and — when `editor` is given and is someone else — `upload_editor`
 * for the editor. Throws `429 ceiling_exceeded` (`Retry-After` to 00:00 UTC) naming the kind that
 * refused; `404 not_found` when one of the two users does not exist.
 *
 * It takes the `user` row locks ITSELF, in ascending id order whichever of the two is the owner,
 * before it reads anything; reads the ledger and the open sessions through `tx`; and THE CALLER
 * INSERTS ITS `uploads` ROW IN THE SAME TRANSACTION — that row is what the next admission counts.
 * Call it first in the transaction; then reserve quota and insert the row.
 *
 * `amount`: the session's bytes, and `count: 1` for the file. (The editor's ceiling has no count.)
 * There is no single-kind call: two calls would leave the lock order to the caller.
 */
export async function enforceUploadCeilings(
  c: Context<AppEnv>,
  subjects: { owner: CeilingSubject; editor?: CeilingSubject },
  amount: Amount,
  opts: { tx: Tx },
): Promise<void> {
  const tx = requireTx("upload_user", opts);
  const editor = subjects.editor && subjects.editor.id !== subjects.owner.id ? subjects.editor : null;
  await lockUsers(tx, editor ? [subjects.owner.id, editor.id] : [subjects.owner.id]);
  const forOwner = await evaluate(c, tx, "upload_user", subjects.owner, amount);
  if (!forOwner.ok) throw exceeded(forOwner);
  if (editor) {
    const forEditor = await evaluate(c, tx, "upload_editor", editor, amount);
    if (!forEditor.ok) throw exceeded(forEditor);
  }
}

/**
 * Adds to today's ledger row of the kind's subject. IT ENFORCES NOTHING: it is for corrections
 * and for usage that was admitted another way (a completed upload). Never pair it with
 * `checkCeiling` to make a limit — that is the sequence concurrent requests walk through.
 */
export async function recordUsage(
  c: Context<AppEnv>,
  kind: CeilingKind,
  subjectId: string,
  amount: Amount,
  opts: { tx?: Tx } = {},
): Promise<void> {
  const add = validAmount(amount);
  await addUsage(opts.tx ?? db(c), utcDay(), RULES[kind].subject, subjectId, add.bytes, add.count);
}

/**
 * Check AND record in one statement: the amount is added only if today's total stays within the
 * limit, so requests that run together cannot take the counter past it. Throws
 * `429 ceiling_exceeded` (`Retry-After` to 00:00 UTC) otherwise. THE enforcing call for the
 * ledger-only kinds. The amount is charged up front: what is then not used stays charged.
 *
 * `link_user` also has the new-account cap on LIVE links, which is a count of rows: that form
 * runs in the caller's transaction (`{ tx }`), takes the user's row lock itself, counts and adds
 * through `tx` — and the caller inserts the link in the same transaction.
 */
export async function consumeCeiling(
  c: Context<AppEnv>,
  kind: LedgerOnlyKind,
  subject: CeilingSubject,
  amount: Amount,
): Promise<void>;
export async function consumeCeiling(
  c: Context<AppEnv>,
  kind: "link_user",
  subject: CeilingSubject,
  amount: Amount,
  opts: { tx: Tx },
): Promise<void>;
export async function consumeCeiling(
  c: Context<AppEnv>,
  kind: LedgerOnlyKind | "link_user",
  subject: CeilingSubject,
  amount: Amount,
  opts?: { tx: Tx },
): Promise<void> {
  const rule = RULES[kind];
  if (!rule || rule.open)
    throw new Error(`ceilings: ${String(kind)} cannot be consumed: use enforceUploadCeilings`);
  const add = validAmount(amount);
  const stored = await settings(c);
  const limits = effectiveLimits(c.env, stored, kind, subject.account, now(c));

  let exec: Executor = db(c);
  if (kind !== "link_user" && opts !== undefined) {
    throw new Error(`ceilings: ${kind} is consumed in one statement of its own, not in a transaction`);
  }
  if (kind === "link_user") {
    const tx = requireTx(kind, opts);
    await lockUsers(tx, [subject.id]);
    exec = tx;
    const cap = await liveLinkCap(c, tx, stored, subject);
    if (cap) throw exceeded(refuse(c, kind, "count", cap.limit, cap.used));
  }
  if (await addUsageIfUnder(exec, utcDay(), rule.subject, subject.id, add, limits)) return;
  // Refused by the statement: say which dimension, from a fresh read.
  const used = await todayTotals(exec, rule.subject, subject.id);
  const dimension = limits.count !== undefined && used.count + add.count > limits.count ? "count" : "bytes";
  throw exceeded(refuse(c, kind, dimension, limits[dimension] ?? 0, used[dimension]));
}
