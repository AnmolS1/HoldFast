// The security mail behind each action of the account page — through the same endpoints the page
// calls (T06 builds the mail; this asserts that the page's paths reach it) — and that a held
// account receives exactly the same mail. Passkey added / removed need a real authenticator: they
// are asserted in tests/e2e/account.spec.ts with the browser's virtual one.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { user } from "../../../src/worker/db/schema";
import {
  CAPTCHA,
  enableTotp,
  linkIn,
  mailTo,
  newClient,
  PASSWORD,
  send,
  testDb,
  verifiedUser,
  waitForMail,
} from "../auth/helpers";

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** Made up for this test, like every password here. */
const NEW_PASSWORD = "another made-up passphrase 7";

/** Every action of the account page that mails, in order; answers the templates the address got. */
async function everyAction(legalHold: boolean) {
  const first = newClient({ headers: { "user-agent": FIREFOX_LINUX }, cf: { country: "FR" } });
  const { client, email, user: row } = await verifiedUser({ name: "Same Name" }, first);
  if (legalHold) await testDb().update(user).set({ legalHold: true }).where(eq(user.id, row.id));

  // A sign-in from a browser and country the account has not used.
  const other = newClient({ headers: { "user-agent": CHROME_MAC }, cf: { country: "DE" } });
  expect(
    (await send(other, "/api/auth/sign-in/email", { json: { email, password: PASSWORD }, headers: CAPTCHA }))
      .status,
  ).toBe(200);
  await waitForMail(email, "newDeviceSignIn");

  // Security → Password.
  const changed = await send(client, "/api/auth/change-password", {
    json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false },
  });
  expect(changed.status, changed.text).toBe(200);
  await waitForMail(email, "passwordChanged");

  // Security → Two-factor on, then off (this session proved the password: it may).
  await enableTotp(client, NEW_PASSWORD);
  await waitForMail(email, "twoFactorEnabled");
  const off = await send(client, "/api/auth/two-factor/disable", { json: { password: NEW_PASSWORD } });
  expect(off.status, off.text).toBe(200);
  await waitForMail(email, "twoFactorDisabled");

  // Profile → Change email (the confirmation goes to the current address).
  const asked = await send(client, "/api/auth/change-email", {
    json: { newEmail: `n${email}`, callbackURL: "/account", password: NEW_PASSWORD },
  });
  expect(asked.status, asked.text).toBe(200);
  await waitForMail(email, "changeEmailConfirmation");

  // Your data → Delete account, the link, then Cancel.
  expect((await send(client, "/api/auth/delete-user", { json: {} })).status).toBe(200);
  const link = linkIn(await waitForMail(email, "deleteAccountVerification"));
  expect((await send(client, link)).status).toBe(302);
  await waitForMail(email, "deletionScheduled");
  expect((await send(client, "/api/account/deletion/cancel", { method: "POST" })).status).toBe(200);
  await waitForMail(email, "deletionCancelled");

  return mailTo(email).map((mail) => mail.template);
}

describe("security mail from the account page's actions", () => {
  it("each action mails its notice; a held account gets exactly the same mail", async () => {
    const free = await everyAction(false);
    expect(free).toEqual(
      expect.arrayContaining([
        "newDeviceSignIn",
        "passwordChanged",
        "twoFactorEnabled",
        "twoFactorDisabled",
        "changeEmailConfirmation",
        "deletionScheduled",
        "deletionCancelled",
      ]),
    );
    const held = await everyAction(true);
    expect(held).toEqual(free);
  });
});
