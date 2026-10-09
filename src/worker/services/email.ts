// Every email Holdfast sends: the templates, the per-recipient caps and the two transports.
//
//   await sendVerification(deps, { to, name, url });          // deps = deps(c), bg, or { db, env, defer }
//
// Later tasks call the exported `send*` functions; they do not add templates here — a missing
// template is a report item for the orchestrator.
//
// HOW A MESSAGE IS BUILT. A template is a list of plain-text blocks and link blocks. There is no
// inline HTML anywhere in a template: the HTML part is produced by escaping every block as a
// whole, so a name, a file name or any other value a person typed cannot become markup. Such
// values also pass through `clean()` first (control and format characters — CR, LF, the
// right-to-left override — removed, length capped). SUBJECTS ARE CONSTANTS: no user value ever
// reaches a subject, so there is nothing to inject a header with. Every link is checked to start
// with `APP_ORIGIN` (or to be one of the fixed estate pages below) before a message is built —
// never a URL derived from a request's Host header.
//
// CLASSES AND CAPS (the counters live in `email_ledger`, because a Worker has no shared memory):
//   auth      verification, reset, change-email, delete confirmation     5 an hour, 50 a day
//   product   share invitation, quarantine, link paused, digest, …        per recipient
//   security  password changed, 2FA, passkey, new device, suspended,      never dropped: sent
//             deletion scheduled / cancelled, admin alert                 without the ledger
// Over a cap the send is skipped and counted (`metric("email", { outcome: "capped" })`); the
// caller gets "capped", never an error — nothing here tells a caller whether an address exists.
//
// TRANSPORT. `EMAIL_TRANSPORT=memory` pushes to the in-memory outbox (services/outbox.ts; tests
// read it at /api/_test/outbox). Anything else sends through Resend with `RESEND_API_KEY`; a
// failed send is reported and retried once under the same idempotency key.
//
// No `send*` function throws.

import { Resend } from "resend";
import { tryConsume } from "../db/queries/email-ledger";
import { countFor, reportError } from "../auth/observe";
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

export const EMAIL_CAPS = { perHour: 5, perDay: 50 } as const;

export type EmailClass = "auth" | "product" | "security";
export type EmailOutcome = "sent" | "capped" | "failed";

type Block = { text: string } | { link: { label: string; url: string } } | { quote: string };
type Draft = { subject: string; heading: string; blocks: Block[] };
export type RenderedEmail = { subject: string; text: string; html: string };

// ── sanitising ──────────────────────────────────────────────────────────────────────────────

/**
 * A value a person typed, made safe to place in a message: control characters (CR, LF, NUL …)
 * and format characters (the bidirectional overrides, zero-width joiners) removed, runs of
 * white space collapsed, and capped in length. NOT HTML-escaped — the renderer does that.
 */
export function clean(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const stripped = text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

/** As `clean`, for a longer passage whose line breaks matter (a notice quoted in full). */
function cleanMultiline(value: unknown, max = 8000): string {
  const text = typeof value === "string" ? value : "";
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trimEnd());
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

const greeting = (name: unknown) => {
  const who = clean(name, 80);
  return who ? `Hello ${who},` : "Hello,";
};

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

// ── templates ───────────────────────────────────────────────────────────────────────────────

const IGNORE = "If this wasn't you, you can ignore this email.";
const NOT_YOU = `If this wasn't you, change your password now and contact ${SUPPORT_EMAIL}.`;

/** Every template, as a function from its data to a draft. Exported for the render tests. */
export const templates = {
  verification: (d: { name?: unknown; url: string; resend?: boolean }): Draft => ({
    subject: "Confirm your email address",
    heading: "Confirm your email address",
    blocks: [
      { text: greeting(d.name) },
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
      { text: greeting(d.name) },
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
      { text: greeting(d.name) },
      { text: "Confirm this address to make it the email address of your Holdfast account." },
      { link: { label: "Confirm new address", url: d.url } },
      { text: `The link works for one hour. ${IGNORE}` },
    ],
  }),
  passwordReset: (d: { name?: unknown; url: string }): Draft => ({
    subject: "Reset your password",
    heading: "Reset your password",
    blocks: [
      { text: greeting(d.name) },
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
        text: `Someone asked to change the email address of your Holdfast account to ${clean(d.newEmail, 254)}.`,
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
        text: `Your Holdfast account was signed in to from a browser or place we have not seen in the last 30 days: ${clean(d.uaFamily, 80) || "an unknown browser"}, ${clean(d.country, 8) || "unknown country"}, ${formatInstant(d.at)}.`,
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
        text: `${clean(d.sharerName, 80) || "Someone"} shared “${clean(d.itemName)}” with you on Holdfast. You can ${d.role === "editor" ? "view and add to" : "view"} it.`,
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
        text: `The virus scan flagged “${clean(d.fileName)}”. The file is blocked: it cannot be downloaded, previewed or shared.`,
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
        text: `“${clean(d.fileName)}” does not match what your browser sent, so it has been blocked. This usually means the upload was interrupted.`,
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
        text: `The public link to “${clean(d.itemName)}” reached today's traffic limit and is paused. It becomes available again at midnight UTC.`,
      },
    ],
  }),
  linkAvailableAgain: (d: { name?: unknown; itemName: unknown }): Draft => ({
    subject: "A public link is available again",
    heading: "A public link is available again",
    blocks: [
      { text: greeting(d.name) },
      { text: `The public link to “${clean(d.itemName)}” is available again.` },
    ],
  }),
  adminDigest: (d: { lines: Array<{ label: unknown; value: unknown }>; adminUrl: string }): Draft => ({
    subject: "Holdfast admin digest",
    heading: "Admin digest",
    blocks: [
      ...d.lines.slice(0, 40).map((line) => ({ text: `${clean(line.label, 80)}: ${clean(line.value, 80)}` })),
      { link: { label: "Open the admin console", url: d.adminUrl } },
    ],
  }),
  /** Carries the report id and category only — never a file name. */
  adminAlert: (d: {
    kind: "report" | "csam_lock";
    reportId: unknown;
    category: unknown;
    adminUrl: string;
  }): Draft => ({
    subject: d.kind === "csam_lock" ? "Holdfast: content locked for review" : "Holdfast: new abuse report",
    heading: d.kind === "csam_lock" ? "Content locked for review" : "New abuse report",
    blocks: [
      { text: `Report ${clean(d.reportId, 64)} · category ${clean(d.category, 32)}.` },
      { link: { label: "Open the admin console", url: d.adminUrl } },
    ],
  }),
  /** To a reporter who left an address. Says only that the report was reviewed. */
  reportReviewed: (): Draft => ({
    subject: "Your report was reviewed",
    heading: "Your report was reviewed",
    blocks: [
      { text: "Thank you for your report to Holdfast. It has been reviewed." },
      { text: "We cannot share what action, if any, was taken." },
    ],
  }),
  contentRemovedCopyright: (d: {
    name?: unknown;
    itemName: unknown;
    noticeText: unknown;
    counterNoticeUrl: string;
  }): Draft => ({
    subject: "Content removed following a copyright notice",
    heading: "Content removed following a copyright notice",
    blocks: [
      { text: greeting(d.name) },
      {
        text: `We received a copyright notice about “${clean(d.itemName)}” and have removed access to it. The notice is quoted below.`,
      },
      { quote: cleanMultiline(d.noticeText) },
      {
        text: "If you believe the content was removed by mistake or misidentification, you can send a counter-notice. It must identify the content, state under penalty of perjury that you believe in good faith it was removed by mistake, give your name, address and telephone number, consent to the jurisdiction of the federal court for your address, and be signed.",
      },
      { link: { label: "How to send a counter-notice", url: d.counterNoticeUrl } },
    ],
  }),
  contentRestored: (d: { name?: unknown; itemName: unknown }): Draft => ({
    subject: "Your content has been restored",
    heading: "Content restored",
    blocks: [{ text: greeting(d.name) }, { text: `Access to “${clean(d.itemName)}” has been restored.` }],
  }),
} as const;

export type TemplateName = keyof typeof templates;

const CLASS_OF: Record<TemplateName, EmailClass> = {
  verification: "auth",
  signupAttempt: "auth",
  newAddressVerification: "auth",
  passwordReset: "auth",
  changeEmailConfirmation: "auth",
  deleteAccountVerification: "auth",
  deletionScheduled: "security",
  deletionCancelled: "security",
  passwordChanged: "security",
  twoFactorEnabled: "security",
  twoFactorDisabled: "security",
  passkeyAdded: "security",
  signInMethodAdded: "security",
  passkeyRemoved: "security",
  newDeviceSignIn: "security",
  accountSuspended: "security",
  adminAlert: "security",
  shareInvitation: "product",
  quarantineNotice: "product",
  uploadNotIntact: "product",
  linkPaused: "product",
  linkAvailableAgain: "product",
  adminDigest: "product",
  reportReviewed: "product",
  contentRemovedCopyright: "product",
  contentRestored: "product",
};

export const emailClassOf = (name: TemplateName): EmailClass => CLASS_OF[name];

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

/** The ledger key of a recipient: HMAC(email-ledger key, lower-cased address). */
export async function recipientHash(env: Pick<Env, "FILES_TOKEN_SECRET">, address: string): Promise<string> {
  return hmacHex(createKeys(env.FILES_TOKEN_SECRET), "email-ledger", address.trim().toLowerCase());
}

async function viaResend(env: Env, message: { to: string } & RenderedEmail): Promise<void> {
  const resend = new Resend(env.RESEND_API_KEY);
  const payload = {
    from: SENDER,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  // One key for both attempts: a retry of a send that did go through is not a second email.
  const idempotencyKey = crypto.randomUUID();
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await resend.emails.send(payload, { idempotencyKey });
      if (!error) return;
      failure = new Error(`resend: ${error.name ?? "error"}`);
    } catch (error) {
      failure = error;
    }
    // Reported once per failed attempt; the address and the content are never part of it.
    reportError(failure, { kind: "email", attempt: String(attempt + 1) });
  }
  throw failure;
}

async function deliver(
  deps: ServiceDeps,
  name: TemplateName,
  to: unknown,
  draft: () => Draft,
): Promise<EmailOutcome> {
  const env = deps.env;
  const kind = name;
  try {
    const address = normaliseRecipient(to);
    if (!address) throw new Error("email: the recipient is not a single well-formed address");
    const rendered = render(env, draft());

    if (CLASS_OF[name] !== "security") {
      const allowed = await tryConsume(deps.db, await recipientHash(env, address), EMAIL_CAPS);
      if (!allowed) {
        countFor(env, "email", { outcome: "capped", kind });
        return "capped";
      }
    }

    if (env.EMAIL_TRANSPORT === "memory") {
      outbox.push({ to: address, ...rendered, template: name, class: CLASS_OF[name] });
    } else {
      await viaResend(env, { to: address, ...rendered });
    }
    countFor(env, "email", { outcome: "sent", kind });
    return "sent";
  } catch (error) {
    reportError(error, { kind: "email", template: name });
    countFor(env, "email", { outcome: "failed", kind });
    return "failed";
  }
}

const appUrl = (env: Pick<Env, "APP_ORIGIN">, path: string) => `${env.APP_ORIGIN}${path}`;

type To = { to: string; name?: unknown };

// auth class
export const sendVerification = (deps: ServiceDeps, d: To & { url: string; resend?: boolean }) =>
  deliver(deps, "verification", d.to, () => templates.verification(d));
/** To the owner of an address somebody tried to sign up with. A notice: it carries no token. */
export const sendSignupAttempt = (deps: ServiceDeps, d: To) =>
  deliver(deps, "signupAttempt", d.to, () =>
    templates.signupAttempt({ ...d, loginUrl: appUrl(deps.env, "/login") }),
  );
export const sendNewAddressVerification = (deps: ServiceDeps, d: To & { url: string }) =>
  deliver(deps, "newAddressVerification", d.to, () => templates.newAddressVerification(d));
export const sendPasswordReset = (deps: ServiceDeps, d: To & { url: string }) =>
  deliver(deps, "passwordReset", d.to, () => templates.passwordReset(d));
/** To the CURRENT address; the new one gets `sendNewAddressVerification` after the click. */
export const sendChangeEmailConfirmation = (deps: ServiceDeps, d: To & { newEmail: string; url: string }) =>
  deliver(deps, "changeEmailConfirmation", d.to, () => templates.changeEmailConfirmation(d));
export const sendDeleteAccountVerification = (deps: ServiceDeps, d: To & { url: string }) =>
  deliver(deps, "deleteAccountVerification", d.to, () => templates.deleteAccountVerification(d));

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
/** A new report, or a suspected-CSAM lock. The report id and category only — never a file name. */
export const sendAdminAlert = (
  deps: ServiceDeps,
  d: { to: string; kind: "report" | "csam_lock"; reportId: string; category: string },
) =>
  deliver(deps, "adminAlert", d.to, () =>
    templates.adminAlert({ ...d, adminUrl: appUrl(deps.env, "/admin") }),
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
  },
) =>
  deliver(deps, "shareInvitation", d.to, () =>
    templates.shareInvitation({
      ...d,
      url: d.hasAccount
        ? appUrl(deps.env, "/shared")
        : appUrl(deps.env, d.inviteCode ? `/invite/${encodeURIComponent(d.inviteCode)}` : "/signup"),
    }),
  );
export const sendQuarantineNotice = (deps: ServiceDeps, d: To & { fileName: string }) =>
  deliver(deps, "quarantineNotice", d.to, () => templates.quarantineNotice(d));
export const sendUploadNotIntact = (deps: ServiceDeps, d: To & { fileName: string }) =>
  deliver(deps, "uploadNotIntact", d.to, () => templates.uploadNotIntact(d));
export const sendLinkPaused = (deps: ServiceDeps, d: To & { itemName: string }) =>
  deliver(deps, "linkPaused", d.to, () => templates.linkPaused(d));
export const sendLinkAvailableAgain = (deps: ServiceDeps, d: To & { itemName: string }) =>
  deliver(deps, "linkAvailableAgain", d.to, () => templates.linkAvailableAgain(d));
export const sendAdminDigest = (
  deps: ServiceDeps,
  d: { to: string; lines: Array<{ label: string; value: string | number }> },
) =>
  deliver(deps, "adminDigest", d.to, () =>
    templates.adminDigest({ lines: d.lines, adminUrl: appUrl(deps.env, "/admin") }),
  );
export const sendReportReviewed = (deps: ServiceDeps, d: { to: string }) =>
  deliver(deps, "reportReviewed", d.to, () => templates.reportReviewed());
export const sendContentRemovedCopyright = (
  deps: ServiceDeps,
  d: To & { itemName: string; noticeText: string },
) =>
  deliver(deps, "contentRemovedCopyright", d.to, () =>
    templates.contentRemovedCopyright({ ...d, counterNoticeUrl: appUrl(deps.env, "/dmca") }),
  );
export const sendContentRestored = (deps: ServiceDeps, d: To & { itemName: string }) =>
  deliver(deps, "contentRestored", d.to, () => templates.contentRestored(d));
