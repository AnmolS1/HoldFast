// The mail service: what a message is made of when the values in it are hostile, which messages
// are capped and which are never dropped, and the two transports.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testOutbound } from "../../../src/worker/auth/test-outbound";
import { emailLedger } from "../../../src/worker/db/schema";
import {
  clean,
  EMAIL_CAPS,
  emailClassOf,
  escapeHtml,
  ESTATE_LINKS,
  normaliseRecipient,
  recipientHash,
  render,
  sendAccountSuspended,
  sendAdminAlert,
  sendPasswordChanged,
  sendPasswordReset,
  SENDER,
  sendQuarantineNotice,
  sendShareInvitation,
  sendVerification,
  SUPPORT_EMAIL,
  templates,
} from "../../../src/worker/services/email";
import emailSource from "../../../src/worker/services/email.ts?raw";
import {
  auditRows,
  freshEmail,
  getSession,
  linkIn,
  mailTo,
  makeFolder,
  makePendingShare,
  newClient,
  send,
  serviceDeps,
  shareById,
  signIn,
  testDb,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
} from "./helpers";

const RTLO = "\u202e";
const HOSTILE = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  `invoice${RTLO}gpj.exe`,
  "Bob\r\nBcc: evil@evil.example\r\n\r\n<b>injected</b>",
  '</p></div><a href="https://evil.example">click</a>',
  "x".repeat(5000),
  "\u0000\u0007\u001b[31mred",
  "a\u200bb\u2066c\u2069",
];
// eslint-disable-next-line no-control-regex -- control and format characters are exactly what is looked for
const CONTROL_OR_FORMAT = /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const APP = "http://localhost";
const renderEnv = { APP_ORIGIN: APP, SENTRY_ENVIRONMENT: "test" };

/** One draft per template, with `value` in every field a person could have typed. */
function draftsWith(value: string) {
  const when = new Date("2026-10-16T09:30:00Z");
  return {
    verification: templates.verification({ name: value, url: `${APP}/api/auth/verify-email?token=t` }),
    signupAttempt: templates.signupAttempt({ name: value, loginUrl: `${APP}/login` }),
    verificationResend: templates.verification({
      name: value,
      url: `${APP}/api/auth/verify-email?token=t`,
      resend: true,
    }),
    newAddressVerification: templates.newAddressVerification({
      name: value,
      url: `${APP}/api/auth/verify-email?token=t`,
    }),
    passwordReset: templates.passwordReset({ name: value, url: `${APP}/api/auth/reset-password/t` }),
    changeEmailConfirmation: templates.changeEmailConfirmation({
      name: value,
      newEmail: value,
      url: `${APP}/x`,
    }),
    deleteAccountVerification: templates.deleteAccountVerification({ name: value, url: `${APP}/x` }),
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
    shareInvitation: templates.shareInvitation({
      sharerName: value,
      itemName: value,
      role: "viewer",
      hasAccount: true,
      url: `${APP}/shared`,
    }),
    shareInvitationNoAccount: templates.shareInvitation({
      sharerName: value,
      itemName: value,
      role: "editor",
      hasAccount: false,
      url: `${APP}/signup`,
    }),
    quarantineNotice: templates.quarantineNotice({ name: value, fileName: value }),
    uploadNotIntact: templates.uploadNotIntact({ name: value, fileName: value }),
    linkPaused: templates.linkPaused({ name: value, itemName: value }),
    linkAvailableAgain: templates.linkAvailableAgain({ name: value, itemName: value }),
    adminDigest: templates.adminDigest({ lines: [{ label: value, value }], adminUrl: `${APP}/admin` }),
    adminAlert: templates.adminAlert({
      kind: "report",
      reportId: value,
      category: value,
      adminUrl: `${APP}/admin`,
    }),
    adminAlertCsam: templates.adminAlert({
      kind: "csam_lock",
      reportId: value,
      category: value,
      adminUrl: `${APP}/admin`,
    }),
    reportReviewed: templates.reportReviewed(),
    contentRemovedCopyright: templates.contentRemovedCopyright({
      name: value,
      itemName: value,
      noticeText: `${value}\nline two\r\nline three`,
      counterNoticeUrl: `${APP}/dmca`,
    }),
    contentRestored: templates.contentRestored({ name: value, itemName: value }),
  };
}

describe("templates", () => {
  it("every template named in the plan exists, and there is no link-digest template", () => {
    const names = Object.keys(templates).sort();
    expect(names).toEqual(
      [
        "verification",
        // Not in the plan's list: the notice an address's owner gets when somebody tries to
        // sign up with it (the enumeration-safe answer to a duplicate sign-up).
        "signupAttempt",
        "newAddressVerification",
        "passwordReset",
        "changeEmailConfirmation",
        "deleteAccountVerification",
        "deletionScheduled",
        "deletionCancelled",
        "passwordChanged",
        "twoFactorEnabled",
        "twoFactorDisabled",
        // Not in the plan's list: sent when the account's two-factor attempt budget is spent
        // (auth/second-factor.ts) — a lock nobody is told about is a silent denial of service.
        "secondFactorLocked",
        "signInMethodAdded",
        "passkeyAdded",
        "passkeyRemoved",
        "newDeviceSignIn",
        "accountSuspended",
        "shareInvitation",
        "quarantineNotice",
        "uploadNotIntact",
        "linkPaused",
        "linkAvailableAgain",
        "adminDigest",
        "adminAlert",
        "reportReviewed",
        "contentRemovedCopyright",
        "contentRestored",
      ].sort(),
    );
    expect(names.filter((name) => /weekly|linkDigest/i.test(name))).toEqual([]);
    expect(emailSource).not.toMatch(/weekly|link digest|emailLinkDigest/i);
    // Every draft built for the hostile-value test below covers every template.
    const covered = new Set(
      Object.keys(draftsWith("x")).map((key) => key.replace(/(Resend|NoAccount|Csam)$/, "")),
    );
    expect([...covered].sort()).toEqual(names);
  });

  it.each(HOSTILE.map((value, index) => [index, value] as const))(
    "hostile value #%i cannot become markup, a header, or a direction override — in any template",
    (_index, value) => {
      for (const [name, draft] of Object.entries(draftsWith(value))) {
        const message = render(renderEnv, draft);
        // A plain-text part, always.
        expect(message.text.length, name).toBeGreaterThan(20);
        // The subject is a constant: nothing a person typed, and one line.
        expect(message.subject, name).not.toMatch(/[\r\n]/);
        expect(message.subject, name).toBe(`[dev] ${draft.subject}`);
        expect(draft.subject.includes(value.slice(0, 12)), name).toBe(false);
        for (const part of [message.text, message.html, message.subject]) {
          // No control or format character survives (CR/LF only as our own paragraph breaks).
          expect(CONTROL_OR_FORMAT.test(part), name).toBe(false);
          expect(part.includes("\r"), name).toBe(false);
        }
        // No markup from a value: every "<" in the HTML is one of ours.
        const tags = [...message.html.matchAll(/<\/?([a-zA-Z0-9!]+)/g)].map((m) => m[1]!.toLowerCase());
        for (const tag of tags) {
          expect(
            ["!doctype", "html", "head", "meta", "title", "body", "div", "h1", "p", "a", "blockquote"],
            `${name}: <${tag}>`,
          ).toContain(tag);
        }
        expect(message.html, name).not.toMatch(/<script|<img|<b>|<[^>]*\sonerror=/i);
        // Every link is ours.
        const hrefs = [...message.html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
        for (const href of hrefs) {
          const allowedLink =
            href.startsWith(`${APP}/`) || (Object.values(ESTATE_LINKS) as string[]).includes(href);
          expect(allowedLink, `${name}: ${href}`).toBe(true);
        }
        expect(message.html, name).not.toContain('evil.example"');
        // A "Bcc:" smuggled in a name is, at most, words in a paragraph.
        expect(
          message.text.split("\n").some((line) => /^bcc:/i.test(line.trim())),
          name,
        ).toBe(false);
      }
    },
  );

  it("escapes and cleans the way the tests above rely on", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
    expect(clean("a\r\nb\tc")).toBe("a b c");
    expect(clean(`x${RTLO}y`)).toBe("x y");
    expect(clean("x".repeat(500)).length).toBe(200);
    expect(clean(null)).toBe("");
    expect(clean(42)).toBe("42");
  });

  it("the admin alert carries the report id and category — it has no field for a file name", () => {
    const alert = render(
      renderEnv,
      templates.adminAlert({
        kind: "csam_lock",
        reportId: "rep_123",
        category: "csam",
        adminUrl: `${APP}/admin`,
      }),
    );
    expect(alert.text).toContain("rep_123");
    expect(alert.text).toContain("category csam");
    expect(alert.text).not.toMatch(/\.(jpg|png|pdf|zip)/i);
    expect(emailClassOf("adminAlert")).toBe("security");
  });

  it("the copyright notice quotes the notice and gives the counter-notice instructions", () => {
    const message = render(
      renderEnv,
      templates.contentRemovedCopyright({
        name: "Ana",
        itemName: "song.mp3",
        noticeText: "I own this.\nRemove it.",
        counterNoticeUrl: `${APP}/dmca`,
      }),
    );
    expect(message.text).toContain("> I own this.\n> Remove it.");
    expect(message.text).toContain("counter-notice");
    expect(message.text).toContain(`${APP}/dmca`);
  });

  it("the subject is prefixed [dev] everywhere but production", () => {
    const draft = templates.passwordChanged({ name: "Ana" });
    expect(render({ APP_ORIGIN: APP, SENTRY_ENVIRONMENT: "dev" }, draft).subject).toBe(
      "[dev] Your password was changed",
    );
    expect(render({ APP_ORIGIN: APP, SENTRY_ENVIRONMENT: "production" }, draft).subject).toBe(
      "Your password was changed",
    );
  });

  it("a link that is not under APP_ORIGIN is refused: the message is not sent at all", async () => {
    const { deps, settle } = serviceDeps();
    const to = freshEmail();
    for (const url of [
      "https://evil.example/verify?token=t",
      "http://localhost.evil.example/x",
      "javascript:alert(1)",
      "http://localhost",
      "http://localhost/a b",
    ]) {
      expect(await sendVerification(deps, { to, name: "Ana", url }), url).toBe("failed");
    }
    await settle();
    expect(mailTo(to)).toEqual([]);
    expect(SUPPORT_EMAIL).toBe("support@holdfast.ponderance.dev");
  });

  it("a recipient that is not one plain address is refused", async () => {
    const { deps } = serviceDeps();
    for (const to of [
      "a@b.example\r\nBcc: evil@evil.example",
      "a@b.example, c@d.example",
      "Name <a@b.example>",
      "not-an-address",
      "",
    ]) {
      expect(normaliseRecipient(to), to).toBeNull();
      expect(await sendPasswordChanged(deps, { to, name: "x" }), to).toBe("failed");
    }
    expect(normaliseRecipient(" Ana@Example.COM ")).toBe("ana@example.com");
  });
});

describe("caps", () => {
  it("the 6th auth-class mail to one recipient in an hour is skipped; a security notice still goes", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    const url = `${APP}/api/auth/verify-email?token=t`;
    for (let i = 1; i <= EMAIL_CAPS.perHour; i++) {
      expect(await sendVerification(deps, { to, name: "Ana", url }), `mail ${i}`).toBe("sent");
    }
    expect(await sendVerification(deps, { to, name: "Ana", url })).toBe("capped");
    // Another auth-class template shares the cap; so does a product-class one.
    expect(await sendPasswordReset(deps, { to, name: "Ana", url: `${APP}/api/auth/reset-password/t` })).toBe(
      "capped",
    );
    expect(await sendQuarantineNotice(deps, { to, name: "Ana", fileName: "a.exe" })).toBe("capped");
    expect(mailTo(to)).toHaveLength(5);
    // Security notices are never dropped — and do not count against the cap either.
    expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("sent");
    expect(await sendAccountSuspended(deps, { to, name: "Ana" })).toBe("sent");
    expect(await sendAdminAlert(deps, { to, kind: "report", reportId: "r1", category: "spam" })).toBe("sent");
    expect(mailTo(to)).toHaveLength(8);
    // Another recipient is not affected.
    expect(await sendVerification(deps, { to: freshEmail(), name: "Bo", url })).toBe("sent");
  });

  it("the daily cap is 50, counted per recipient under a keyed hash (never the address)", async () => {
    const { deps } = serviceDeps();
    const to = freshEmail();
    const hash = await recipientHash(env, to.toUpperCase());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await recipientHash(env, to));
    // 50 already sent today, none in this hour.
    await testDb().execute(sql`
      INSERT INTO email_ledger (window_kind, window_start, recipient_hash, count)
      VALUES ('day', date_trunc('day', now(), 'UTC'), ${hash}, ${EMAIL_CAPS.perDay})`);
    expect(
      await sendShareInvitation(deps, {
        to,
        sharerName: "Ana",
        itemName: "Plans",
        role: "viewer",
        hasAccount: true,
      }),
    ).toBe("capped");
    expect(mailTo(to)).toEqual([]);
    expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("sent");
    // The ledger holds the hash, and the address appears nowhere in it.
    const rows = await testDb().select().from(emailLedger).where(eq(emailLedger.recipientHash, hash));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(to);
  });
});

describe("the Resend transport", () => {
  it("sends from the verified sender with the API key, retries a failure once under the same idempotency key, and never throws", async () => {
    const outbound = testOutbound()!;
    const seen: Array<{ auth: string | null; key: string | null; body: Record<string, unknown> }> = [];
    let failures = 1;
    outbound.answer("api.resend.com", async (request) => {
      seen.push({
        auth: request.headers.get("authorization"),
        key: request.headers.get("idempotency-key"),
        body: (await request.json()) as Record<string, unknown>,
      });
      if (failures-- > 0)
        return Response.json(
          { name: "internal_server_error", message: "boom", statusCode: 500 },
          { status: 500 },
        );
      return Response.json({ id: "sent-1" });
    });
    try {
      const { deps } = serviceDeps({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_test_key" });
      const to = freshEmail();
      expect(await sendPasswordChanged(deps, { to, name: "<b>Ana</b>" })).toBe("sent");
      expect(seen).toHaveLength(2);
      expect(seen[0]!.auth).toBe("Bearer re_test_key");
      expect(seen[0]!.key).toBeTruthy();
      expect(seen[1]!.key).toBe(seen[0]!.key);
      expect(seen[1]!.body).toMatchObject({ from: SENDER, to, subject: "[dev] Your password was changed" });
      expect(String(seen[1]!.body.html)).toContain("&lt;b&gt;Ana&lt;/b&gt;");
      expect(String(seen[1]!.body.text)).toContain("Hello <b>Ana</b>,");
      // Nothing went to the memory outbox on this transport.
      expect(mailTo(to)).toEqual([]);

      // Two failures: reported as failed, not thrown.
      failures = 2;
      seen.length = 0;
      expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("failed");
      expect(seen).toHaveLength(2);
      // A network error is the same.
      outbound.answer("api.resend.com", () => {
        throw new Error("socket hang up");
      });
      expect(await sendPasswordChanged(deps, { to, name: "Ana" })).toBe("failed");
    } finally {
      outbound.answer("api.resend.com", null);
    }
  });
});

describe("changing the address of a verified account", () => {
  it("asks the CURRENT address first, then verifies the NEW one, then changes it — and waiting shares activate", async () => {
    const { client, user: row, email } = await verifiedUser();
    const owner = await verifiedUser();
    const newEmail = freshEmail();
    const share = await makePendingShare((await makeFolder(owner.user.id)).id, owner.user.id, newEmail);

    const asked = await send(client, "/api/auth/change-email", {
      json: { newEmail, callbackURL: "/account" },
    });
    expect(asked.status, asked.text).toBe(200);
    // Step 1: only the current address hears about it.
    const confirm = await waitForMail(email, "changeEmailConfirmation");
    expect(confirm.text).toContain(newEmail);
    expect(mailTo(newEmail)).toEqual([]);
    expect((await userById(row.id))!.email).toBe(email);

    // Step 2: confirming there sends the verification to the new address. Still unchanged.
    expect((await send(client, linkIn(confirm))).status).toBe(302);
    const verify = await waitForMail(newEmail, "newAddressVerification");
    expect((await userById(row.id))!.email).toBe(email);
    expect((await shareById(share.id))!.granteeUserId).toBeNull();

    // Step 3: following that link changes the address, verified.
    expect((await send(client, linkIn(verify))).status).toBe(302);
    const after = await userById(row.id);
    expect(after!.email).toBe(newEmail);
    expect(after!.emailVerified).toBe(true);
    expect((await getSession(client))?.user.email).toBe(newEmail);
    expect(await auditRows({ action: "auth.email_changed", targetId: row.id })).toHaveLength(1);
    // The share that was waiting for the new address is now this user's.
    expect((await shareById(share.id))!.granteeUserId).toBe(row.id);
    // The old address no longer signs in; the new one does.
    expect((await signIn(newClient(), email)).status).toBe(401);
    expect((await signIn(newClient(), newEmail)).status).toBe(200);
  });

  it("to an address that already has an account: the same answer and the same mail to the CALLER; the address's owner is not mailed", async () => {
    const { client, user: row, email } = await verifiedUser();
    const other = await verifiedUser();
    const before = mailTo(other.email).length;
    const asked = await send(client, "/api/auth/change-email", { json: { newEmail: other.email } });
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ status: true });
    // The caller's own inbox must not say whether the address is taken: it gets the same
    // confirmation as for a free one (tests/unit/auth/mailbox-proof.test.ts, A7).
    await waitForMail(email, "changeEmailConfirmation");
    expect(mailTo(other.email)).toHaveLength(before);
    expect((await userById(row.id))!.email).toBe(email);
    expect((await userByEmail(other.email))!.id).toBe(other.user.id);
  });
});
