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
//   shares)                      within the limit. IT THROWS `429 ceiling_exceeded` on a refusal
//                                and charges nothing then — a caller cannot ignore a refusal.
//                                `tryConsumeCeiling` is the same step for a caller that must do
//                                something of its own on a refusal: it ANSWERS, and that caller
//                                MUST refuse the request when `ok` is false.
//                                The amount is charged up front; what was then not sent is given
//                                back with `refundUsage`.
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
// `recordUsage` adds to the ledger and enforces nothing: it is for usage admitted another way.
//
// ONE CLOCK PER DECISION. The ledger day, the totals that are read and the `Retry-After` of a
// refusal all come from ONE instant — `now(c)`, read once at the start of the call — so a
// decision made at 23:59:59.999 UTC is wholly about that day and one made a millisecond later
// wholly about the next. (The database's own clock is not asked which day it is: the totals are
// read for the day computed here.)
//
// THE AMOUNT IS TYPED PER KIND: a bytes-only kind takes `{ bytes }`, a count-only kind
// `{ count }`, the two kinds with both dimensions either or both. The wrong dimension does not
// compile, and at run time an amount that names no dimension of its kind is a `validation` error
// — it would otherwise add nothing to the limited dimension and pass.
//
// Every refusal of an ENFORCING call (`consumeCeiling`, `tryConsumeCeiling`,
// `enforceUploadCeilings`) emits one `ceiling` metric (kind, reason = the dimension). Callers add
// none; a preview emits none.

import type { Context } from "hono";
import type { CeilingKey } from "../../shared/constants";
import type { Executor, Tx } from "../db/client";
import { addUsage, addUsageIfUnder, subtractUsage, totalsOn, utcDay } from "../db/queries/ledger";
import { countLive } from "../db/queries/links";
import type { Settings } from "../db/queries/settings";
import { openBytes } from "../db/queries/uploads";
import { lockUser } from "../db/queries/users";
import type { LedgerSubject } from "../db/schema";
import { now } from "./clock";
import { AppError } from "./errors";
import { writeMetric } from "./metrics";
import { db, settings, type AppEnv, type ServiceDeps } from "./request-context";

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

/** The loose shape. What a call takes is `AmountOf<kind>`. */
export interface Amount {
  bytes?: number;
  count?: number;
}

export type BytesOnlyKind = "download_user" | "download_ip" | "download_owner" | "upload_editor";
export type CountOnlyKind = "transform_user" | "share_user" | "link_user";

/**
 * What an amount of a kind may name: bytes for a bytes-only kind, a count for a count-only kind,
 * either or both for the two kinds that have both dimensions (`download_link`, `upload_user`).
 */
export type AmountOf<K extends CeilingKind> = K extends BytesOnlyKind
  ? { bytes: number; count?: never }
  : K extends CountOnlyKind
    ? { count: number; bytes?: never }
    : { bytes: number; count?: number } | { count: number; bytes?: number };

/** What one new upload session asks for: its bytes, and `count: 1` for the file. */
export type UploadAmount = { bytes: number; count: number };

export type CeilingRefusal = {
  ok: false;
  kind: CeilingKind;
  dimension: "bytes" | "count";
  limit: number;
  used: number;
  retryAfterSec: number;
};
export type CeilingResult = { ok: true } | CeilingRefusal;

/** The receipt of a charge: the UTC day (`YYYY-MM-DD`) it was booked on. `refundUsage` needs it. */
export type ConsumeReceipt = { day: string };
export type ConsumeResult = ({ ok: true } & ConsumeReceipt) | CeilingRefusal;

type LimitKey = Exclude<CeilingKey, `signup${string}`>;
type LimitEnv = Pick<Env, LimitKey>;
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
  bytes?: LimitKey;
  count?: LimitKey;
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
const DIMENSIONS = ["bytes", "count"] as const;

/** A limit value: the settings override when there is one, else the var. Unreadable → null. */
function read(env: LimitEnv, stored: LimitSettings, key: LimitKey): number | null {
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

  // Never above what the ledger can count: an absurd override is the largest limit, not an error.
  const capped = (value: number) => Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
  const out: { bytes?: number; count?: number } = {};
  if (rule.bytes) {
    const base = read(env, stored, rule.bytes) ?? 0;
    out.bytes = capped((rule.scales ? Math.max(base, quota) : base) * factor);
  }
  if (rule.count) {
    const base = read(env, stored, rule.count) ?? 0;
    const scaled = rule.scales ? Math.max(base, Math.floor(quota / BYTES_PER_COUNTED_UPLOAD)) : base;
    out.count = capped(scaled * factor);
  }
  return out;
}

/**
 * The amount as two numbers. `400 validation` for a value that is not a non-negative safe
 * integer, for a dimension the kind does not have, and for an amount that names none of the
 * kind's dimensions (it would add nothing to what is limited, and pass).
 */
function validAmount(kind: CeilingKind, amount: Amount): { bytes: number; count: number } {
  const rule = RULES[kind];
  const given = (amount ?? {}) as Amount;
  let named = 0;
  for (const dimension of DIMENSIONS) {
    const value = given[dimension];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new AppError("validation", "Invalid amount.");
    if (!rule[dimension]) throw new AppError("validation", "Invalid amount.");
    named += 1;
  }
  if (named === 0) throw new AppError("validation", "Invalid amount.");
  return { bytes: given.bytes ?? 0, count: given.count ?? 0 };
}

/** Seconds until the next 00:00 UTC — the `Retry-After` of a refusal. At least 1. */
function secondsToMidnightUTC(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

function refusal(
  at: Date,
  kind: CeilingKind,
  dimension: "bytes" | "count",
  limit: number,
  used: number,
): CeilingRefusal {
  return { ok: false, kind, dimension, limit, used, retryAfterSec: secondsToMidnightUTC(at) };
}

/** One `ceiling` metric per refusal of an ENFORCING call. A preview refuses nothing and counts nothing. */
function counted<R extends { ok: boolean }>(c: Context<AppEnv>, result: R): R {
  if (!result.ok) {
    const refused = result as unknown as CeilingRefusal;
    writeMetric(c.env, "ceiling", { kind: refused.kind, outcome: "refused", reason: refused.dimension });
  }
  return result;
}

/** The new-account cap on live links, or null when it does not apply or is not reached. */
async function liveLinkCap(
  c: Context<AppEnv>,
  exec: Executor,
  stored: LimitSettings,
  subject: CeilingSubject,
  at: Date,
): Promise<{ limit: number; used: number } | null> {
  const account = requireAccount("link_user", subject.account);
  if (!isNewAccount(c.env, stored, account.createdAt, at)) return null;
  const limit = read(c.env, stored, "NEW_ACCOUNT_MAX_LINKS") ?? 0;
  const used = await countLive(exec, subject.id);
  return used >= limit ? { limit, used } : null;
}

/**
 * The decision, read through `exec` (the request's client, or a transaction that holds the lock)
 * for the instant `at`: its day is the ledger day, and its distance to midnight the `Retry-After`.
 */
async function evaluate(
  c: Context<AppEnv>,
  exec: Executor,
  kind: CeilingKind,
  subject: CeilingSubject,
  amount: Amount,
  at: Date,
): Promise<CeilingResult> {
  const rule = RULES[kind];
  const add = validAmount(kind, amount);
  const stored = await settings(c);
  const limits = effectiveLimits(c.env, stored, kind, subject.account, at);

  if (kind === "link_user") {
    const cap = await liveLinkCap(c, exec, stored, subject, at);
    if (cap) return refusal(at, kind, "count", cap.limit, cap.used);
  }

  const used = await totalsOn(exec, utcDay(at), rule.subject, subject.id);
  if (rule.open) {
    const open = await openBytes(
      exec,
      rule.open === "owner" ? { ownerId: subject.id } : { editorId: subject.id },
    );
    used.bytes += open.bytes;
    used.count += open.count;
  }
  for (const dimension of DIMENSIONS) {
    const limit = limits[dimension];
    if (limit !== undefined && used[dimension] + add[dimension] > limit) {
      return refusal(at, kind, dimension, limit, used[dimension]);
    }
  }
  return { ok: true };
}

/**
 * A READ-ONLY PREVIEW: would `amount` more of `kind` still fit today? For a route that wants to
 * say "this will not fit" before doing work. IT AUTHORISES NOTHING — another request can use the
 * room before this one acts. What admits is `consumeCeiling` / `enforceUploadCeilings`.
 * Emits no metric: it refused nothing.
 */
export async function checkCeiling<K extends CeilingKind>(
  c: Context<AppEnv>,
  kind: K,
  subject: CeilingSubject,
  amount: AmountOf<K>,
): Promise<CeilingResult> {
  return evaluate(c, db(c), kind, subject, amount, now(c));
}

/**
 * The `429 ceiling_exceeded` of a refusal: `Retry-After` to 00:00 UTC, details `{ kind, dimension }`.
 * What a caller of `tryConsumeCeiling` throws when it answered `ok: false`.
 */
export function ceilingExceeded(result: CeilingRefusal): AppError {
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
 * `amount`: the session's bytes AND `count: 1` for the file — both are required, by the type and
 * at run time (`400 validation`). (The editor's ceiling has no count.)
 * There is no single-kind call: two calls would leave the lock order to the caller.
 */
export async function enforceUploadCeilings(
  c: Context<AppEnv>,
  subjects: { owner: CeilingSubject; editor?: CeilingSubject },
  amount: UploadAmount,
  opts: { tx: Tx },
): Promise<void> {
  const tx = requireTx("upload_user", opts);
  // Both dimensions, always: an upload that names no count would pass the file-count ceiling.
  const given = (amount ?? {}) as Amount;
  if (given.bytes === undefined || given.count === undefined) {
    throw new AppError("validation", "Invalid amount.");
  }
  const at = now(c);
  const editor = subjects.editor && subjects.editor.id !== subjects.owner.id ? subjects.editor : null;
  await lockUsers(tx, editor ? [subjects.owner.id, editor.id] : [subjects.owner.id]);
  const forOwner = counted(c, await evaluate(c, tx, "upload_user", subjects.owner, amount, at));
  if (!forOwner.ok) throw ceilingExceeded(forOwner);
  if (editor) {
    const bytesOnly = { bytes: (amount ?? {}).bytes };
    const forEditor = counted(c, await evaluate(c, tx, "upload_editor", editor, bytesOnly, at));
    if (!forEditor.ok) throw ceilingExceeded(forEditor);
  }
}

/**
 * Adds to today's ledger row of the kind's subject. IT ENFORCES NOTHING: it is for usage that was
 * admitted another way (a completed upload moving from "open" into the ledger) and for
 * corrections. Never pair it with `checkCeiling` to make a limit — that is the sequence
 * concurrent requests walk through.
 */
export async function recordUsage<K extends CeilingKind>(
  c: Context<AppEnv>,
  kind: K,
  subjectId: string,
  amount: AmountOf<K>,
  opts: { tx?: Tx } = {},
): Promise<void> {
  const add = validAmount(kind, amount);
  await addUsage(opts.tx ?? db(c), utcDay(now(c)), RULES[kind].subject, subjectId, add.bytes, add.count);
}

/**
 * Check AND record in one statement, ANSWERING instead of throwing — for the one kind of caller
 * that must do something of its own on a refusal (pause a link, tell its owner once).
 *
 * `{ ok: true, day }`: CHARGED, on that UTC day. `{ ok: false, … }`: refused, nothing written.
 * THE CALLER MUST REFUSE THE REQUEST WHEN `ok` IS FALSE — `throw ceilingExceeded(result)`. A
 * caller that does not look has enforced nothing; every other caller uses `consumeCeiling`.
 */
export async function tryConsumeCeiling<K extends LedgerOnlyKind>(
  c: Context<AppEnv>,
  kind: K,
  subject: CeilingSubject,
  amount: AmountOf<K>,
): Promise<ConsumeResult>;
export async function tryConsumeCeiling(
  c: Context<AppEnv>,
  kind: "link_user",
  subject: CeilingSubject,
  amount: AmountOf<"link_user">,
  opts: { tx: Tx },
): Promise<ConsumeResult>;
export async function tryConsumeCeiling(
  c: Context<AppEnv>,
  kind: LedgerOnlyKind | "link_user",
  subject: CeilingSubject,
  amount: Amount,
  opts?: { tx: Tx },
): Promise<ConsumeResult> {
  const rule = RULES[kind];
  if (!rule || rule.open) {
    throw new Error(`ceilings: ${String(kind)} cannot be consumed: use enforceUploadCeilings`);
  }
  const at = now(c);
  const day = utcDay(at);
  const add = validAmount(kind, amount);
  const stored = await settings(c);
  const limits = effectiveLimits(c.env, stored, kind, subject.account, at);

  let exec: Executor = db(c);
  if (kind !== "link_user" && opts !== undefined) {
    throw new Error(`ceilings: ${kind} is consumed in one statement of its own, not in a transaction`);
  }
  if (kind === "link_user") {
    const tx = requireTx(kind, opts);
    await lockUsers(tx, [subject.id]);
    exec = tx;
    const cap = await liveLinkCap(c, tx, stored, subject, at);
    if (cap) return counted(c, refusal(at, kind, "count", cap.limit, cap.used));
  }
  // The zeros are passed explicitly: the ledger helper counts 1 when no count is given.
  const added = await addUsageIfUnder(
    exec,
    day,
    rule.subject,
    subject.id,
    { bytes: add.bytes, count: add.count },
    limits,
  );
  if (added) return { ok: true, day };

  // Refused by the statement. Which dimension: the first the kind is limited on that the same
  // day's total, read now, would pass — and when none would any more (it was a race), the first
  // dimension the kind HAS. Never a dimension the kind is not limited on.
  const used = await totalsOn(exec, day, rule.subject, subject.id);
  const limited = DIMENSIONS.filter((dimension) => limits[dimension] !== undefined);
  const dimension =
    limited.find((candidate) => used[candidate] + add[candidate] > (limits[candidate] as number)) ??
    limited[0]!;
  return counted(c, refusal(at, kind, dimension, limits[dimension] as number, used[dimension]));
}

/**
 * Check AND record in one statement: the amount is added only if the day's total stays within the
 * limit on every dimension, so requests that run together cannot take the counter past it.
 * THE enforcing call for the ledger-only kinds.
 *
 * IT THROWS `429 ceiling_exceeded` (`Retry-After` to 00:00 UTC, details `{ kind, dimension }`) on
 * a refusal, and nothing is written then: a refusal cannot be ignored. On success it returns the
 * receipt of the charge — the day it was booked on, which `refundUsage` needs.
 * The amount is charged up front; give back what was not sent with `refundUsage`.
 * A bytes-only consume adds a count of 0, and a count-only consume 0 bytes.
 *
 * `link_user` also has the new-account cap on LIVE links, which is a count of rows: that form
 * runs in the caller's transaction (`{ tx }`), takes the user's row lock itself, counts and adds
 * through `tx` — and the caller inserts the link in the same transaction.
 */
export async function consumeCeiling<K extends LedgerOnlyKind>(
  c: Context<AppEnv>,
  kind: K,
  subject: CeilingSubject,
  amount: AmountOf<K>,
): Promise<ConsumeReceipt>;
export async function consumeCeiling(
  c: Context<AppEnv>,
  kind: "link_user",
  subject: CeilingSubject,
  amount: AmountOf<"link_user">,
  opts: { tx: Tx },
): Promise<ConsumeReceipt>;
export async function consumeCeiling(
  c: Context<AppEnv>,
  kind: LedgerOnlyKind | "link_user",
  subject: CeilingSubject,
  amount: Amount,
  opts?: { tx: Tx },
): Promise<ConsumeReceipt> {
  const consume = tryConsumeCeiling as (
    c: Context<AppEnv>,
    kind: LedgerOnlyKind | "link_user",
    subject: CeilingSubject,
    amount: Amount,
    opts?: { tx: Tx },
  ) => Promise<ConsumeResult>;
  // The optional argument is passed on only when it was given: its presence is checked.
  const result = await (opts === undefined
    ? consume(c, kind, subject, amount)
    : consume(c, kind, subject, amount, opts));
  if (!result.ok) throw ceilingExceeded(result);
  return { day: result.day };
}

/**
 * Gives back BYTES that were charged and then not sent (a download that was aborted, a response
 * that ended early): today's ledger row of the kind's subject is reduced, never below zero.
 *
 * `receipt` is what the consume the bytes belong to returned. Only that day's row is reduced, and
 * only while that day is still today: a refund for a charge booked on an earlier UTC day is
 * DROPPED — it is never applied to the new day's row.
 *
 * It enforces nothing and cannot raise a limit. THE CALLER'S CONTRACT: `amount.bytes` is at most
 * what THIS SAME REQUEST consumed, and it is refunded once. Counts are never refunded.
 * It takes a `ServiceDeps`, not a request: the files host calls it after the response, from
 * deferred work.
 */
export async function refundUsage(
  deps: ServiceDeps,
  kind: Exclude<LedgerOnlyKind, "transform_user" | "share_user">,
  subjectId: string,
  amount: { bytes: number },
  receipt: ConsumeReceipt,
): Promise<void> {
  const rule = RULES[kind];
  if (!rule || rule.open || !rule.bytes) throw new Error(`ceilings: ${String(kind)} has no bytes to refund`);
  const bytes = amount?.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("ceilings: invalid refund");
  if (bytes === 0) return;
  await subtractUsage(deps.db, receipt.day, rule.subject, subjectId, bytes);
}
