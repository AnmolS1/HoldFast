// What Holdfast will and will not put in a mail, and which mail counts against which budget
// (src/worker/services/email.ts): a value a person typed is a LABEL — never a message, never a
// link — in every template; and no class of mail can use up, or slip past, another's count.
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as ledger from "../../../src/worker/db/queries/email-ledger";
import {
  ACTOR_CAPS,
  canonicalRecipient,
  CRITICAL_RETRY_WAITS_MS,
  deliver,
  flushOperatorDigests,
  OPERATOR_CAPS,
  safeId,
  sendAdminAlert,
  sendOperatorCritical,
  type CoalescibleName,
  EMAIL_CAPS,
  ESTATE_LINKS,
  KINDS,
  LABEL_MAX,
  ledgerKey,
  render,
  safeLabel,
  SECURITY_CAPS,
  SENDER_CAPS,
  sendNewDeviceSignIn,
  sendPasswordChanged,
  sendPasswordReset,
  sendShareInvitation,
  sendSignupAttempt,
  sendTwoFactorDisabled,
  sendVerification,
  SUPPORT_EMAIL,
  templates,
  type TemplateName,
} from "../../../src/worker/services/email";
import emailSource from "../../../src/worker/services/email.ts?raw";
import { testOutbound } from "../../../src/worker/auth/test-outbound";
import { freshEmail, freshIp, mailTo, serviceDeps, testDb } from "./helpers";

vi.mock("../../../src/worker/db/queries/email-ledger", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/email-ledger")>();
  return { ...real, tryConsume: vi.fn(real.tryConsume) };
});

const APP = "http://localhost";
const renderEnv = { APP_ORIGIN: APP, SENTRY_ENVIRONMENT: "test" };
const when = new Date("2026-10-16T09:30:00Z");

// ── (1) content ─────────────────────────────────────────────────────────────────────────────

const RTLO = "\u202e";
const CORPUS: Array<[string, string]> = [
  ["a URL", "https://evil.example/login"],
  ["a URL, no scheme", "evil.example/login"],
  ["a bare domain", "evil.example"],
  ["a www host", "www.evil-example.com"],
  ["a sentence with a domain", "Your account is locked — sign in at evil.example"],
  ["an address", "support@evil.example"],
  ["a mailto", "mailto:x@evil.example"],
  ["a javascript URL", "javascript:alert(1)//evil.example"],
  ["a scheme-relative URL", "//evil.example/x"],
  ["a backslash URL", "https:\\\\evil.example\\x"],
  ["right-to-left override", `invoice${RTLO}gpj.exe evil.example`],
  ["zero-width joiners inside a domain", "evil\u200d.\u200bexa\u200cmple\u2060.com"],
  ["a soft hyphen and a BOM", "ev\u00adil.ex\ufeffample"],
  ["CRLF and a header", "Bob\r\nBcc: victim@evil.example\r\n\r\nhttps://evil.example"],
  ["an anchor", '<a href="https://evil.example">click here</a>'],
  ["a markdown link", "[sign in](https://evil.example)"],
  ["an autolink", "<https://evil.example>"],
  ["a homoglyph domain", "раураl.com"],
  ["a full-width domain", "ｅｖｉｌ．ｅｘａｍｐｌｅ／ｌｏｇｉｎ"],
  ["an ideographic full stop", "evil。example"],
  ["a full-width scheme", "ｈｔｔｐｓ：／／evil.example"],
  ["an IP address", "http://203.0.113.9/x"],
  ["line and paragraph separators", "one\u2028https://evil.example\u2029two"],
  ["ten thousand characters", `${"A".repeat(5_000)} https://evil.example ${"B".repeat(5_000)}`],
  ["ten thousand dots", "a.b".repeat(3_400)],
];

/** One draft per template, with `value` in every field anything typed could reach. */
function draftsWith(value: string): Record<TemplateName, ReturnType<(typeof templates)[TemplateName]>> {
  const url = `${APP}/api/auth/verify-email?token=t`;
  return {
    verification: templates.verification({ name: value, url }),
    signupAttempt: templates.signupAttempt({ name: value, loginUrl: `${APP}/login` }),
    newAddressVerification: templates.newAddressVerification({ name: value, url }),
    passwordReset: templates.passwordReset({ name: value, url: `${APP}/api/auth/reset-password/t` }),
    changeEmailConfirmation: templates.changeEmailConfirmation({ name: value, newEmail: value, url }),
    deleteAccountVerification: templates.deleteAccountVerification({ name: value, url }),
    deletionScheduled: templates.deletionScheduled({
      name: value,
      scheduledFor: when,
      accountUrl: `${APP}/account`,
    }),
    deletionCancelled: templates.deletionCancelled({ name: value, accountUrl: `${APP}/account` }),
    passwordChanged: templates.passwordChanged({ name: value }),
    twoFactorEnabled: templates.twoFactorEnabled({ name: value }),
    twoFactorDisabled: templates.twoFactorDisabled({ name: value }),
    secondFactorLocked: templates.secondFactorLocked({ name: value, minutes: 15 }),
    signInMethodAdded: templates.signInMethodAdded({ name: value, method: "google" }),
    passkeyAdded: templates.passkeyAdded({ name: value }),
    passkeyRemoved: templates.passkeyRemoved({ name: value }),
    newDeviceSignIn: templates.newDeviceSignIn({ name: value, country: value, uaFamily: value, at: when }),
    accountSuspended: templates.accountSuspended({ name: value }),
    adminAlert: templates.adminAlert({
      kind: "report",
      id: value,
      category: value,
      adminUrl: `${APP}/admin`,
    }),
    operatorCritical: templates.operatorCritical({ event: "csam_lock", id: value, adminUrl: `${APP}/admin` }),
    operatorDigest: templates.operatorDigest({
      items: [
        { kind: value, id: value },
        { kind: "quarantine", id: value },
      ],
      adminUrl: `${APP}/admin`,
    }),
    securityDigest: templates.securityDigest({ name: value, accountUrl: `${APP}/account` }),
    shareInvitation: templates.shareInvitation({
      sharerName: value,
      itemName: value,
      role: "viewer",
      hasAccount: false,
      url: `${APP}/signup`,
    }),
    quarantineNotice: templates.quarantineNotice({ name: value, fileName: value }),
    uploadNotIntact: templates.uploadNotIntact({ name: value, fileName: value }),
    linkPaused: templates.linkPaused({ name: value, itemName: value }),
    linkAvailableAgain: templates.linkAvailableAgain({ name: value, itemName: value }),
    adminDigest: templates.adminDigest({ lines: [{ label: value, value }], adminUrl: `${APP}/admin` }),
    reportReviewed: templates.reportReviewed(),
    contentRemovedCopyright: templates.contentRemovedCopyright({
      name: value,
      itemName: value,
      noticeText: `${value}\n${value}`,
      counterNoticeUrl: `${APP}/dmca`,
    }),
    contentRestored: templates.contentRestored({ name: value, itemName: value }),
  };
}

/** Everything in a mail that is ours by construction: our links, the estate pages, the support address. */
const OURS = [
  new RegExp(`${APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"<]*`, "g"),
  SUPPORT_EMAIL,
  ...Object.values(ESTATE_LINKS),
];
function withoutOurs(text: string): string {
  let rest = text;
  for (const ours of OURS)
    rest = typeof ours === "string" ? rest.split(ours).join(" ") : rest.replace(ours, " ");
  return rest;
}
/** What a mail client would turn into a link, or read as an address. */
const LINK_LIKE = [
  /:\/\//,
  /\bwww\./i,
  /[\p{L}\p{N}_-]\.[\p{L}]{2,}/u, // label.tld — any script
  /[\p{L}\p{N}]\u3002\p{L}/u,
  /@/,
  /\b(?:mailto|javascript|data|tel|sms):/i,
  /\\\\|\/\//,
];
const CONTROL_OR_FORMAT =
  // eslint-disable-next-line no-control-regex -- control and format characters are exactly what is looked for
  /[\u0000-\u0009\u000b-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/;
const htmlText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

describe("a typed value is a label: nothing link-like, in any template, in either part", () => {
  const SUBJECTS = Object.fromEntries(
    Object.entries(draftsWith("x")).map(([name, draft]) => [name, draft.subject]),
  );

  it("the table of drafts covers every template", () => {
    expect(Object.keys(draftsWith("x")).sort()).toEqual(Object.keys(templates).sort());
  });

  it.each(CORPUS)("%s", (_what, value) => {
    for (const [name, draft] of Object.entries(draftsWith(value))) {
      const message = render(renderEnv, draft);
      // The subject is a constant: the same whatever was typed.
      expect(draft.subject, name).toBe(SUBJECTS[name]);
      expect(message.subject, name).toBe(`[dev] ${SUBJECTS[name]}`);
      for (const [part, body] of [
        ["text", message.text],
        ["html", htmlText(message.html)],
      ] as const) {
        const rest = withoutOurs(body);
        for (const pattern of LINK_LIKE) {
          expect(pattern.exec(rest)?.[0] ?? null, `${name} ${part} ${String(pattern)}`).toBeNull();
        }
        expect(CONTROL_OR_FORMAT.test(body), `${name} ${part}: control or format character`).toBe(false);
      }
      // Every link in the HTML is one of ours.
      for (const [, href] of message.html.matchAll(/href="([^"]*)"/g)) {
        expect(
          href!.startsWith(`${APP}/`) || (Object.values(ESTATE_LINKS) as string[]).includes(href!),
          `${name}: ${href}`,
        ).toBe(true);
      }
      // Length: a value is capped wherever it lands (the quoted notice has its own, larger cap).
      expect(message.text.length, name).toBeLessThan(name === "contentRemovedCopyright" ? 20_000 : 2_500);
    }
  });

  it("mail a stranger can cause to be sent to somebody else's address carries nothing anyone typed", () => {
    const plain = draftsWith("Ana");
    for (const [, value] of [["a harmless name", "Zoe"], ...CORPUS]) {
      const drafts = draftsWith(value!);
      for (const name of [
        "verification",
        "signupAttempt",
        "passwordReset",
        "newAddressVerification",
      ] as const) {
        expect(render(renderEnv, drafts[name]), `${name}: ${value!.slice(0, 40)}`).toEqual(
          render(renderEnv, plain[name]),
        );
      }
    }
    // The control: a template for the account's owner does change with the name.
    expect(render(renderEnv, draftsWith("Zoe").passwordChanged)).not.toEqual(
      render(renderEnv, plain.passwordChanged),
    );
  });

  it("safeLabel itself: normalised, stripped, neutralised, capped — and the control: the raw value would fail", () => {
    expect(safeLabel("report.final.pdf")).toBe("report·final·pdf");
    expect(safeLabel("Remove it. Now.")).toBe("Remove it. Now.");
    expect(safeLabel("https://evil.example/x")).toBe("https evil·example x");
    expect(safeLabel("a@b.example")).toBe("a at b·example");
    expect(safeLabel("ｅｖｉｌ．ｅｘａｍｐｌｅ")).toBe("evil·example");
    // (a dot that format characters had hidden inside a word is left standing alone)
    expect(safeLabel("evil\u200d.\u200bexample")).toBe("evil . example");
    expect(safeLabel(`a${RTLO}b\r\nc`)).toBe("a b c");
    expect(Array.from(safeLabel("x".repeat(10_000)))).toHaveLength(LABEL_MAX);
    expect(Array.from(safeLabel("😀".repeat(500), 10))).toHaveLength(10);
    // The control for the corpus test: its detector does find these in the values as typed.
    for (const [what, value] of CORPUS.slice(0, 10)) {
      expect(
        LINK_LIKE.some((pattern) => pattern.test(value)),
        what,
      ).toBe(true);
    }
  });
});

// ── (2) budgets ─────────────────────────────────────────────────────────────────────────────

const url = `${APP}/api/auth/verify-email?token=t`;
const resetUrl = `${APP}/api/auth/reset-password/t`;
const anyone = () => ({ client: freshIp() });

describe("every kind of mail has a class, and an unclassified kind cannot be sent", () => {
  it("the table has a row for every template, each with a class AND a severity — and only the five classes", () => {
    expect(Object.keys(KINDS).sort()).toEqual(Object.keys(templates).sort());
    expect(new Set(Object.values(KINDS).map((kind) => kind.class))).toEqual(
      new Set([
        "unauth_triggered",
        "session_action",
        "transactional_user",
        "account_security",
        "operator_alert",
      ]),
    );
    for (const [name, kind] of Object.entries(KINDS)) {
      expect(["critical", "routine"], name).toContain(kind.severity);
      expect(kind.bucket, name).toMatch(/^[a-z-]+$/);
      // Only mail to the operator can be critical.
      if (kind.severity === "critical") expect(kind.class, name).toBe("operator_alert");
    }
    expect(
      Object.entries(KINDS)
        .filter(([, kind]) => kind.severity === "critical")
        .map(([name]) => name),
    ).toEqual(["operatorCritical"]);
    // The operator's mail is never counted with the same mailbox's account notices.
    const operatorBuckets = new Set(
      Object.values(KINDS)
        .filter((kind) => kind.class === "operator_alert")
        .map((kind) => kind.bucket as string),
    );
    for (const kind of Object.values(KINDS)) {
      if (kind.class !== "operator_alert") expect(operatorBuckets.has(kind.bucket)).toBe(false);
    }
    expect(new Set(operatorBuckets).size).toBe(3);
    // What a stranger can cause, by name: nothing else may ever be in this class by accident.
    expect(
      Object.entries(KINDS)
        .filter(([, kind]) => kind.class === "unauth_triggered")
        .map(([name]) => name)
        .sort(),
    ).toEqual(["passwordReset", "signupAttempt", "verification"]);
    for (const name of [
      "passwordChanged",
      "newDeviceSignIn",
      "twoFactorDisabled",
      "accountSuspended",
    ] as const) {
      expect(KINDS[name].class, name).toBe("account_security");
    }
  });

  it("a kind the table does not have is refused — it is not sent uncounted, nor under a default", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    for (const name of ["brandNewKind", "constructor", "toString", "__proto__"]) {
      const outcome = await deliver(deps, name as TemplateName, to, () => templates.passwordChanged({}), {
        system: true,
      });
      expect(outcome, name).toBe("failed");
    }
    expect(mailTo(to)).toEqual([]);
    // The control: the same call under a kind the table has is sent.
    expect(await deliver(deps, "passwordChanged", to, () => templates.passwordChanged({}))).toBe("sent");
  });
});

describe("no class of mail uses up another's count", () => {
  it("a recipient mail-bombed with everything a stranger can cause still gets every security notice", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    // From many addresses: sign-up mail, sign-up notices and reset links until each is refused.
    for (let i = 0; i < EMAIL_CAPS.perHour + 3; i++) {
      await sendVerification(deps, { to, url, by: anyone() });
      await sendSignupAttempt(deps, { to, by: anyone() });
      await sendPasswordReset(deps, { to, url: resetUrl, by: anyone() });
    }
    expect(await sendVerification(deps, { to, url, by: anyone() })).toBe("capped");
    expect(await sendPasswordReset(deps, { to, url: resetUrl, by: anyone() })).toBe("capped");
    expect(mailTo(to)).toHaveLength(EMAIL_CAPS.perHour * 2);
    // The owner's alerts: all of them.
    expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("sent");
    expect(
      await sendNewDeviceSignIn(deps, { to, name: "Ana", country: "NL", uaFamily: "Firefox", at: when }),
    ).toBe("sent");
    expect(await sendTwoFactorDisabled(deps, { to, name: "Ana" })).toBe("sent");
    expect(mailTo(to).filter((mail) => mail.class === "account_security")).toHaveLength(3);
  });

  it("security notices beyond an hour's count are coalesced into ONE digest — never dropped silently", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    for (let i = 1; i <= SECURITY_CAPS.perHour; i++) {
      expect(await sendPasswordChanged(deps, { to, name: "Ana" }), `notice ${i}`).toBe("sent");
    }
    const beyond = [
      await sendPasswordChanged(deps, { to, name: "Ana" }),
      await sendTwoFactorDisabled(deps, { to, name: "Ana" }),
      await sendNewDeviceSignIn(deps, { to, name: "Ana", country: "NL", uaFamily: "Firefox", at: when }),
    ];
    expect(beyond).toEqual(["coalesced", "coalesced", "coalesced"]);
    const digests = mailTo(to, "securityDigest");
    expect(digests).toHaveLength(1);
    expect(digests[0]!.text).toContain("more security activity");
    expect(digests[0]!.text).toContain(`${APP}/account`);
    expect(mailTo(to)).toHaveLength(SECURITY_CAPS.perHour + 1);
  });
});

describe("address variants share one budget", () => {
  it.each([
    ["Victim@Example.com", "victim@example.com"],
    ["victim+1@example.com", "victim@example.com"],
    ["victim+anything+else@example.com", "victim@example.com"],
    ["ＶＩＣＴＩＭ@example.com", "victim@example.com"],
    ["v.i.c.t.i.m@gmail.com", "victim@gmail.com"],
    ["victim+x@googlemail.com", "victim@gmail.com"],
    ["V.ictim+tag@GMail.com", "victim@gmail.com"],
    ["v.ictim@example.com", "v.ictim@example.com"],
    ["victim@sub.example.com", "victim@sub.example.com"],
  ])("%s is counted as %s", async (variant, canonical) => {
    expect(canonicalRecipient(variant)).toBe(canonical);
    expect(await ledgerKey(env, variant, "signup")).toBe(await ledgerKey(env, canonical, "signup"));
  });

  it("five mails spread over five spellings of one mailbox: the sixth is refused, whichever spelling it uses", async () => {
    const { deps } = serviceDeps();
    const local = `v${crypto.randomUUID().slice(0, 8)}`;
    const domain = `${crypto.randomUUID().slice(0, 8)}.holdfast-test.example`;
    const spellings = [
      `${local}@${domain}`,
      `${local.toUpperCase()}@${domain}`,
      `${local}+1@${domain}`,
      `${local}+2@${domain}`,
      `${local}+a.b@${domain.toUpperCase()}`,
    ];
    for (const to of spellings)
      expect(await sendVerification(deps, { to, url, by: anyone() }), to).toBe("sent");
    for (const to of [...spellings, `${local}+fresh@${domain}`]) {
      expect(await sendVerification(deps, { to, url, by: anyone() }), to).toBe("capped");
    }
    // The control: another mailbox is not affected.
    expect(await sendVerification(deps, { to: `other-${local}@${domain}`, url, by: anyone() })).toBe("sent");
  });
});

describe("one client cannot mail-bomb many recipients", () => {
  it("the 11th mail a single client address causes in an hour is refused — to a fresh recipient, of any unauthenticated kind; another client is not affected", async () => {
    const { deps } = serviceDeps();
    const by = { client: freshIp() };
    for (let i = 1; i <= ACTOR_CAPS.perHour; i++) {
      const sent =
        i % 2
          ? sendVerification(deps, { to: freshEmail(), url, by })
          : sendPasswordReset(deps, { to: freshEmail(), url: resetUrl, by });
      expect(await sent, `mail ${i}`).toBe("sent");
    }
    const victim = freshEmail();
    expect(await sendVerification(deps, { to: victim, url, by })).toBe("capped");
    expect(await sendSignupAttempt(deps, { to: victim, by })).toBe("capped");
    expect(await sendPasswordReset(deps, { to: victim, url: resetUrl, by })).toBe("capped");
    expect(mailTo(victim)).toEqual([]);
    // An IPv6 client is its /64, not one address of it.
    const v6 = `2001:db8:${crypto.randomUUID().slice(0, 4)}:1`;
    for (let i = 1; i <= ACTOR_CAPS.perHour; i++) {
      expect(await sendVerification(deps, { to: freshEmail(), url, by: { client: `${v6}::${i}` } })).toBe(
        "sent",
      );
    }
    expect(await sendVerification(deps, { to: freshEmail(), url, by: { client: `${v6}::ffff` } })).toBe(
      "capped",
    );
    // Another client, the same moment, the same recipient: sent.
    expect(await sendVerification(deps, { to: victim, url, by: anyone() })).toBe("sent");
    // … and a security notice to that recipient was never in question.
    expect(await sendPasswordChanged(deps, { to: victim, name: "Ana" })).toBe("sent");
  });

  it("a sender of share invitations is counted too: per sender as well as per recipient", async () => {
    const { deps } = serviceDeps();
    const senderId = crypto.randomUUID();
    const invite = (to: string, from = senderId) =>
      sendShareInvitation(deps, {
        to,
        sharerName: "Ana",
        itemName: "Plans",
        role: "viewer",
        hasAccount: true,
        senderId: from,
      });
    for (let i = 1; i <= SENDER_CAPS.perHour; i++)
      expect(await invite(freshEmail()), `invite ${i}`).toBe("sent");
    const next = freshEmail();
    expect(await invite(next)).toBe("capped");
    expect(await invite(next, crypto.randomUUID())).toBe("sent");
  });
});

describe("when the ledger cannot be reached", () => {
  it("mail a stranger can cause is NOT sent (fail closed); a security notice IS, and the failure is reported (fail open)", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    const broken = vi.mocked(ledger.tryConsume);
    broken.mockRejectedValue(new Error("connection terminated"));
    try {
      expect(await sendVerification(deps, { to, url, by: anyone() })).toBe("failed");
      expect(await sendSignupAttempt(deps, { to, by: anyone() })).toBe("failed");
      expect(await sendPasswordReset(deps, { to, url: resetUrl, by: anyone() })).toBe("failed");
      expect(
        await sendShareInvitation(deps, {
          to,
          sharerName: "Ana",
          itemName: "Plans",
          role: "viewer",
          hasAccount: true,
          senderId: crypto.randomUUID(),
        }),
      ).toBe("failed");
      expect(mailTo(to)).toEqual([]);
      expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("sent");
      expect(mailTo(to).map((mail) => mail.template)).toEqual(["passwordChanged"]);
      expect(broken.mock.calls.length).toBeGreaterThanOrEqual(5);
    } finally {
      broken.mockRestore();
    }
    // The control: with the ledger back, the same mail is sent.
    expect(await sendVerification(deps, { to, url, by: anyone() })).toBe("sent");
    // (the ledger never stores an address)
    const rows = await testDb().execute(
      sql`SELECT recipient_hash FROM email_ledger WHERE recipient_hash LIKE ${`%${to}%`}`,
    );
    expect(rows.rows).toEqual([]);
  });
});

// ── operator alerts ─────────────────────────────────────────────────────────────────────────

// Type level: a critical kind is not a kind that may be coalesced. (`tsc -b` checks this file.)
const coalescible: CoalescibleName[] = ["adminAlert", "passwordChanged", "operatorDigest"];
// @ts-expect-error — the critical alert can never be given to a coalescing path
const notCoalescible: CoalescibleName = "operatorCritical";
void coalescible;
void notCoalescible;

describe("operator alerts", () => {
  const critical = (deps: Parameters<typeof sendOperatorCritical>[0], to: string, id = "node_1") =>
    sendOperatorCritical(deps, { to, event: "csam_lock", id });

  it("with the admin's security count AND the routine operator count both used up, a critical alert goes out at once, in full, every time", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    // The admin mailbox is also an ordinary account: its own security notices, to the cap and over.
    for (let i = 0; i < SECURITY_CAPS.perHour + 3; i++) await sendPasswordChanged(deps, { to, name: "Ana" });
    // … and a flood of routine alerts (abuse reports), to the cap and over.
    for (let i = 0; i < OPERATOR_CAPS.perHour + 5; i++) {
      await sendAdminAlert(deps, { to, kind: "report", id: `rep_${i}`, category: "spam" });
    }
    expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("coalesced");
    expect(await sendAdminAlert(deps, { to, kind: "report", id: "rep_last", category: "spam" })).toBe(
      "coalesced",
    );
    const statementsBefore = vi.mocked(ledger.tryConsume).mock.calls.length;

    for (let i = 1; i <= 40; i++) expect(await critical(deps, to, `node_${i}`), `critical ${i}`).toBe("sent");
    const sent = mailTo(to, "operatorCritical");
    expect(sent).toHaveLength(40);
    expect(sent[0]!.subject).toBe("[dev] Holdfast: CRITICAL — action needed");
    expect(sent[0]!.text).toContain("suspected CSAM");
    expect(sent[39]!.text).toContain("Reference node_40.");
    expect(sent[0]!.text).toContain(`${APP}/admin`);
    // It never asked the ledger anything: there is no count it could be over.
    expect(vi.mocked(ledger.tryConsume).mock.calls.length).toBe(statementsBefore);
    // And no digest of any kind swallowed one.
    for (const mail of [...mailTo(to, "operatorDigest"), ...mailTo(to, "securityDigest")]) {
      expect(mail.text).not.toMatch(/node_\d+/);
      expect(mail.text).not.toContain("CSAM");
    }
  });

  it("every critical event has its own fixed sentence; an id that is not an id is not printed", () => {
    for (const event of [
      "csam_lock",
      "legal_hold",
      "kill_switch",
      "admin_lockout",
      "storage_budget",
      "scanner_down",
    ] as const) {
      const message = render(renderEnv, templates.operatorCritical({ event, adminUrl: `${APP}/admin` }));
      expect(message.subject, event).toBe("[dev] Holdfast: CRITICAL — action needed");
      expect(message.text.length, event).toBeGreaterThan(80);
    }
    const hostile = render(
      renderEnv,
      templates.operatorCritical({
        event: "csam_lock",
        id: "holiday photo.jpg — see evil.example",
        adminUrl: `${APP}/admin`,
      }),
    );
    expect(hostile.text).toContain("Reference unknown.");
    expect(hostile.text).not.toContain("holiday");
    expect(safeId("0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e")).toBe("0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e");
    expect(safeId("a".repeat(65))).toBe("unknown");
  });

  it("the ledger down: a critical alert is sent all the same, and so is a routine one (fail open)", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    const broken = vi.mocked(ledger.tryConsume);
    broken.mockRejectedValue(new Error("connection terminated"));
    try {
      expect(await critical(deps, to)).toBe("sent");
      expect(await sendAdminAlert(deps, { to, kind: "quarantine", id: "node_9" })).toBe("sent");
    } finally {
      broken.mockRestore();
    }
    expect(mailTo(to).map((mail) => mail.template)).toEqual(["operatorCritical", "adminAlert"]);
  });

  it("a transport failure on a critical alert: reported and counted, retried in the deferred work, and delivered", async () => {
    const outbound = testOutbound()!;
    let attempts = 0;
    const delivered: unknown[] = [];
    outbound.answer("api.resend.com", async (request) => {
      attempts += 1;
      // The first send (two tries inside the transport) and the first deferred retry (two more) fail.
      if (attempts <= 4)
        return Response.json(
          { name: "internal_server_error", message: "boom", statusCode: 500 },
          { status: 500 },
        );
      delivered.push(((await request.json()) as { subject: string }).subject);
      return Response.json({ id: "sent" });
    });
    const metrics: Array<Record<string, unknown>> = [];
    const { deps, settle } = serviceDeps({
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test_key",
      METRICS: { writeDataPoint: (point: Record<string, unknown>) => void metrics.push(point) },
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const outcome = await critical(deps, freshEmail());
      expect(outcome).toBe("retrying");
      expect(delivered).toEqual([]);
      await vi.advanceTimersByTimeAsync(CRITICAL_RETRY_WAITS_MS[0] + CRITICAL_RETRY_WAITS_MS[1] + 100);
      vi.useRealTimers();
      await settle();
    } finally {
      vi.useRealTimers();
      outbound.answer("api.resend.com", null);
    }
    expect(delivered).toEqual(["[dev] Holdfast: CRITICAL — action needed"]);
    expect(attempts).toBe(5);
    const outcomes = metrics.map((point) => JSON.stringify(point));
    // Two failures were counted (the first send, the first retry) before the one that got through.
    expect(outcomes.filter((point) => point.includes("critical_failed"))).toHaveLength(2);
    expect(outcomes.some((point) => point.includes("critical_lost"))).toBe(false);
  });

  it("a critical alert that cannot be delivered at all is counted as LOST — the alarm's signal", async () => {
    const outbound = testOutbound()!;
    outbound.answer("api.resend.com", () =>
      Response.json({ name: "x", message: "down", statusCode: 500 }, { status: 500 }),
    );
    const metrics: Array<Record<string, unknown>> = [];
    const { deps, settle } = serviceDeps({
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test_key",
      METRICS: { writeDataPoint: (point: Record<string, unknown>) => void metrics.push(point) },
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      expect(await critical(deps, freshEmail())).toBe("retrying");
      await vi.advanceTimersByTimeAsync(CRITICAL_RETRY_WAITS_MS[0] + CRITICAL_RETRY_WAITS_MS[1] + 100);
      vi.useRealTimers();
      await settle();
    } finally {
      vi.useRealTimers();
      outbound.answer("api.resend.com", null);
    }
    const outcomes = metrics.map((point) => JSON.stringify(point));
    expect(outcomes.filter((point) => point.includes("critical_failed"))).toHaveLength(3);
    expect(outcomes.filter((point) => point.includes("critical_lost"))).toHaveLength(1);
  });

  it("routine alerts over the hour's count are HELD and then listed — count per kind and every id — in one digest; nothing typed is in it", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    for (let i = 1; i <= OPERATOR_CAPS.perHour; i++) {
      expect(await sendAdminAlert(deps, { to, kind: "report", id: `rep_${i}`, category: "spam" })).toBe(
        "sent",
      );
    }
    // Over the count. The first of them finds a digest due: it goes out at once, naming it.
    expect(await sendAdminAlert(deps, { to, kind: "report", id: "rep_over_1", category: "spam" })).toBe(
      "coalesced",
    );
    const first = mailTo(to, "operatorDigest");
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("New abuse report — 1: rep_over_1");
    // The rest of the hour's are held — also one whose "id" is somebody's text.
    expect(await sendAdminAlert(deps, { to, kind: "report", id: "rep_over_2" })).toBe("coalesced");
    expect(await sendAdminAlert(deps, { to, kind: "quarantine", id: "node_7" })).toBe("coalesced");
    expect(await sendAdminAlert(deps, { to, kind: "quarantine", id: "holiday.jpg evil.example" })).toBe(
      "coalesced",
    );
    expect(mailTo(to, "operatorDigest")).toHaveLength(1);
    // The hourly job, before a digest is due again: nothing is sent, nothing is lost.
    expect(await flushOperatorDigests(deps)).toBe(0);
    // An hour later (the digest's own count has moved on): the job sends them — all of them.
    await testDb().execute(sql`
      DELETE FROM email_ledger WHERE recipient_hash = ${await ledgerKey(env, to, KINDS.operatorDigest.bucket)}`);
    expect(await flushOperatorDigests(deps)).toBeGreaterThanOrEqual(1);
    const digests = mailTo(to, "operatorDigest");
    expect(digests).toHaveLength(2);
    const text = digests[1]!.text;
    expect(text).toContain("3 alerts");
    expect(text).toContain("New abuse report — 1: rep_over_2");
    expect(text).toContain("A file was quarantined — 2: node_7, unknown");
    expect(text).toContain(`${APP}/admin`);
    expect(text).not.toContain("holiday");
    expect(digests[1]!.subject).toBe("[dev] Holdfast: items for review (digest)");
    // Nothing is left behind, and a second run sends nothing.
    await testDb().execute(sql`
      DELETE FROM email_ledger WHERE recipient_hash = ${await ledgerKey(env, to, KINDS.operatorDigest.bucket)}`);
    await flushOperatorDigests(deps);
    expect(mailTo(to, "operatorDigest")).toHaveLength(2);
  });

  it("a critical kind handed to the counting path is refused by the run-time guard too", async () => {
    // `deliver` sends a critical kind before any count; this is the guard behind that, asked directly.
    const { deps } = serviceDeps();
    const to = freshEmail();
    expect(
      await deliver(deps, "operatorCritical", to, () =>
        templates.operatorCritical({ event: "kill_switch", adminUrl: `${APP}/admin` }),
      ),
    ).toBe("sent");
    expect(emailSource).toMatch(/if \(row\.severity === "critical"\) return await sendCritical/);
    expect(emailSource).toMatch(/assertCoalescible\(name\);\s+return row\.class === "operator_alert"/);
  });
});
