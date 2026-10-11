// N6 — `POST /api/account/confirm-email` is two steps: the mailbox proof commits (account
// emptied and verified), then the password is set through Better Auth. If the second step fails
// the link is spent and the account has no credential: the answer must SAY what to do next —
// a state the page turns into "request a reset link" — not a bare 5xx.
import { describe, expect, it, vi } from "vitest";
import * as mailboxProof from "../../../src/worker/auth/mailbox-proof";
import {
  accountsOf,
  CAPTCHA,
  linkIn,
  newClient,
  send,
  signIn,
  signUp,
  userByEmail,
  waitForMail,
} from "./helpers";

vi.mock("../../../src/worker/auth/mailbox-proof", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/mailbox-proof")>();
  return { ...real, setFirstPassword: vi.fn(real.setFirstPassword) };
});

const NEW_PASSWORD = "a different long passphrase 7!";

describe("the password step fails after the mailbox proof has committed", () => {
  it.each([
    ["it throws", () => vi.mocked(mailboxProof.setFirstPassword).mockRejectedValueOnce(new Error("boom"))],
    [
      "Better Auth does not answer in time",
      () => vi.mocked(mailboxProof.setFirstPassword).mockResolvedValueOnce(false),
    ],
  ])(
    "%s: 409 'password_not_set' — verified, no credential, and the reset-by-mail path finishes the job",
    async (_what, arrange) => {
      const { email } = await signUp(newClient());
      const link = linkIn(await waitForMail(email, "verification"));
      const token = new URL(link, "http://localhost").searchParams.get("token")!;
      arrange();
      const answer = await send(newClient(), "/api/account/confirm-email", {
        headers: CAPTCHA,
        json: { token, newPassword: NEW_PASSWORD, acceptTerms: true, birthYear: 1990, birthMonth: 5 },
      });
      expect(answer.status, answer.text).toBe(409);
      expect(answer.body).toMatchObject({ error: "conflict", details: { reason: "password_not_set" } });
      const row = (await userByEmail(email))!;
      expect(row.emailVerified).toBe(true);
      expect(await accountsOf(row.id)).toEqual([]);
      // What the page offers next works.
      await send(newClient(), "/api/auth/request-password-reset", {
        json: { email, redirectTo: "/reset-password" },
        headers: CAPTCHA,
      });
      const follow = await send(newClient(), linkIn(await waitForMail(email, "passwordReset")));
      const reset = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
      const set = await send(newClient(), "/api/auth/reset-password", {
        headers: CAPTCHA,
        json: { newPassword: NEW_PASSWORD, token: reset },
      });
      expect(set.status, set.text).toBe(200);
      expect((await signIn(newClient(), email, NEW_PASSWORD)).status).toBe(200);
    },
  );
});
