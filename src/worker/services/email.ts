// Every email Holdfast sends: the templates, the per-recipient caps and the two transports.
//
//   await sendVerification(deps, { to, name, url });          // deps = deps(c), bg, or { db, env, defer }
//
// Later tasks call the exported `send*` functions; they do not add templates here — a missing
// template is a report item for the orchestrator.
//
// HOW A MESSAGE IS BUILT. A template is a list of plain-text blocks and link blocks. There is no
// inline HTML anywhere in a template: the HTML part is produced by escaping every block as a
// whole, so no value can become markup.
//
// WHAT A PERSON TYPED IS A LABEL, NEVER A MESSAGE. Validation at the form is somewhere else; the
// rule is applied HERE, where the value is used. Every interpolated value — a name, a file or
// folder name, an address shown in a sentence, a report category, a line of a quoted notice —
// passes through `safeLabel()`:
//   - NFKC-normalised (full-width and other compatibility forms become the plain characters);
//   - control and format characters removed (CR, LF, NUL, the bidirectional overrides and
//     isolates, zero-width spaces and joiners, the line and paragraph separators);
//   - white space collapsed;
//   - NOTHING LINK-LIKE LEFT: a `.` (or `。`) inside a run of characters becomes `·`, `@` becomes
//     ` at `, `/` and `\` become a space, and so does a `:` that something follows — so there
//     is no `://`, no `www.`, no `label.tld`, no address, nothing a mail client turns into a
//     link ("report.pdf" reads "report·pdf"; the full stop that ends a sentence stays);
//   - capped: LABEL_MAX (80) characters by default, NAME_MAX (40) for a greeting.
// The plain-text part is built from the same blocks, so the same rules hold for it.
// SUBJECTS ARE CONSTANTS: no value ever reaches a subject. EVERY LINK is one this Worker built —
// checked to start with `APP_ORIGIN` (or to be one of the fixed estate pages below) before a
// message exists; never a URL from a request's Host, Origin or Referer, or from a body field.
// MAIL A STRANGER CAN CAUSE to be sent to somebody else's address (the verification link, the
// "someone tried to sign up" notice, the reset link, the new-address link) carries NO free text
// from anyone: fixed copy and our own links, and no name.
//
// KINDS, CLASSES AND CAPS (`KINDS` below is the one table; the counters live in `email_ledger`):
//   unauth_triggered     verification, sign-up attempt, reset link — anyone can cause these.
//                        Per recipient 5 an hour (the reset link counted apart from the other
//                        two; 20 and 10 a day), AND per triggering client address 10 an hour /
//                        40 a day across all recipients: the anti-mail-bomb limit. The counts are
//                        CHARGED whether or not a mail results (`chargeUnsent`): an address with
//                        no account uses up the same budget as one with an account, so the
//                        moment a limit starts refusing says nothing about who exists.
//   session_action       address-change confirmation, new-address link, deletion confirmation —
//                        only a signed-in session causes these. Per recipient 5 an hour / 10 a
//                        day, and per acting user 10 / 40.
//   transactional_user   share invitation, quarantine, link paused, digest, … Per recipient
//                        5 an hour / 10 a day, and per sending user 30 / 200 where a user sent it.
//   (Per recipient, the four counted buckets add up to at most 50 a day.)
//   account_security     password changed, 2FA, passkey, new device, suspended, deletion
//                        scheduled / cancelled, admin alert. NEVER suppressed by any other
//                        class: its own count, 20 an hour / 100 a day per recipient; beyond
//                        that the notices of the hour are COALESCED into one digest mail
//                        ("more security activity than we mail one by one") — never dropped
//                        silently.
//   operator_alert       mail to the operator about moderation and system safety — a class and a
//                        count of ITS OWN (never the admin's `account_security` count for the
//                        same mailbox), with a SEVERITY per template:
//                          critical  a suspected-CSAM lock, a legal hold, a kill-switch change,
//                                    an admin lock-out, the storage-budget switch, the scanner
//                                    down. NEVER counted, capped, coalesced or dropped: it does
//                                    not touch the ledger at all. A transport failure is retried
//                                    in the request's deferred work and every failure is reported
//                                    and counted (`metric("email", { outcome: "critical_failed" })`
//                                    — what the T27 alarm pages on).
//                          routine   an abuse report, a quarantine. 30 an hour / 200 a day; beyond
//                                    that the alerts are held and go out as ONE specific digest an
//                                    hour: the count per kind and the report / node IDS — ids only,
//                                    never a file name, a reporter or anything typed — and the
//                                    link to /admin. A critical alert can never be folded into it
//                                    (the types say so, and `deliver` checks).
//                        Operator mail carries no free text at all: ids, counts, fixed copy.
//                        (Volume is limited where it starts — reports per reporter, address and
//                        link, and their de-duplication: T22 — not here.)
// WHOSE BUDGET (unauth_triggered). A per-recipient budget that ANYBODY can spend is a lock on
// that recipient: ten reset requests from strangers would stop a person's own reset mail for the
// day. So a mail the address ASKED FOR ITSELF — the request came with the address's own session,
// or from the browser that signed up with it (an `hf_pending` proof whose user id IS the
// unverified account at that address) — never a sign-up, whose recipient the body names — is counted
// on a budget of its own (`ownLedgerKey`: the same caps, keyed on the EXACT stored address — not
// the canonical mailbox and not the account), which nothing a stranger
// sends is counted on. `EmailActor.own` says so; it is set in ONE place (auth/hooks.ts
// `ownAddressOf`, read by auth/create-auth.ts) and only on a proof a stranger cannot get for
// somebody else's address — a cookie's mere presence is not one. A pending sign-up's change of
// address is NOT such a proof for the new address. The per-client budget applies to both alike.
// THE MAILBOX'S CEILING — for the `unauth_triggered` class ONLY (verification, sign-up notice,
// password reset: the mail an unauthenticated request can cause, and the own budgets beside
// it). Each such mail is counted on its bucket (or the address's own budget) AND on one ceiling
// per CANONICAL mailbox (`mailboxKey`, MAILBOX_CAPS: 20 an hour, 50 a day), in one transaction
// (db/queries/email-ledger.ts `tryConsumeAll`): on both or on neither. So the plus-tag /
// Gmail-dot variants of one mailbox each have their own small own-budget but cannot together
// pass the ceiling; and a stranger who fills it can stop the owner's OWN verification / reset
// mail for the window (accepted — the same residual as a signed-out owner's reset mail).
// What does NOT count toward it and cannot be blocked by it — exactly as before it existed:
// `session_action` (address change, delete confirmation: their own bucket), `transactional_user`
// (their own bucket), `account_security` (its own cap; over it a digest; fails OPEN) and
// `operator_alert` (own cap / digest; critical ones never touch the ledger).
// A recipient is counted under its CANONICAL address (`canonicalRecipient`): lower case, NFKC,
// plus-tag removed, and for Gmail the dots removed — spellings of one mailbox share one budget.
// Over a cap the send is skipped and counted (`metric("email", { outcome: "capped" })`); the
// caller gets "capped", never an error — nothing here tells a caller whether an address exists.
// IF THE LEDGER CANNOT BE REACHED: every class but one fails CLOSED (nothing is sent);
// `account_security` fails OPEN (the notice is sent and the failure reported) — an alert must
// not depend on a counter.
//
// TRANSPORT. `EMAIL_TRANSPORT=memory` pushes to the in-memory outbox (services/outbox.ts; tests
// read it at /api/_test/outbox). Anything else sends through Resend with `RESEND_API_KEY`; a
// failed send is reported and retried once under the same idempotency key. An attempt that gets
// no answer in RESEND_TIMEOUT_MS is aborted and is a failed attempt like any other.
//
// No `send*` function throws.

import { Resend } from "resend";
import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../shared/constants";
import {
  heldAlertMailboxes,
  holdAlert,
  refund,
  takeHeldAlerts,
  tryConsume,
  tryConsumeAll,
} from "../db/queries/email-ledger";
import { BUSINESS_TIME_ZONE } from "./business-days";
import { isTestMode } from "./clock";
import { countFor, reportError } from "../auth/observe";
import { normalise as normaliseIp } from "./ip-hash";
import { createKeys, hmacHex } from "./keys";
import * as outbox from "./outbox";
import type { ServiceDeps } from "./request-context";

/** The verified sending domain. */
export const SENDER = "Holdfast <no-reply@holdfast.ponderance.dev>";
// A3: the mailbox domain is an open Gate-A question; until it is answered this is the support
// address on the app's own domain.
export const SUPPORT_EMAIL = "support@holdfast.ponderance.dev";

/** Fixed pages on the estate site. The only links in a message that are not under APP_ORIGIN. */
export const ESTATE_LINKS = {
  terms: "https://ponderance.dev/terms",
  privacy: "https://ponderance.dev/privacy",
  help: "https://ponderance.dev/support/holdfast",
} as const;

type Caps = { perHour: number; perDay: number };
/**
 * Per recipient: 5 an hour in each bucket — and 50 a DAY IN ALL, split between the buckets so
 * that no bucket can use up another's day (signup 20, reset 10, session 10, product 10).
 */
export const EMAIL_CAPS = { perHour: 5, perDay: 50 } as const;
/**
 * Per MAILBOX (canonical), over the `unauth_triggered` class — the file's existing totals. The
 * buckets alone no longer bound that class: an address's own budget is per exact address, so
 * the variants of one mailbox each have one.
 */
export const MAILBOX_CAPS = { perHour: 20, perDay: 50 } as const;
export const BUCKET_CAPS = {
  signup: { perHour: EMAIL_CAPS.perHour, perDay: 20 },
  reset: { perHour: EMAIL_CAPS.perHour, perDay: 10 },
  session: { perHour: EMAIL_CAPS.perHour, perDay: 10 },
  product: { perHour: EMAIL_CAPS.perHour, perDay: 10 },
} as const;
/** Per triggering client address (unauth_triggered) and per acting user (session_action). */
export const ACTOR_CAPS = { perHour: 10, perDay: 40 } as const;
/** Per sending user (transactional_user). */
export const SENDER_CAPS = { perHour: 30, perDay: 200 } as const;
/** Per recipient, security notices one by one; beyond it they are coalesced. */
export const SECURITY_CAPS = { perHour: 20, perDay: 100 } as const;
/** Per operator mailbox, routine alerts one by one; beyond it they are held for the digest. */
export const OPERATOR_CAPS = { perHour: 30, perDay: 200 } as const;
/** How often a failed CRITICAL alert is tried again in the deferred work, and the waits between. */
export const CRITICAL_RETRY_WAITS_MS = [2_000, 6_000] as const;
/** The coalesced notice itself: one an hour. */
export const DIGEST_CAPS = { perHour: 1, perDay: 24 } as const;

export type EmailClass =
  "unauth_triggered" | "session_action" | "transactional_user" | "account_security" | "operator_alert";
export type EmailSeverity = "critical" | "routine";
/** `retrying`: a critical alert whose first send failed and is being tried again (deferred). */
export type EmailOutcome = "sent" | "capped" | "coalesced" | "retrying" | "failed";

/**
 * Who caused a mail: the client address of an unauthenticated request, the user of a session, or
 * the system itself (a job, a moderation action). `client: null` = an address was not known —
 * counted under one shared key, so it is the tightest case, not a free one.
 */
export type EmailActor =
  | {
      client: string | null;
      /**
       * The recipient asked for this mail itself (see "WHOSE BUDGET" in the header): the id of
       * the account the recipient address is bound to.
       */
      own?: string | null;
    }
  | { user: string }
  | { system: true };

type Block = { text: string } | { link: { label: string; url: string } } | { quote: string };
type Draft = { subject: string; heading: string; blocks: Block[] };
export type RenderedEmail = { subject: string; text: string; html: string };

// ── sanitising ──────────────────────────────────────────────────────────────────────────────

export const LABEL_MAX = 80;

/** The character-level part of `safeLabel`, for one line. */
function neutralise(text: string): string {
  return (
    text
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
      // A dot or a colon INSIDE a run of characters (`evil.example`, `www.x`, `https:`, `mailto:x`);
      // one that ends a sentence — followed by a space or by nothing — stays.
      .replace(/[.\u3002](?=[^\s.\u3002])/gu, "·")
      .replace(/:(?=\S)/g, " ")
      .replace(/@/g, " at ")
      .replace(/[/\\]/g, " ")
  );
}

/**
 * A value a person typed, as a LABEL that is safe to place in a message (see the header):
 * normalised, without control or format characters, with nothing link-like left, white space
 * collapsed, at most `max` characters. NOT HTML-escaped — the renderer does that.
 */
export function safeLabel(value: unknown, max = LABEL_MAX): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  // (A cap before the work, too: nobody normalises a megabyte for a label.)
  // (cut on a code-point boundary: half a surrogate pair is not a character)
  const stripped = neutralise(
    Array.from(text.slice(0, max * 16))
      .slice(0, max * 8)
      .join("")
      // (a lone surrogate is not a character either)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(stripped);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : stripped;
}

/** How many item names one mail lists before "and N more". */
const ITEMS_NAMED = 10;

/**
 * The items a mail is about, each a quoted `safeLabel`: “A”, “B” and “C” — at most `ITEMS_NAMED`,
 * then "and N more". `itemNames` when given (a notice over several items), else `itemName`.
 */
function itemsText(d: { itemName: unknown; itemNames?: unknown[] }): string {
  const names = d.itemNames && d.itemNames.length > 0 ? d.itemNames : [d.itemName];
  const shown = names.slice(0, ITEMS_NAMED).map((name) => `“${safeLabel(name)}”`);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)!}`;
}

/** As `safeLabel`, for a longer passage whose line breaks matter (a notice quoted in full). */
function safeQuote(value: unknown, max = 8000): string {
  const text = typeof value === "string" ? value : "";
  const lines = text
    .slice(0, max * 4)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      neutralise(line)
        .replace(/[^\S\n]+/g, " ")
        .trimEnd(),
    );
  const joined = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A name is something a person TYPED — at sign-up, before any address was proved theirs — and
// the greeting is the first line of a mail from our own sender. So beyond `safeLabel` a name is
// greeted only when it reads as one: letters, spaces, apostrophes and hyphens, at most NAME_MAX
// characters. No digit and no punctuation: no room for a sentence ("your account is locked,
// visit …"). Anything else: "Hello,".
const NAME_MAX = 40;
const READS_AS_A_NAME = /^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u;
export const greeting = (name: unknown) => {
  const who = safeLabel(name, 200);
  return Array.from(who).length <= NAME_MAX && READS_AS_A_NAME.test(who) ? `Hello ${who},` : "Hello,";
};
/**
 * For mail a stranger can cause to be sent to somebody else's address, and mail to an address
 * nobody has proved theirs: no name, nothing anyone typed.
 */
const GREETING_UNPROVEN = "Hello,";

/** A link a message may carry: under APP_ORIGIN, or one of the fixed estate pages. */
function assertLink(env: Pick<Env, "APP_ORIGIN">, url: string): string {
  const origin = env.APP_ORIGIN;
  const fixed = (Object.values(ESTATE_LINKS) as string[]).includes(url);
  if (!fixed && !(typeof url === "string" && origin && url.startsWith(`${origin}/`))) {
    throw new Error("email: a link outside APP_ORIGIN was refused");
  }
  // No white space or control characters: the URL goes into an href and into plain text.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\s\u0000-\u001f\u007f<>"']/.test(url)) throw new Error("email: a malformed link was refused");
  return url;
}

// The DMCA window is counted in New York business days (./business-days): its dates are written
// as New York dates with the zone named. A UTC clock time ("28 November, 04:59 UTC") reads a day late.
const EASTERN_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
});
const EASTERN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** "20 November 2028, 08:00 US Eastern time" — the start of the window. */
const easternInstant = (at: Date) => `${EASTERN_DATE.format(at)}, ${EASTERN_TIME.format(at)} US Eastern time`;
/** "27 November 2028 (end of day, US Eastern time)" — the window's last day, all of it. */
const easternEndOfDay = (at: Date) => `${EASTERN_DATE.format(at)} (end of day, US Eastern time)`;

function formatInstant(at: Date): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September"];
  months.push("October", "November", "December");
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────

const FOOTER = `Holdfast · ${SUPPORT_EMAIL}`;

export function render(env: Pick<Env, "APP_ORIGIN" | "SENTRY_ENVIRONMENT">, draft: Draft): RenderedEmail {
  // A subject is a constant of this file; this is the belt to that brace.
  const subjectText = draft.subject.replace(/[\r\n]+/g, " ");
  const subject = env.SENTRY_ENVIRONMENT === "production" ? subjectText : `[dev] ${subjectText}`;

  const textParts: string[] = [draft.heading];
  const htmlParts: string[] = [
    `<h1 style="font-size:20px;line-height:28px;margin:0 0 16px;font-weight:600">${escapeHtml(draft.heading)}</h1>`,
  ];
  for (const block of draft.blocks) {
    if ("text" in block) {
      textParts.push(block.text);
      htmlParts.push(`<p style="margin:0 0 16px">${escapeHtml(block.text)}</p>`);
    } else if ("quote" in block) {
      textParts.push(
        block.quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      htmlParts.push(
        `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #C3C9D2;white-space:pre-wrap">${escapeHtml(block.quote)}</blockquote>`,
      );
    } else {
      const url = assertLink(env, block.link.url);
      textParts.push(`${block.link.label}:\n${url}`);
      htmlParts.push(
        `<p style="margin:0 0 16px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#16181D;color:#FFFFFF;text-decoration:none;border-radius:6px">${escapeHtml(block.link.label)}</a></p>` +
          `<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:#5B6370;word-break:break-all">${escapeHtml(url)}</p>`,
      );
    }
  }
  textParts.push(`--\n${FOOTER}`);
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#F7F8FA;color:#16181D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:22px">` +
    `<div style="max-width:520px;margin:0 auto;padding:24px;background:#FFFFFF;border:1px solid #E3E6EB;border-radius:8px">${htmlParts.join("")}</div>` +
    `<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:18px;color:#5B6370">${escapeHtml(FOOTER)}</p>` +
    `</body></html>`;
  return { subject, text: textParts.join("\n\n"), html };
}

// ── operator alerts: fixed copy and ids ─────────────────────────────────────────────────────

export type OperatorRoutineKind = "report" | "quarantine" | "images_budget" | "kept_backstop";
const OPERATOR_ROUTINE: Record<OperatorRoutineKind, string> = {
  report: "New abuse report",
  quarantine: "A file was quarantined",
  images_budget: "The image-transform budget for today is nearly used up",
  kept_backstop: "An account reached the limit on deleted files that are still kept",
};
const OPERATOR_CRITICAL = {
  csam_lock: "Content was locked as suspected CSAM and needs review now",
  legal_hold: "A legal hold was placed or changed",
  kill_switch: "A kill switch was changed",
  admin_lockout: "An administrator account is locked out",
  storage_budget: "The storage budget switch was triggered",
  scanner_down: "The virus scanner is not answering",
  database_rollback: "The database is older than the object store: orphan deletion is stopped",
  detector_unreadable:
    "The rollback detector cannot read the object store or the database: every destructive job is stopped",
  backup_missing:
    "Last night's database backup did not complete: there is no complete backup set for that day",
  unknown: "A critical event needs attention",
} as const;
export type OperatorCriticalEvent = Exclude<keyof typeof OPERATOR_CRITICAL, "unknown">;

/** An id as an id: URL-safe characters only, at most 64 — anything else is "unknown". */
export function safeId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "unknown";
}
/** A report category: a short lower-case word from the report form's list, or "other". */
function safeCategory(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value.replace(/_/g, " ") : "other";
}

// ── templates ───────────────────────────────────────────────────────────────────────────────

const IGNORE = "If this wasn't you, you can ignore this email.";
const NOT_YOU = `If this wasn't you, change your password now and contact ${SUPPORT_EMAIL}.`;

/** Every template, as a function from its data to a draft. Exported for the render tests. */
export const templates = {
  // `name` is accepted and NOT used: whoever signed up chose it, and this mail goes to an address
  // that may be somebody else's.
  verification: (d: { name?: unknown; url: string; resend?: boolean }): Draft => ({
    subject: "Confirm your email address",
    heading: "Confirm your email address",
    blocks: [
      { text: GREETING_UNPROVEN },
      {
        text: d.resend
          ? "Here is a new link to confirm your email address for Holdfast. Earlier links still work until they expire."
          : "Confirm this email address to finish creating your Holdfast account.",
      },
      { link: { label: "Confirm email address", url: d.url } },
      { text: `The link works for one hour. ${IGNORE}` },
    ],
  }),
  signupAttempt: (d: { name?: unknown; loginUrl: string }): Draft => ({
    subject: "Someone tried to sign up with your email address",
    heading: "You already have a Holdfast account",
    blocks: [
      { text: GREETING_UNPROVEN },
      {
        text: "Someone tried to create a Holdfast account with this email address. It already has an account, so nothing was created and nothing about your account has changed.",
      },
      {
        text: "If that was you, sign in instead. If you have forgotten your password, the sign-in page can send you a link to choose a new one.",
      },
      { link: { label: "Sign in", url: d.loginUrl } },
      { text: "If it wasn't you, there is nothing you need to do." },
    ],
  }),
  newAddressVerification: (d: { name?: unknown; url: string }): Draft => ({
    subject: "Confirm your new email address",
    heading: "Confirm your new email address",
    blocks: [
      // To the NEW address — not yet proved to belong to the account's owner: no name.
      { text: GREETING_UNPROVEN },
      { text: "Confirm this address to make it the email address of your Holdfast account." },
      { link: { label: "Confirm new address", url: d.url } },
      { text: `The link works for one hour. ${IGNORE}` },
    ],
  }),
  passwordReset: (d: { name?: unknown; url: string }): Draft => ({
    subject: "Reset your password",
    heading: "Reset your password",
    blocks: [
      { text: GREETING_UNPROVEN },
      { text: "Someone asked to reset the password of your Holdfast account." },
      { link: { label: "Choose a new password", url: d.url } },
      { text: `The link works for one hour and only once. ${IGNORE} Your password stays as it is.` },
    ],
  }),
  changeEmailConfirmation: (d: { name?: unknown; newEmail: unknown; url: string }): Draft => ({
    subject: "Confirm the change of your email address",
    heading: "Confirm the change of your email address",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `Someone asked to change the email address of your Holdfast account to ${safeLabel(d.newEmail, 254)}.`,
      },
      { link: { label: "Confirm the change", url: d.url } },
      { text: `We will then send a second link to the new address. ${NOT_YOU}` },
    ],
  }),
  deleteAccountVerification: (d: { name?: unknown; url: string }): Draft => ({
    subject: "Confirm that you want to delete your account",
    heading: "Confirm account deletion",
    blocks: [
      { text: greeting(d.name) },
      {
        text: "You asked to delete your Holdfast account. Following this link schedules the deletion for seven days from now; until then you can cancel it after signing in.",
      },
      { link: { label: "Schedule deletion", url: d.url } },
      {
        text: `Open this link in the browser where you are signed in to Holdfast. It works once, for 24 hours. ${NOT_YOU}`,
      },
    ],
  }),
  deletionScheduled: (d: { name?: unknown; scheduledFor: Date; accountUrl: string }): Draft => ({
    subject: "Your account is scheduled for deletion",
    heading: "Your account is scheduled for deletion",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `Your Holdfast account and everything in it will be deleted on ${formatInstant(d.scheduledFor)}. Your public links are paused and your shares have stopped until then.`,
      },
      {
        text: "You can keep signing in and download your files during these seven days. To keep the account, sign in and choose Cancel deletion.",
      },
      { link: { label: "Open your account", url: d.accountUrl } },
      { text: NOT_YOU },
    ],
  }),
  deletionCancelled: (d: { name?: unknown; accountUrl: string }): Draft => ({
    subject: "Account deletion cancelled",
    heading: "Deletion cancelled",
    blocks: [
      { text: greeting(d.name) },
      { text: "The deletion of your Holdfast account has been cancelled. Nothing was deleted." },
      { link: { label: "Open your account", url: d.accountUrl } },
      { text: NOT_YOU },
    ],
  }),
  passwordChanged: (d: { name?: unknown }): Draft => ({
    subject: "Your password was changed",
    heading: "Your password was changed",
    blocks: [
      { text: greeting(d.name) },
      { text: "The password of your Holdfast account was just changed." },
      { text: `If this wasn't you, reset your password now and contact ${SUPPORT_EMAIL}.` },
    ],
  }),
  twoFactorEnabled: (d: { name?: unknown }): Draft => ({
    subject: "Two-factor authentication is on",
    heading: "Two-factor authentication is on",
    blocks: [
      { text: greeting(d.name) },
      {
        text: "Signing in to your Holdfast account with a password now also needs a code from your authenticator app. Keep your backup codes somewhere safe.",
      },
      { text: NOT_YOU },
    ],
  }),
  secondFactorLocked: (d: { name?: unknown; minutes: number }): Draft => ({
    subject: "Too many wrong two-factor codes",
    heading: "Too many wrong two-factor codes",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `Someone who was already past your password, or already signed in to your Holdfast account, entered several wrong two-factor codes. For up to ${d.minutes} minutes, codes are not accepted from the browser they were entered in, nor from browsers that have not signed in to your account with a code before; your other browsers still work.`,
      },
      { text: NOT_YOU },
    ],
  }),
  twoFactorDisabled: (d: { name?: unknown }): Draft => ({
    subject: "Two-factor authentication is off",
    heading: "Two-factor authentication is off",
    blocks: [
      { text: greeting(d.name) },
      { text: "Two-factor authentication was switched off for your Holdfast account." },
      { text: NOT_YOU },
    ],
  }),
  signInMethodAdded: (d: { name?: unknown; method?: unknown }): Draft => ({
    subject: "A new way to sign in was added to your account",
    heading: "A new way to sign in was added",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `${d.method === "google" ? "Google sign-in" : "A new sign-in method"} was connected to your Holdfast account. It can now be used to sign in.`,
      },
      {
        text: `If this wasn't you, change your password and contact ${SUPPORT_EMAIL}.`,
      },
    ],
  }),
  passkeyAdded: (d: { name?: unknown }): Draft => ({
    subject: "A passkey was added to your account",
    heading: "A passkey was added",
    blocks: [
      { text: greeting(d.name) },
      { text: "A passkey was added to your Holdfast account. It can be used to sign in without a password." },
      {
        text: `If this wasn't you, remove the passkey in your account settings, change your password and contact ${SUPPORT_EMAIL}.`,
      },
    ],
  }),
  passkeyRemoved: (d: { name?: unknown }): Draft => ({
    subject: "A passkey was removed from your account",
    heading: "A passkey was removed",
    blocks: [
      { text: greeting(d.name) },
      { text: "A passkey was removed from your Holdfast account." },
      { text: NOT_YOU },
    ],
  }),
  newDeviceSignIn: (d: { name?: unknown; country?: unknown; uaFamily?: unknown; at: Date }): Draft => ({
    subject: "New sign-in to your account",
    heading: "New sign-in to your account",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `Your Holdfast account was signed in to from a browser or place we have not seen in the last 30 days: ${safeLabel(d.uaFamily, 80) || "an unknown browser"}, ${safeLabel(d.country, 8) || "unknown country"}, ${formatInstant(d.at)}.`,
      },
      { text: NOT_YOU },
    ],
  }),
  accountSuspended: (d: { name?: unknown }): Draft => ({
    subject: "Your account has been suspended",
    heading: "Your account has been suspended",
    blocks: [
      { text: greeting(d.name) },
      {
        text: "Your Holdfast account has been suspended. You have been signed out, and your public links are paused.",
      },
      { text: `If you think this is a mistake, reply to ${SUPPORT_EMAIL}.` },
    ],
  }),
  shareInvitation: (d: {
    sharerName: unknown;
    itemName: unknown;
    role: "viewer" | "editor";
    /** False: the address has no account yet — the share waits for a sign-up with it. */
    hasAccount: boolean;
    url: string;
  }): Draft => ({
    subject: "Something was shared with you on Holdfast",
    heading: "Shared with you",
    blocks: [
      {
        text: `${safeLabel(d.sharerName, 80) || "Someone"} shared “${safeLabel(d.itemName)}” with you on Holdfast. You can ${d.role === "editor" ? "view and add to" : "view"} it.`,
      },
      d.hasAccount
        ? { link: { label: "Open shared files", url: d.url } }
        : { link: { label: "Create an account to open it", url: d.url } },
      {
        text: d.hasAccount
          ? "You are getting this because the share was made to this email address."
          : "The share is waiting for an account with this email address. If you don't want one, you can ignore this email.",
      },
    ],
  }),
  quarantineNotice: (d: { name?: unknown; fileName: unknown }): Draft => ({
    subject: "A file you uploaded was blocked",
    heading: "A file was blocked",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `The virus scan flagged “${safeLabel(d.fileName)}”. The file is blocked: it cannot be downloaded, previewed or shared.`,
      },
      {
        text: "You can delete it from your files. Repeated uploads of malicious files can suspend an account.",
      },
    ],
  }),
  uploadNotIntact: (d: { name?: unknown; fileName: unknown }): Draft => ({
    subject: "An upload did not arrive intact",
    heading: "An upload did not arrive intact",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `“${safeLabel(d.fileName)}” does not match what your browser sent, so it has been blocked. This usually means the upload was interrupted.`,
      },
      { text: "Please delete it and upload the file again." },
    ],
  }),
  linkPaused: (d: { name?: unknown; itemName: unknown }): Draft => ({
    subject: "A public link was paused",
    heading: "A public link was paused",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `The public link to “${safeLabel(d.itemName)}” reached today's traffic limit and is paused. It becomes available again at midnight UTC.`,
      },
    ],
  }),
  // Not a pause: the owner's daily transfer cap over all their links. Nothing is paused and nothing
  // has to be resumed — the day rolling over ends it — so this must never say "paused".
  linkCapReached: (d: { name?: unknown }): Draft => ({
    subject: "Your public links reached today's transfer limit",
    heading: "Your public links reached today's transfer limit",
    blocks: [
      { text: greeting(d.name) },
      {
        text: "Downloads through your public links reached today's transfer limit, so the links are unavailable until midnight UTC. They come back on their own; there is nothing you need to do.",
      },
      { text: "Your own downloads are not affected." },
    ],
  }),
  // One link's own daily limit. Like the owner cap it pauses nothing: requests are refused while
  // the day's ledger is full and served again when it has room (a refund, or the day rolling
  // over), so this says "limit", never "paused".
  linkLimitReached: (d: { name?: unknown; itemName: unknown }): Draft => ({
    subject: "A public link reached today's transfer limit",
    heading: "A public link reached today's transfer limit",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `The public link to “${safeLabel(d.itemName)}” reached today's transfer limit, so downloads through it are unavailable for now. It comes back on its own, at the latest at midnight UTC; there is nothing you need to do.`,
      },
    ],
  }),
  linkAvailableAgain: (d: { name?: unknown; itemName: unknown }): Draft => ({
    subject: "A public link is available again",
    heading: "A public link is available again",
    blocks: [
      { text: greeting(d.name) },
      { text: `The public link to “${safeLabel(d.itemName)}” is available again.` },
    ],
  }),
  adminDigest: (d: { lines: Array<{ label: unknown; value: unknown }>; adminUrl: string }): Draft => ({
    subject: "Holdfast admin digest",
    heading: "Admin digest",
    blocks: [
      ...d.lines
        .slice(0, 40)
        .map((line) => ({ text: `${safeLabel(line.label, 80)}: ${safeLabel(line.value, 80)}` })),
      { link: { label: "Open the admin console", url: d.adminUrl } },
    ],
  }),
  /**
   * ROUTINE operator alert: one report or one quarantined file. An id and a category from a fixed
   * list — never a file name, never anything a reporter or an owner typed.
   */
  adminAlert: (d: {
    kind: OperatorRoutineKind;
    id: unknown;
    category?: unknown;
    adminUrl: string;
  }): Draft => ({
    subject: "Holdfast: an item for review",
    heading: OPERATOR_ROUTINE[d.kind] ?? OPERATOR_ROUTINE.report,
    blocks: [
      {
        text: `${d.kind === "quarantine" ? "Node" : "Report"} ${safeId(d.id)}${d.category === undefined ? "" : ` · category ${safeCategory(d.category)}`}.`,
      },
      { link: { label: "Open the admin console", url: d.adminUrl } },
    ],
  }),
  /**
   * CRITICAL operator alert. Fixed copy per event and at most an id. Sent at once, every time:
   * never counted, never coalesced (see the header).
   */
  operatorCritical: (d: { event: OperatorCriticalEvent; id?: unknown; adminUrl: string }): Draft => ({
    subject: "Holdfast: CRITICAL — action needed",
    heading: OPERATOR_CRITICAL[d.event] ?? OPERATOR_CRITICAL.unknown,
    blocks: [
      { text: `${OPERATOR_CRITICAL[d.event] ?? OPERATOR_CRITICAL.unknown}.` },
      ...(d.id === undefined ? [] : [{ text: `Reference ${safeId(d.id)}.` }]),
      { link: { label: "Open the admin console", url: d.adminUrl } },
    ],
  }),
  /** The routine alerts that were held back, all of them: a count per kind and the ids. */
  operatorDigest: (d: { items: Array<{ kind: unknown; id: unknown }>; adminUrl: string }): Draft => {
    const byKind = new Map<OperatorRoutineKind, string[]>();
    for (const item of d.items) {
      const kind: OperatorRoutineKind = item.kind === "quarantine" ? "quarantine" : "report";
      byKind.set(kind, [...(byKind.get(kind) ?? []), safeId(item.id)]);
    }
    return {
      subject: "Holdfast: items for review (digest)",
      heading: "Items waiting for review",
      blocks: [
        {
          text: `${d.items.length} alert${d.items.length === 1 ? "" : "s"} arrived faster than they are mailed one by one. None of them was dropped: every one is listed here.`,
        },
        ...[...byKind].map(([kind, ids]) => ({
          text: `${OPERATOR_ROUTINE[kind]} — ${ids.length}: ${ids.join(", ")}`,
        })),
        { link: { label: "Open the admin console", url: d.adminUrl } },
      ],
    };
  },
  /** To a reporter who left an address. Says only that the report was reviewed. */
  reportReviewed: (): Draft => ({
    subject: "Your report was reviewed",
    heading: "Your report was reviewed",
    blocks: [
      { text: "Thank you for your report to Holdfast. It has been reviewed." },
      { text: "We cannot share what action, if any, was taken." },
    ],
  }),
  /**
   * A copyright takedown. To the SUBSCRIBER — the person who uploaded the material (§512(g)(2)(A))
   * — the notice's description, the counter-notice path and, when one was issued, the strike. To a
   * FOLDER OWNER who did not upload it (`folderOwner`), only that a file in their folder was
   * removed and that its uploader was told (R1 ruling Q2).
   */
  contentRemovedCopyright: (d: {
    name?: unknown;
    itemName: unknown;
    /** Every item the mail is about, when more than one (R2 mod-6); `itemName` is then the first. */
    itemNames?: unknown[];
    noticeText: unknown;
    counterNoticeUrl: string;
    strike?: boolean;
    folderOwner?: boolean;
  }): Draft =>
    d.folderOwner === true
      ? {
          subject: "A file in your folder was removed following a copyright notice",
          heading: "A file in your folder was removed",
          blocks: [
            { text: greeting(d.name) },
            {
              text: `We received a copyright notice about ${itemsText(d)}, which someone you share a folder with uploaded, and have removed access to it. The notice's description of the material is quoted below.`,
            },
            { quote: safeQuote(d.noticeText) },
            { text: "We have told the person who uploaded it. They can respond with a counter-notice." },
          ],
        }
      : {
          subject: "Content removed following a copyright notice",
          heading: "Content removed following a copyright notice",
          blocks: [
            { text: greeting(d.name) },
            {
              text: `We received a copyright notice about ${itemsText(d)} and have removed access to it. The notice's description of the material is quoted below.`,
            },
            { quote: safeQuote(d.noticeText) },
            ...(d.strike === true
              ? [
                  {
                    text: `This counts as one copyright strike on your account. ${STRIKES_TO_SUSPEND} strikes within ${STRIKE_WINDOW_DAYS} days suspend an account. A strike is lifted if the content is restored after a counter-notice.`,
                  },
                ]
              : []),
            {
              text: "If you believe the content was removed by mistake or misidentification, you can send a counter-notice. It must identify the content, state under penalty of perjury that you believe in good faith it was removed by mistake, give your name, address and telephone number, consent to the jurisdiction of the federal court for your address, and be signed.",
            },
            { link: { label: "How to send a counter-notice", url: d.counterNoticeUrl } },
          ],
        },
  contentRestored: (d: { name?: unknown; itemName: unknown; itemNames?: unknown[] }): Draft => ({
    subject: "Your content has been restored",
    heading: "Content restored",
    blocks: [{ text: greeting(d.name) }, { text: `Access to ${itemsText(d)} has been restored.` }],
  }),
  /**
   * To the complainant of a copyright notice, §512(g)(2)(B): a copy of the counter-notice and the
   * window in which the material will be restored. Every field of the counter-notice is quoted
   * (`safeQuote`: an address in it reads "x at y·z" — nothing in it can become a link); the
   * owner's file name is not given (only the notice's own reference).
   */
  dmcaCounterForwarded: (d: {
    name?: unknown;
    noticeId: unknown;
    counter: {
      name: unknown;
      address: unknown;
      phone: unknown;
      email: unknown;
      statement: unknown;
      consentJurisdiction: boolean;
      signature: unknown;
    };
    notBefore: Date;
    notAfter: Date;
    dmcaUrl: string;
  }): Draft => ({
    subject: "A counter-notice was received about your copyright notice",
    heading: "Counter-notice received",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `Your copyright notice (reference ${safeId(d.noticeId)}) led us to remove access to the material it named. The person who made it available has sent the counter-notice copied below.`,
      },
      {
        quote: [
          `Name: ${safeQuote(d.counter.name, 500)}`,
          `Address: ${safeQuote(d.counter.address, 2000)}`,
          `Phone: ${safeQuote(d.counter.phone, 100) || "—"}`,
          `Email: ${safeQuote(d.counter.email, 320)}`,
          `Statement: ${safeQuote(d.counter.statement)}`,
          `Consents to the jurisdiction of the federal court: ${d.counter.consentJurisdiction ? "yes" : "no"}`,
          `Signature: ${safeQuote(d.counter.signature, 500)}`,
        ].join("\n"),
      },
      {
        text: `Under 17 U.S.C. §512(g), we will restore access to the material no sooner than ${easternInstant(d.notBefore)} and no later than ${easternEndOfDay(d.notAfter)}, unless our designated agent first receives notice from you that you have filed an action seeking a court order to restrain this person from engaging in infringing activity relating to the material.`,
      },
      { link: { label: "Our designated agent's contact details", url: d.dmcaUrl } },
    ],
  }),
  /** To the complainant: the material their notice named was restored after the counter-notice. */
  dmcaRestoredComplainant: (d: { name?: unknown; noticeId: unknown }): Draft => ({
    subject: "Material restored following a counter-notice",
    heading: "Material restored",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `Access to the material named in your copyright notice (reference ${safeId(d.noticeId)}) has been restored, as 17 U.S.C. §512(g) provides: the counter-notice we sent you was not followed by notice of a court action within the period it gave.`,
      },
    ],
  }),
  /** Sent INSTEAD of further single notices once an hour's worth has gone out (see the header). */
  securityDigest: (d: { name?: unknown; accountUrl: string }): Draft => ({
    subject: "More security activity on your account",
    heading: "More security activity on your account",
    blocks: [
      { text: greeting(d.name) },
      {
        text: "There has been more security activity on your Holdfast account in the last hour than we send separate emails for. This one message stands for the rest of this hour's notices.",
      },
      { link: { label: "Review your account", url: d.accountUrl } },
      { text: NOT_YOU },
    ],
  }),
} as const;

export type TemplateName = keyof typeof templates;

/** Only an operator alert can be critical; every row states both its class and its severity. */
type KindRow =
  | { class: Exclude<EmailClass, "operator_alert">; severity: "routine"; bucket: string }
  | { class: "operator_alert"; severity: EmailSeverity; bucket: string };

/**
 * EVERY kind of mail: its class, its severity, and the per-recipient count it belongs to. The
 * type makes the table exhaustive — a template without a row, or a row without a class or a
 * severity, does not compile — and at run time a kind with no row is never sent (`deliver`).
 * `bucket` separates per-recipient counts INSIDE a class (the reset link from the sign-up mail:
 * five sign-up attempts on somebody's address must not stop that person's own reset).
 */
export const KINDS = {
  verification: { class: "unauth_triggered", severity: "routine", bucket: "signup" },
  signupAttempt: { class: "unauth_triggered", severity: "routine", bucket: "signup" },
  passwordReset: { class: "unauth_triggered", severity: "routine", bucket: "reset" },
  newAddressVerification: { class: "session_action", severity: "routine", bucket: "session" },
  changeEmailConfirmation: { class: "session_action", severity: "routine", bucket: "session" },
  deleteAccountVerification: { class: "session_action", severity: "routine", bucket: "session" },
  deletionScheduled: { class: "account_security", severity: "routine", bucket: "security" },
  deletionCancelled: { class: "account_security", severity: "routine", bucket: "security" },
  passwordChanged: { class: "account_security", severity: "routine", bucket: "security" },
  twoFactorEnabled: { class: "account_security", severity: "routine", bucket: "security" },
  twoFactorDisabled: { class: "account_security", severity: "routine", bucket: "security" },
  secondFactorLocked: { class: "account_security", severity: "routine", bucket: "security" },
  passkeyAdded: { class: "account_security", severity: "routine", bucket: "security" },
  signInMethodAdded: { class: "account_security", severity: "routine", bucket: "security" },
  passkeyRemoved: { class: "account_security", severity: "routine", bucket: "security" },
  newDeviceSignIn: { class: "account_security", severity: "routine", bucket: "security" },
  accountSuspended: { class: "account_security", severity: "routine", bucket: "security" },
  securityDigest: { class: "account_security", severity: "routine", bucket: "digest" },
  adminAlert: { class: "operator_alert", severity: "routine", bucket: "operator" },
  operatorDigest: { class: "operator_alert", severity: "routine", bucket: "operator-digest" },
  shareInvitation: { class: "transactional_user", severity: "routine", bucket: "product" },
  quarantineNotice: { class: "transactional_user", severity: "routine", bucket: "product" },
  uploadNotIntact: { class: "transactional_user", severity: "routine", bucket: "product" },
  linkPaused: { class: "transactional_user", severity: "routine", bucket: "product" },
  linkCapReached: { class: "transactional_user", severity: "routine", bucket: "product" },
  linkLimitReached: { class: "transactional_user", severity: "routine", bucket: "product" },
  linkAvailableAgain: { class: "transactional_user", severity: "routine", bucket: "product" },
  adminDigest: { class: "transactional_user", severity: "routine", bucket: "product" },
  reportReviewed: { class: "transactional_user", severity: "routine", bucket: "product" },
  contentRemovedCopyright: { class: "transactional_user", severity: "routine", bucket: "product" },
  contentRestored: { class: "transactional_user", severity: "routine", bucket: "product" },
  dmcaCounterForwarded: { class: "transactional_user", severity: "routine", bucket: "product" },
  dmcaRestoredComplainant: { class: "transactional_user", severity: "routine", bucket: "product" },
  operatorCritical: { class: "operator_alert", severity: "critical", bucket: "operator-critical" },
} as const satisfies Record<TemplateName, KindRow>;

type CriticalName = {
  [K in TemplateName]: (typeof KINDS)[K]["severity"] extends "critical" ? K : never;
}[TemplateName];
/** The kinds that MAY be held back and coalesced: every kind that is not critical. */
export type CoalescibleName = Exclude<TemplateName, CriticalName>;
const kindOf = (name: TemplateName): KindRow | undefined =>
  Object.hasOwn(KINDS, name) ? (KINDS as Record<TemplateName, KindRow>)[name] : undefined;

/** What each class counts, per recipient and per actor (null: not counted per actor). */
const CLASS_CAPS: Record<EmailClass, { recipient: Caps | null; actor: Caps | null }> = {
  // (`recipient: null`: the bucket's own caps — BUCKET_CAPS.)
  unauth_triggered: { recipient: null, actor: ACTOR_CAPS },
  session_action: { recipient: null, actor: ACTOR_CAPS },
  transactional_user: { recipient: null, actor: SENDER_CAPS },
  account_security: { recipient: SECURITY_CAPS, actor: null },
  operator_alert: { recipient: OPERATOR_CAPS, actor: null },
};

export const emailClassOf = (name: TemplateName): EmailClass => KINDS[name].class;
export const EMAIL_BUCKETS: string[] = [...new Set(Object.values(KINDS).map((kind) => kind.bucket))];

// ── delivery ────────────────────────────────────────────────────────────────────────────────

type Recipient = string;

/** A single well-formed address, lower-cased; null for anything else (CR/LF, lists, garbage). */
export function normaliseRecipient(to: unknown): Recipient | null {
  if (typeof to !== "string") return null;
  const address = to.trim().toLowerCase();
  if (address.length > 254 || !/^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[^\s@<>,;:"'\\]+$/.test(address))
    return null;
  return address;
}

/**
 * The address a mailbox is COUNTED under — never the one a message is sent to. Spellings that
 * reach one mailbox share one budget: lower case, NFKC, a `+tag` removed; for Gmail (and
 * googlemail.com) the dots in the local part removed too. Without it, `victim+1@…`, `victim+2@…`
 * would each be a fresh recipient for whoever wants to fill one inbox.
 */
export function canonicalRecipient(address: string): string {
  const lower = address.normalize("NFKC").trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  let local = lower.slice(0, at).split("+")[0]!;
  let domain = lower.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

const ledgerHash = (env: Pick<Env, "FILES_TOKEN_SECRET">, text: string) =>
  hmacHex(createKeys(env.FILES_TOKEN_SECRET), "email-ledger", text);

/** The ledger key of a recipient's count in one bucket: a keyed hash, never the address. */
export async function ledgerKey(
  env: Pick<Env, "FILES_TOKEN_SECRET">,
  address: string,
  bucket: string,
): Promise<string> {
  return ledgerHash(env, `to|${bucket}|${canonicalRecipient(address)}`);
}

/** The ledger key of an actor's count in one class (a client address, a user). */
export async function actorKey(
  env: Pick<Env, "FILES_TOKEN_SECRET">,
  emailClass: EmailClass,
  actor: EmailActor | undefined,
): Promise<string | null> {
  if (actor && "system" in actor) return null;
  const who =
    actor && "user" in actor
      ? `user|${actor.user}`
      : `client|${actor?.client ? normaliseIp(actor.client) : "unknown"}`;
  return ledgerHash(env, `by|${emailClass}|${who}`);
}

/**
 * The ledger key of an address's OWN budget in one bucket (see "WHOSE BUDGET" in the header):
 * the EXACT stored address — not the canonical mailbox (a stranger's account at `victim+x@…`
 * must not spend the budget of `victim@…`), and not the account either (an address that gets a
 * new account — swept, purged, emptied and signed up again — must not get a fresh budget each
 * time). What bounds the variants of one mailbox together is `mailboxKey`'s ceiling.
 */
export async function ownLedgerKey(
  env: Pick<Env, "FILES_TOKEN_SECRET">,
  address: string,
  bucket: string,
): Promise<string> {
  return ledgerHash(env, `own|${bucket}|${address.trim().toLowerCase()}`);
}

/**
 * The CEILING of one mailbox: every mail `admit` counts — whichever bucket, own or anybody's —
 * is also counted here, under the CANONICAL address (plus-tag and Gmail-dot variants folded).
 */
export async function mailboxKey(env: Pick<Env, "FILES_TOKEN_SECRET">, address: string): Promise<string> {
  return ledgerHash(env, `to|all|${canonicalRecipient(address)}`);
}

/** The keyed hash of a canonical address (what the ledger stores is never an address). */
export async function recipientHash(env: Pick<Env, "FILES_TOKEN_SECRET">, address: string): Promise<string> {
  return ledgerKey(env, address, "product");
}

/**
 * How long ONE attempt at the Resend API may take. The client sets no timeout of its own
 * (resend/dist/index.mjs `fetchRequest`: a bare `fetch`), and a send that never answers would
 * hold the request's deferred work open until the platform cancels it — taking with it whatever
 * else was waiting there. Two attempts of an ordinary mail are 5 s; a critical alert with every
 * retry (two attempts, then one per retry after CRITICAL_RETRY_WAITS_MS) is 18 s — both inside
 * the 20 s the deferred work gets (services/request-context.ts DRAIN_DEADLINE_MS), so the
 * failure is still reported and counted.
 */
export const RESEND_TIMEOUT_MS = 2_500;

let resendTimeoutMs = RESEND_TIMEOUT_MS;
/** Tests only: a unit test cannot sit out the real bound. Returns the function that restores it. */
export function setResendTimeoutForTests(ms: number): () => void {
  resendTimeoutMs = ms;
  return () => {
    resendTimeoutMs = RESEND_TIMEOUT_MS;
  };
}

async function viaResend(env: Env, message: { to: string } & RenderedEmail, attempts = 2): Promise<void> {
  const resend = new Resend(env.RESEND_API_KEY);
  const payload = {
    from: SENDER,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  // One key for every attempt: a retry of a send that did go through is not a second email.
  const idempotencyKey = crypto.randomUUID();
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // The request is told to stop (the signal reaches `fetch` through the client's options) AND
    // the wait itself ends: a transport that ignores the signal does not hold this up either.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("resend: no answer in time"));
      }, resendTimeoutMs);
    });
    try {
      const options = { idempotencyKey, signal: controller.signal };
      const { error } = await Promise.race([resend.emails.send(payload, options), timedOut]);
      if (!error) return;
      failure = new Error(`resend: ${error.name ?? "error"}`);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    // Reported once per failed attempt; the address and the content are never part of it.
    reportError(failure, { kind: "email", attempt: String(attempt + 1) });
  }
  throw failure;
}

/**
 * The ONE way a rendered message leaves — every path (a single mail, a digest, a critical alert,
 * a retry) ends here. The memory outbox exists in TEST MODE only (services/clock.ts: the memory
 * transport, not production, AND a plain-http origin): asked for anywhere else it is refused —
 * loudly — rather than swallowing real mail into an isolate's memory.
 */
function transmit(
  env: Env,
  name: TemplateName,
  address: string,
  rendered: RenderedEmail,
  attempts = 2,
): Promise<void> {
  // Once more, where it matters: one plain address, whatever path brought it here.
  const to = normaliseRecipient(address);
  if (!to) return Promise.reject(new Error("email: the recipient is not a single well-formed address"));
  if (env.EMAIL_TRANSPORT === "memory") {
    if (!isTestMode(env)) {
      return Promise.reject(new Error("email: the memory transport was asked for outside test mode"));
    }
    outbox.push({ to, ...rendered, template: name, class: KINDS[name].class });
    return Promise.resolve();
  }
  return viaResend(env, { to, ...rendered }, attempts);
}

/**
 * The counts of one mail of a kind to an address by an actor — taken. True when it may be sent.
 * Shared by `deliver` and `chargeUnsent`, so that the two cannot count differently. Throws when
 * the ledger cannot be reached (the caller decides what that means).
 */
async function admit(
  deps: ServiceDeps,
  name: TemplateName,
  row: KindRow,
  address: string,
  actor: EmailActor | undefined,
): Promise<boolean> {
  const env = deps.env;
  const caps = CLASS_CAPS[row.class];
  const by = caps.actor ? await actorKey(env, row.class, actor) : null;
  if (by !== null && caps.actor && !(await tryConsume(deps.db, by, caps.actor))) {
    countFor(env, "email", { outcome: "capped", kind: name, reason: "actor" });
    return false;
  }
  const recipient = caps.recipient ?? (BUCKET_CAPS as Record<string, Caps>)[row.bucket];
  // A bucket with no caps of its own is not sent from: nothing is uncounted by default.
  if (!recipient) throw new Error("email: a bucket without caps was refused");
  // Mail the address asked for itself is counted apart from mail anybody can cause (the header)
  // — under the exact address, not the canonical mailbox and not the account.
  const account =
    row.class === "unauth_triggered" && actor !== undefined && "client" in actor ? (actor.own ?? null) : null;
  const key =
    account !== null
      ? await ownLedgerKey(env, address, row.bucket)
      : await ledgerKey(env, address, row.bucket);
  if (row.class !== "unauth_triggered") {
    // Mail a session or a sender caused: its bucket, as before. NOT on the mailbox ceiling —
    // nothing an unauthenticated stranger sends may use up, or be used to block, this mail.
    if (!(await tryConsume(deps.db, key, recipient))) {
      countFor(env, "email", { outcome: "capped", kind: name, reason: "recipient" });
      return false;
    }
    return true;
  }
  // Mail anybody can cause, and the own budgets beside it: the bucket (or the address's own
  // budget) AND the mailbox's ceiling, counted in ONE transaction — on both or on neither, so a
  // refusal by one never spends the other, and simultaneous sends cannot pass either figure.
  const ceiling = await mailboxKey(env, address);
  const reached = await tryConsumeAll(deps.db, [
    { key, caps: recipient },
    { key: ceiling, caps: MAILBOX_CAPS },
  ]);
  if (reached !== null) {
    countFor(env, "email", {
      outcome: "capped",
      kind: name,
      reason: reached === ceiling ? "mailbox" : account !== null ? "recipient_own" : "recipient",
    });
    return false;
  }
  return true;
}

/**
 * The counts of a mail that is NOT sent — because the address has no account, or the account is
 * not in a state to be mailed. An unauthenticated request charges the same budgets, with the
 * same statements, whichever it was: otherwise the triggering client's own budget would run out
 * faster for addresses that exist, and "my next mail did not arrive" would say which they were.
 * Never throws; returns nothing — there is nothing to tell.
 */
export async function chargeUnsent(
  deps: ServiceDeps,
  name: TemplateName,
  to: unknown,
  actor: EmailActor,
): Promise<void> {
  try {
    const row = kindOf(name);
    const address = normaliseRecipient(to);
    if (!row || row.class !== "unauth_triggered" || !address) return;
    await admit(deps, name, row, address, actor);
  } catch (error) {
    reportError(error, { kind: "email_ledger", template: name });
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Throws for a critical kind: a critical alert is never held back or folded into anything. */
function assertCoalescible(name: TemplateName): asserts name is CoalescibleName {
  if (kindOf(name)?.severity !== "routine") {
    throw new Error("email: a critical alert was about to be coalesced");
  }
}

/**
 * A CRITICAL operator alert: sent now, whatever any count says — the ledger is not asked. If the
 * transport fails it is tried again in the deferred work, and every failure is reported and
 * counted; a failure of the last try is counted as `critical_lost`.
 */
async function sendCritical(
  deps: ServiceDeps,
  name: TemplateName,
  address: string,
  rendered: RenderedEmail,
): Promise<EmailOutcome> {
  const env = deps.env;
  const failed = (error: unknown, attempt: number) => {
    reportError(error, { kind: "email_critical", template: name, attempt: String(attempt) });
    countFor(env, "email", { outcome: "critical_failed", kind: name });
  };
  try {
    await transmit(env, name, address, rendered);
    countFor(env, "email", { outcome: "sent", kind: name });
    return "sent";
  } catch (error) {
    failed(error, 1);
  }
  deps.defer(
    (async () => {
      for (const [index, wait] of CRITICAL_RETRY_WAITS_MS.entries()) {
        await sleep(wait);
        try {
          // One attempt per retry: the retries ARE the repetition, and the whole sequence has
          // to end inside the deferred-work budget (RESEND_TIMEOUT_MS).
          await transmit(env, name, address, rendered, 1);
          countFor(env, "email", { outcome: "sent", kind: name, reason: "retry" });
          return;
        } catch (error) {
          failed(error, index + 2);
        }
      }
      reportError(new Error("email: a critical operator alert could not be delivered"), {
        kind: "email_critical_lost",
        template: name,
      });
      countFor(env, "email", { outcome: "critical_lost", kind: name });
    })(),
  );
  return "retrying";
}

/** A routine operator alert, as the digest will list it: a kind and an id — nothing else. */
export type OperatorItem = { kind: OperatorRoutineKind; id: string };
const DIGEST_MAX_ITEMS = 500;

/**
 * Sends the operator digest for one mailbox if one is due (at most one an hour) and anything is
 * held: every held alert is taken and LISTED. If the send fails they are put back.
 */
export async function sendOperatorDigestIfDue(deps: ServiceDeps, to: string): Promise<EmailOutcome | null> {
  const env = deps.env;
  // The address may come from a stored row (the hourly flush): validated like any recipient.
  const address = normaliseRecipient(to);
  if (!address) return null;
  const mailbox = await ledgerKey(env, address, KINDS.adminAlert.bucket);
  let due = true;
  try {
    due = await tryConsume(deps.db, await ledgerKey(env, address, KINDS.operatorDigest.bucket), DIGEST_CAPS);
  } catch (error) {
    // An alert does not depend on a counter.
    reportError(error, { kind: "email_ledger", template: "operatorDigest" });
  }
  if (!due) return null;
  const items = await takeHeldAlerts(deps.db, mailbox, DIGEST_MAX_ITEMS);
  if (items.length === 0) return null;
  try {
    const digest = render(env, templates.operatorDigest({ items, adminUrl: `${env.APP_ORIGIN}/admin` }));
    await transmit(env, "operatorDigest", address, digest);
    countFor(env, "email", { outcome: "sent", kind: "operatorDigest" });
    return "sent";
  } catch (error) {
    for (const item of items) await holdAlert(deps.db, mailbox, item);
    await refund(deps.db, await ledgerKey(env, address, KINDS.operatorDigest.bucket)).catch(() => {});
    reportError(error, { kind: "email", template: "operatorDigest" });
    countFor(env, "email", { outcome: "failed", kind: "operatorDigest" });
    return "failed";
  }
}

/** The hourly job: every mailbox with alerts waiting gets its digest, if one is due. */
export async function flushOperatorDigests(deps: ServiceDeps): Promise<number> {
  let sent = 0;
  for (const address of await heldAlertMailboxes(deps.db)) {
    if ((await sendOperatorDigestIfDue(deps, address)) === "sent") sent += 1;
  }
  return sent;
}

/**
 * One mail of one kind to one address — counted first (see the header for each class's rule).
 * Exported for its tests; everything else calls a `send*` function.
 */
export async function deliver(
  deps: ServiceDeps,
  name: TemplateName,
  to: unknown,
  draft: () => Draft,
  actor?: EmailActor,
  item?: OperatorItem,
): Promise<EmailOutcome> {
  const env = deps.env;
  const kind = name;
  try {
    // A kind the table does not have is never sent — whatever the compiler was told.
    const row = kindOf(name);
    if (
      !row ||
      !Object.hasOwn(CLASS_CAPS, row.class) ||
      (row.severity !== "critical" && row.severity !== "routine")
    ) {
      throw new Error("email: an unclassified kind was refused");
    }
    const caps = CLASS_CAPS[row.class];
    const address = normaliseRecipient(to);
    if (!address) throw new Error("email: the recipient is not a single well-formed address");
    const rendered = render(env, draft());

    // CRITICAL: before, and instead of, every count.
    if (row.severity === "critical") return await sendCritical(deps, name, address, rendered);

    if (row.class === "account_security" || row.class === "operator_alert") {
      // Never suppressed by another class, never dependent on the counter: a ledger that cannot
      // be reached is reported and the notice goes out (fail OPEN).
      let within = true;
      try {
        within = await tryConsume(deps.db, await ledgerKey(env, address, row.bucket), caps.recipient!);
      } catch (error) {
        reportError(error, { kind: "email_ledger", template: name });
        countFor(env, "email", { outcome: "ledger_failed", kind });
      }
      if (!within) {
        assertCoalescible(name);
        return row.class === "operator_alert"
          ? await holdForDigest(deps, name, address, item)
          : await coalesce(deps, name, address);
      }
    } else {
      // Every other class fails CLOSED: a ledger error is thrown from here and nothing is sent.
      if (!(await admit(deps, name, row, address, actor))) return "capped";
    }

    await transmit(env, name, address, rendered);
    countFor(env, "email", { outcome: "sent", kind });
    return "sent";
  } catch (error) {
    reportError(error, { kind: "email", template: name });
    countFor(env, "email", { outcome: "failed", kind });
    return "failed";
  }
}

/**
 * A routine operator alert beyond the hour's count: HELD, and listed — by kind and id — in the
 * mailbox's next digest (now, if one is due; else within the hour, by the flush job).
 */
async function holdForDigest(
  deps: ServiceDeps,
  name: CoalescibleName,
  address: string,
  item: OperatorItem | undefined,
): Promise<EmailOutcome> {
  const mailbox = await ledgerKey(deps.env, address, KINDS.adminAlert.bucket);
  try {
    await holdAlert(deps.db, mailbox, { kind: item?.kind ?? "report", id: safeId(item?.id), to: address });
  } catch (error) {
    // It could not be held, so it is not held back: the alert itself goes out (fail OPEN).
    reportError(error, { kind: "email_ledger", template: name });
    const alert = render(
      deps.env,
      templates.adminAlert({
        kind: item?.kind ?? "report",
        id: item?.id,
        adminUrl: `${deps.env.APP_ORIGIN}/admin`,
      }),
    );
    await transmit(deps.env, "adminAlert", address, alert);
    countFor(deps.env, "email", { outcome: "sent", kind: name, reason: "not_held" });
    return "sent";
  }
  countFor(deps.env, "email", { outcome: "coalesced", kind: name });
  await sendOperatorDigestIfDue(deps, address);
  return "coalesced";
}

/**
 * A security notice beyond the hour's count: not sent on its own and not dropped — the FIRST one
 * of the hour sends the digest that stands for all of them; the rest are counted into it.
 */
async function coalesce(deps: ServiceDeps, name: CoalescibleName, address: string): Promise<EmailOutcome> {
  const env = deps.env;
  let first = true;
  try {
    first = await tryConsume(
      deps.db,
      await ledgerKey(env, address, KINDS.securityDigest.bucket),
      DIGEST_CAPS,
    );
  } catch (error) {
    reportError(error, { kind: "email_ledger", template: "securityDigest" });
  }
  if (first) {
    const digest = render(env, templates.securityDigest({ accountUrl: `${env.APP_ORIGIN}/account` }));
    try {
      await transmit(env, "securityDigest", address, digest);
    } catch (error) {
      // The digest did not go out: its place in the hour is given back, so that the next notice
      // tries again — a digest that was never delivered must not stand for anything.
      await refund(deps.db, await ledgerKey(env, address, KINDS.securityDigest.bucket)).catch(() => {});
      throw error;
    }
  }
  countFor(env, "email", { outcome: "coalesced", kind: name });
  return "coalesced";
}

const appUrl = (env: Pick<Env, "APP_ORIGIN">, path: string) => `${env.APP_ORIGIN}${path}`;

type To = { to: string; name?: unknown };

/** The client address of the request that caused an unauthenticated mail (null: not known). */
type ByClient = { by: { client: string | null; own?: string | null } };
/** The user whose session caused a mail. */
type ByUser = { by: { user: string } };
const SYSTEM: EmailActor = { system: true };

// unauth_triggered
export const sendVerification = (deps: ServiceDeps, d: To & ByClient & { url: string; resend?: boolean }) =>
  deliver(deps, "verification", d.to, () => templates.verification(d), d.by);
/** To the owner of an address somebody tried to sign up with. A notice: it carries no token. */
export const sendSignupAttempt = (deps: ServiceDeps, d: To & ByClient) =>
  deliver(
    deps,
    "signupAttempt",
    d.to,
    () => templates.signupAttempt({ ...d, loginUrl: appUrl(deps.env, "/login") }),
    d.by,
  );
export const sendPasswordReset = (deps: ServiceDeps, d: To & ByClient & { url: string }) =>
  deliver(deps, "passwordReset", d.to, () => templates.passwordReset(d), d.by);

// session_action
export const sendNewAddressVerification = (deps: ServiceDeps, d: To & ByUser & { url: string }) =>
  deliver(deps, "newAddressVerification", d.to, () => templates.newAddressVerification(d), d.by);
/** To the CURRENT address; the new one gets `sendNewAddressVerification` after the click. */
export const sendChangeEmailConfirmation = (
  deps: ServiceDeps,
  d: To & ByUser & { newEmail: string; url: string },
) => deliver(deps, "changeEmailConfirmation", d.to, () => templates.changeEmailConfirmation(d), d.by);
export const sendDeleteAccountVerification = (deps: ServiceDeps, d: To & ByUser & { url: string }) =>
  deliver(deps, "deleteAccountVerification", d.to, () => templates.deleteAccountVerification(d), d.by);

// security class
export const sendDeletionScheduled = (deps: ServiceDeps, d: To & { scheduledFor: Date }) =>
  deliver(deps, "deletionScheduled", d.to, () =>
    templates.deletionScheduled({ ...d, accountUrl: appUrl(deps.env, "/account") }),
  );
export const sendDeletionCancelled = (deps: ServiceDeps, d: To) =>
  deliver(deps, "deletionCancelled", d.to, () =>
    templates.deletionCancelled({ ...d, accountUrl: appUrl(deps.env, "/account") }),
  );
export const sendPasswordChanged = (deps: ServiceDeps, d: To) =>
  deliver(deps, "passwordChanged", d.to, () => templates.passwordChanged(d));
export const sendTwoFactorEnabled = (deps: ServiceDeps, d: To) =>
  deliver(deps, "twoFactorEnabled", d.to, () => templates.twoFactorEnabled(d));
export const sendSecondFactorLocked = (deps: ServiceDeps, d: To & { minutes: number }) =>
  deliver(deps, "secondFactorLocked", d.to, () => templates.secondFactorLocked(d));
export const sendTwoFactorDisabled = (deps: ServiceDeps, d: To) =>
  deliver(deps, "twoFactorDisabled", d.to, () => templates.twoFactorDisabled(d));
export const sendSignInMethodAdded = (deps: ServiceDeps, d: To & { method: "google" }) =>
  deliver(deps, "signInMethodAdded", d.to, () => templates.signInMethodAdded(d));
export const sendPasskeyAdded = (deps: ServiceDeps, d: To) =>
  deliver(deps, "passkeyAdded", d.to, () => templates.passkeyAdded(d));
export const sendPasskeyRemoved = (deps: ServiceDeps, d: To) =>
  deliver(deps, "passkeyRemoved", d.to, () => templates.passkeyRemoved(d));
export const sendNewDeviceSignIn = (
  deps: ServiceDeps,
  d: To & { country?: string | null; uaFamily?: string | null; at: Date },
) => deliver(deps, "newDeviceSignIn", d.to, () => templates.newDeviceSignIn(d));
export const sendAccountSuspended = (deps: ServiceDeps, d: To) =>
  deliver(deps, "accountSuspended", d.to, () => templates.accountSuspended(d));
// operator_alert
/** ROUTINE: a new abuse report or a quarantined file. An id and a category — never a file name. */
export const sendAdminAlert = (
  deps: ServiceDeps,
  d: { to: string; kind: OperatorRoutineKind; id: string; category?: string },
) =>
  deliver(
    deps,
    "adminAlert",
    d.to,
    () => templates.adminAlert({ ...d, adminUrl: appUrl(deps.env, "/admin") }),
    SYSTEM,
    { kind: d.kind, id: d.id },
  );
/**
 * CRITICAL: a suspected-CSAM lock, a legal hold, a kill-switch change, an admin lock-out, the
 * storage-budget switch, the scanner down. Always sent, at once; never counted or coalesced.
 */
export const sendOperatorCritical = (
  deps: ServiceDeps,
  d: { to: string; event: OperatorCriticalEvent; id?: string },
) =>
  deliver(
    deps,
    "operatorCritical",
    d.to,
    () => templates.operatorCritical({ ...d, adminUrl: appUrl(deps.env, "/admin") }),
    SYSTEM,
  );

// product class
/**
 * One template, two variants: `hasAccount: false` is an address with no account yet (the link
 * goes to sign-up; pass `inviteCode` while sign-up is invite-only).
 */
export const sendShareInvitation = (
  deps: ServiceDeps,
  d: {
    to: string;
    sharerName: string;
    itemName: string;
    role: "viewer" | "editor";
    hasAccount: boolean;
    inviteCode?: string;
    /** The user who shared: counted per sender as well as per recipient. */
    senderId: string;
  },
) =>
  deliver(
    deps,
    "shareInvitation",
    d.to,
    () =>
      templates.shareInvitation({
        ...d,
        url: d.hasAccount
          ? appUrl(deps.env, "/shared")
          : appUrl(deps.env, d.inviteCode ? `/invite/${encodeURIComponent(d.inviteCode)}` : "/signup"),
      }),
    { user: d.senderId },
  );
export const sendQuarantineNotice = (deps: ServiceDeps, d: To & { fileName: string }) =>
  deliver(deps, "quarantineNotice", d.to, () => templates.quarantineNotice(d), SYSTEM);
export const sendUploadNotIntact = (deps: ServiceDeps, d: To & { fileName: string }) =>
  deliver(deps, "uploadNotIntact", d.to, () => templates.uploadNotIntact(d), SYSTEM);
export const sendLinkPaused = (deps: ServiceDeps, d: To & { itemName: string }) =>
  deliver(deps, "linkPaused", d.to, () => templates.linkPaused(d), SYSTEM);
export const sendLinkCapReached = (deps: ServiceDeps, d: To) =>
  deliver(deps, "linkCapReached", d.to, () => templates.linkCapReached(d), SYSTEM);
export const sendLinkLimitReached = (deps: ServiceDeps, d: To & { itemName: string }) =>
  deliver(deps, "linkLimitReached", d.to, () => templates.linkLimitReached(d), SYSTEM);
export const sendLinkAvailableAgain = (deps: ServiceDeps, d: To & { itemName: string }) =>
  deliver(deps, "linkAvailableAgain", d.to, () => templates.linkAvailableAgain(d), SYSTEM);
export const sendAdminDigest = (
  deps: ServiceDeps,
  d: { to: string; lines: Array<{ label: string; value: string | number }> },
) =>
  deliver(
    deps,
    "adminDigest",
    d.to,
    () => templates.adminDigest({ lines: d.lines, adminUrl: appUrl(deps.env, "/admin") }),
    SYSTEM,
  );
export const sendReportReviewed = (deps: ServiceDeps, d: { to: string }) =>
  deliver(deps, "reportReviewed", d.to, () => templates.reportReviewed(), SYSTEM);
export const sendContentRemovedCopyright = (
  deps: ServiceDeps,
  d: To & {
    itemName: string;
    itemNames?: string[];
    noticeText: string;
    strike?: boolean;
    folderOwner?: boolean;
  },
) =>
  deliver(
    deps,
    "contentRemovedCopyright",
    d.to,
    () => templates.contentRemovedCopyright({ ...d, counterNoticeUrl: appUrl(deps.env, "/dmca") }),
    SYSTEM,
  );
export const sendContentRestored = (deps: ServiceDeps, d: To & { itemName: string; itemNames?: string[] }) =>
  deliver(deps, "contentRestored", d.to, () => templates.contentRestored(d), SYSTEM);
export const sendDmcaCounterForwarded = (
  deps: ServiceDeps,
  d: To & {
    noticeId: string;
    counter: Parameters<typeof templates.dmcaCounterForwarded>[0]["counter"];
    notBefore: Date;
    notAfter: Date;
  },
) =>
  deliver(
    deps,
    "dmcaCounterForwarded",
    d.to,
    () => templates.dmcaCounterForwarded({ ...d, dmcaUrl: appUrl(deps.env, "/dmca") }),
    SYSTEM,
  );
export const sendDmcaRestoredComplainant = (deps: ServiceDeps, d: To & { noticeId: string }) =>
  deliver(deps, "dmcaRestoredComplainant", d.to, () => templates.dmcaRestoredComplainant(d), SYSTEM);
