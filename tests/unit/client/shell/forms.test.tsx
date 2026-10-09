// Auth forms: sign-up validation, the resend cooldown, and what each screen sends.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authClient } from "../../../../src/client/lib/auth-client";
import { buildRoutes } from "../../../../src/client/router";
import {
  isThirteenOrOlder,
  passwordStrength,
  validateSignup,
  type SignupValues,
} from "../../../../src/client/routes/auth/validation";
import { RESEND_COOLDOWN_S } from "../../../../src/client/routes/auth/VerifyEmail";
import { redirectErrorMessage, takeRedirectError } from "../../../../src/client/routes/auth/errors";
import { en } from "../../../../src/client/lib/en";
import { isThirteenOrOlder as sharedIsThirteenOrOlder } from "../../../../src/shared/age";
import { envelope, json, renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const NOW = new Date("2026-10-08T12:00:00Z");
const valid: SignupValues = {
  name: "Ada",
  email: "ada@example.com",
  password: "correct horse battery",
  inviteCode: "HF-7K2Q",
  birthMonth: "5",
  birthYear: "1990",
  acceptTerms: true,
};
const check = (patch: Partial<SignupValues>, inviteRequired = true) =>
  validateSignup({ ...valid, ...patch }, { inviteRequired, now: NOW });

describe("sign-up validation (pure)", () => {
  it("a complete form has no errors", () => {
    expect(check({})).toEqual({});
  });

  const table: Array<[string, Partial<SignupValues>, string, string]> = [
    ["no name", { name: "  " }, "name", "signup.error.name"],
    ["a malformed email", { email: "ada@" }, "email", "signup.error.email"],
    ["an email with a space", { email: "a da@example.com" }, "email", "signup.error.email"],
    ["an 11-character password", { password: "elevenchars" }, "password", "signup.error.password"],
    ["a 129-character password", { password: "x".repeat(129) }, "password", "signup.error.passwordLong"],
    ["no invite code in invite mode", { inviteCode: "" }, "inviteCode", "signup.error.invite"],
    ["no birth month", { birthMonth: "" }, "birth", "signup.error.birth"],
    ["month 13", { birthMonth: "13" }, "birth", "signup.error.birth"],
    ["a two-digit year", { birthYear: "90" }, "birth", "signup.error.birth"],
    ["a year in the future", { birthYear: "2031" }, "birth", "signup.error.birth"],
    ["twelve years old", { birthYear: "2014", birthMonth: "6" }, "birth", "signup.error.age"],
    ["thirteen next month", { birthYear: "2013", birthMonth: "11" }, "birth", "signup.error.age"],
    ["terms not accepted", { acceptTerms: false }, "acceptTerms", "signup.error.assent"],
  ];
  it.each(table)("%s → %s: %s", (_name, patch, field, key) => {
    expect(check(patch)).toEqual({ [field]: key });
  });

  it("exactly 12 and exactly 128 characters are accepted", () => {
    expect(check({ password: "x".repeat(12) })).toEqual({});
    expect(check({ password: "x".repeat(128) })).toEqual({});
  });

  it("the invite code is not asked for in open mode", () => {
    expect(check({ inviteCode: "" }, false)).toEqual({});
  });

  // The form's age rule IS the server's (src/shared/age.ts). It used to accept the birth month
  // itself, which the server refuses: a person turning thirteen this month passed the form and
  // was turned away after submitting it.
  it("the age rule is the server's own function: whole months, strictly, in UTC", () => {
    const table: Array<[string, number, number, string, boolean]> = [
      ["13 years and 1 month", 2013, 9, "2026-10-08T12:00:00Z", true],
      ["thirteen THIS month — the birthday may not have come yet", 2013, 10, "2026-10-08T12:00:00Z", false],
      ["thirteen next month", 2013, 11, "2026-10-08T12:00:00Z", false],
      ["12 years and 11 months, born in December", 2013, 12, "2026-11-30T23:59:59Z", false],
      ["the December-to-January boundary: 13 years exactly", 2012, 12, "2025-12-01T00:00:00Z", false],
      ["one month on, in January", 2012, 12, "2026-01-01T00:00:00Z", true],
      ["born in January, asked in January of the 13th year", 2013, 1, "2026-01-31T12:00:00Z", false],
      ["born in January, asked in February", 2013, 1, "2026-02-01T00:00:00Z", true],
      // The month is read in UTC: 23:30 on the 31st in New York is already the next month.
      ["the last second of the birth month, UTC", 2013, 9, "2026-09-30T23:59:59Z", false],
      ["the first second of the next month, UTC", 2013, 9, "2026-10-01T00:00:00Z", true],
      ["an adult", 1990, 5, "2026-10-08T12:00:00Z", true],
      ["born this year", 2026, 10, "2026-10-08T12:00:00Z", false],
      ["born in the future", 2027, 1, "2026-10-08T12:00:00Z", false],
      ["before 1900", 1899, 12, "2026-10-08T12:00:00Z", false],
      ["month 0", 2000, 0, "2026-10-08T12:00:00Z", false],
      ["month 13", 2000, 13, "2026-10-08T12:00:00Z", false],
      ["a fractional year", 2000.5, 5, "2026-10-08T12:00:00Z", false],
    ];
    for (const [name, year, month, at, expected] of table) {
      const now = new Date(at);
      expect(isThirteenOrOlder(year, month, now), name).toBe(expected);
      // One function, not two that agree today. (That the SERVER uses this same function is
      // tests/unit/auth/signup-policy.test.ts, with this same table.)
      expect(isThirteenOrOlder(year, month, now), name).toBe(sharedIsThirteenOrOlder(year, month, now));
    }
    // Through the form's validation: the birth month itself is refused with the neutral sentence.
    expect(check({ birthYear: "2013", birthMonth: "10" })).toEqual({ birth: "signup.error.age" });
    expect(check({ birthYear: "2013", birthMonth: "9" })).toEqual({});
  });

  it("password strength: length carries most of the weight", () => {
    expect(passwordStrength("short")).toBe(0);
    expect(passwordStrength("aaaaaaaaaaaa")).toBe(1);
    expect(passwordStrength("aaaaaaaaaaaaaaaa")).toBe(2);
    expect(passwordStrength("correct horse battery staple 9!")).toBe(4);
  });
});

function field(name: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

async function openSignup(config = {}) {
  shellFetch({ session: null, config });
  const view = renderRoutes(buildRoutes(), ["/signup"]);
  await screen.findByRole("heading", { name: "Create your account" });
  return view;
}

function fill(
  values: Partial<Record<"inviteCode" | "name" | "email" | "password" | "birthMonth" | "birthYear", string>>,
) {
  for (const [name, value] of Object.entries(values)) fireEvent.change(field(name), { target: { value } });
}

describe("sign-up screen", () => {
  it("has every field the policy needs, with the age note and the terms links", async () => {
    await openSignup();
    for (const name of ["inviteCode", "name", "email", "password", "birthMonth", "birthYear", "acceptTerms"])
      expect(field(name), name).not.toBeNull();
    expect(screen.getByText("Used once to check you're 13 or older; we don't keep it.")).toBeTruthy();
    const assent = field("acceptTerms").closest("label")!;
    expect(Array.from(assent.querySelectorAll("a"), (a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Terms", "https://ponderance.dev/terms"],
      ["Privacy Policy", "https://ponderance.dev/privacy"],
    ]);
    expect(field("acceptTerms").checked).toBe(false);
    expect(field("password").autocomplete).toBe("new-password");
  });

  it("an empty submit shows every error and calls nothing", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email");
    await openSignup();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const alerts = (await screen.findAllByRole("alert")).map((node) => node.textContent);
    expect(alerts).toEqual(
      expect.arrayContaining([
        "Enter your invite code.",
        "Enter your name.",
        "Enter a valid email address.",
        "Use 12 characters or more.",
        "Enter the month (1–12) and a four-digit year.",
        "You need to accept the Terms and Privacy Policy.",
      ]),
    );
    expect(signUp).not.toHaveBeenCalled();
  });

  it.each([
    ["terms not accepted", {}, false],
    ["an 11-character password", { password: "elevenchars" }, true],
    ["a malformed email", { email: "ada@" }, true],
    ["no invite code", { inviteCode: "" }, true],
    ["under thirteen", { birthYear: "2020" }, true],
  ] as const)("a form that is complete except for %s is not submitted", async (_name, patch, accept) => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    const { router } = await openSignup();
    fill({
      inviteCode: "HF-7K2Q",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse battery",
      birthMonth: "5",
      birthYear: "1990",
      ...patch,
    });
    if (accept) fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signUp).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/signup");
  });

  it("a valid form calls signUp.email with the policy fields and goes to /verify-email", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    const { router } = await openSignup();
    fill({
      inviteCode: "HF-7K2Q",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse battery",
      birthMonth: "5",
      birthYear: "1990",
    });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/verify-email"));
    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Ada",
        email: "ada@example.com",
        password: "correct horse battery",
        inviteCode: "HF-7K2Q",
        birthYear: 1990,
        birthMonth: 5,
        acceptTerms: true,
      }),
    );
    expect((await screen.findByText("ada@example.com")).getAttribute("data-verify-email")).not.toBeNull();
    // The address travels in router state, not in the URL.
    expect(router.state.location.search).toBe("");
  });

  it("open sign-up mode has no invite field and sends no code", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    await openSignup({ signupMode: "open" });
    expect(field("inviteCode")).toBeNull();
    fill({
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse battery",
      birthMonth: "5",
      birthYear: "1990",
    });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(signUp).toHaveBeenCalled());
    expect(signUp.mock.calls[0]![0].inviteCode).toBeUndefined();
  });

  it("a breached password is reported under the password field", async () => {
    vi.spyOn(authClient.signUp, "email").mockResolvedValue({
      data: null,
      error: { status: 400, statusText: "", code: "PASSWORD_COMPROMISED", message: "x" },
    });
    await openSignup();
    fill({
      inviteCode: "HF",
      name: "Ada",
      email: "ada@example.com",
      password: "password123456",
      birthMonth: "5",
      birthYear: "1990",
    });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("This password appears in a known breach. Choose another.")).toBeTruthy();
  });

  it("the server's refusal sentence is shown as it is", async () => {
    vi.spyOn(authClient.signUp, "email").mockResolvedValue({
      data: null,
      error: { status: 403, statusText: "", message: "This invite can't be used." },
    });
    await openSignup();
    fill({
      inviteCode: "HF",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse battery",
      birthMonth: "5",
      birthYear: "1990",
    });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("This invite can't be used.")).toBeTruthy();
  });

  it("Google: the intent (invite, age, assent) is posted first, then the OAuth start", async () => {
    const order: string[] = [];
    const social = vi.spyOn(authClient.signIn, "social").mockImplementation(async () => {
      order.push("social");
      return { data: {}, error: null };
    });
    const calls = shellFetch({
      session: null,
      extra: (call) => {
        if (call.path === "/api/auth-intent") {
          order.push("intent");
          return json({ ok: true });
        }
        return undefined;
      },
    });
    renderRoutes(buildRoutes(), ["/signup"]);
    await screen.findByRole("heading", { name: "Create your account" });
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(social).not.toHaveBeenCalled();
    expect(calls.some((call) => call.path === "/api/auth-intent")).toBe(false);
    fill({ inviteCode: "HF-7K2Q", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(order).toEqual(["intent", "social"]));
    expect(calls.find((call) => call.path === "/api/auth-intent")?.body).toEqual({
      inviteCode: "HF-7K2Q",
      birthYear: 1990,
      birthMonth: 5,
      acceptTerms: true,
    });
    expect(social).toHaveBeenCalledWith(expect.objectContaining({ provider: "google" }));
  });

  it("a refused intent does not start OAuth", async () => {
    const social = vi.spyOn(authClient.signIn, "social");
    shellFetch({
      session: null,
      extra: (call) => (call.path === "/api/auth-intent" ? envelope("forbidden", 403) : undefined),
    });
    renderRoutes(buildRoutes(), ["/signup"]);
    await screen.findByRole("heading", { name: "Create your account" });
    fill({ inviteCode: "HF", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByText("forbidden message")).toBeTruthy();
    expect(social).not.toHaveBeenCalled();
  });

  it("/invite/:code checks the code and prefills it", async () => {
    shellFetch({
      session: null,
      extra: (call) => (call.path === "/api/invites/HF-GOOD" ? json({ valid: true }) : undefined),
    });
    const { router } = renderRoutes(buildRoutes(), ["/invite/HF-GOOD"]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup"));
    await waitFor(() => expect(field("inviteCode")?.value).toBe("HF-GOOD"));
    expect(screen.getByText("This invite is valid.")).toBeTruthy();
  });

  it("an invalid invite says so, without a reason", async () => {
    shellFetch({
      session: null,
      extra: (call) => (call.path.startsWith("/api/invites/") ? json({ valid: false }) : undefined),
    });
    renderRoutes(buildRoutes(), ["/invite/HF-BAD"]);
    expect(
      await screen.findByText("This invite can't be used. Check the code or ask for a new one."),
    ).toBeTruthy();
  });
});

describe("sign-in screen", () => {
  it("passkey first, then password, then Google; the email field offers passkeys", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    const order = screen.getAllByRole("button").map((button) => button.textContent);
    expect(order).toEqual(["Continue with passkey", "Sign in", "Continue with Google"]);
    expect(field("email").autocomplete).toBe("username webauthn");
  });

  it("a wrong password shows an error on the form and never opens the re-auth modal", async () => {
    vi.spyOn(authClient.signIn, "email").mockResolvedValue({
      data: null,
      error: { status: 401, statusText: "Unauthorized" },
    });
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "nope" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong email or password.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("when the auth endpoint cannot be reached the screen says so, generically", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "anything" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That didn't work. Try again.");
  });

  it("a second factor sends the user to /two-factor with next kept", async () => {
    vi.spyOn(authClient.signIn, "email").mockResolvedValue({
      data: { twoFactorRedirect: true },
      error: null,
    });
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/login?next=/recent"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "correct horse battery" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/two-factor"));
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/recent");
    // The router's location moves before React has drawn the new screen (the router hands its
    // state to React as a transition). Wait for the screen itself before touching its fields.
    await screen.findByRole("heading", { name: "Enter your code" });
    const verify = vi.spyOn(authClient.twoFactor, "verifyTotp").mockResolvedValue({ data: {}, error: null });
    fireEvent.change(field("code"), { target: { value: "123 456" } });
    fireEvent.click(field("trustDevice"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith({ code: "123456", trustDevice: true }));
  });

  it("/login?reason=suspended shows the notice", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login?reason=suspended"]);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      "This account is suspended. Contact support.",
    );
  });

  it("there is no /confirm-deletion screen", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/confirm-deletion"]);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("verify-email screen", () => {
  async function open() {
    const calls = shellFetch({
      session: sessionOf({ emailVerified: false, email: "ada@example.com" }),
      extra: (call) => (call.path === "/api/account/pending-email" ? json({ ok: true }) : undefined),
    });
    renderRoutes(buildRoutes(), ["/verify-email"]);
    await screen.findByRole("heading", { name: "Check your email" });
    // Under fake timers React's passive effects wait for the scheduler: flush them.
    await act(async () => {});
    return calls;
  }
  const resend = () => document.querySelector<HTMLButtonElement>("[data-resend]")!;

  it("resend is locked for 60 s, counts down, then sends and locks again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const send = vi.spyOn(authClient, "sendVerificationEmail").mockResolvedValue({ data: {}, error: null });
    await open();
    expect(RESEND_COOLDOWN_S).toBe(60);
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toContain("(in 1:00)");
    fireEvent.click(resend());
    expect(send).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(18_000));
    expect(resend().textContent).toContain("(in 0:42)");
    expect(resend().disabled).toBe(true);

    act(() => vi.advanceTimersByTime(42_500));
    expect(resend().disabled).toBe(false);
    expect(resend().textContent).toBe("Send it again");

    fireEvent.click(resend());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ email: "ada@example.com" }));
    await waitFor(() => expect(resend().disabled).toBe(true));
    expect(resend().textContent).toContain("(in 1:00)");
    fireEvent.click(resend());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("'Wrong address? Change it' PATCHes the pending email and shows the new address", async () => {
    const calls = await open();
    fireEvent.click(screen.getByRole("button", { name: "Wrong address? Change it" }));
    fireEvent.change(field("newEmail"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Update and resend" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a valid email address.");
    expect(calls.some((call) => call.path === "/api/account/pending-email")).toBe(false);

    fireEvent.change(field("newEmail"), { target: { value: "ada.l@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Update and resend" }));
    await waitFor(() =>
      expect(document.querySelector("[data-verify-email]")?.textContent).toBe("ada.l@example.com"),
    );
    const patch = calls.find((call) => call.path === "/api/account/pending-email");
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ email: "ada.l@example.com" });
  });
});

describe("password reset", () => {
  it("forgot: the answer is the same whether or not the address exists", async () => {
    const request = vi
      .spyOn(authClient, "requestPasswordReset")
      .mockResolvedValue({ data: null, error: { status: 404, statusText: "", message: "User not found" } });
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/forgot-password"]);
    await screen.findByRole("heading", { name: "Reset your password" });
    fill({ email: "nobody@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() =>
      expect(document.querySelector("[data-form-notice]")?.textContent).toContain(
        "If that address has an account",
      ),
    );
    expect(document.body.textContent).not.toContain("User not found");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "nobody@example.com",
        redirectTo: expect.stringMatching(/\/reset-password$/),
      }),
    );
  });

  it("reset: sends the token and the new password, then returns to sign-in", async () => {
    const reset = vi.spyOn(authClient, "resetPassword").mockResolvedValue({ data: {}, error: null });
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/reset-password?token=tok123"]);
    await screen.findByRole("heading", { name: "Choose a new password" });
    fill({ password: "short" });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use 12 characters or more.");
    expect(reset).not.toHaveBeenCalled();
    fill({ password: "a much longer password" });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(router.state.location.search).toBe("?reason=reset"));
    expect(reset).toHaveBeenCalledWith({ newPassword: "a much longer password", token: "tok123" });
  });

  it("reset: the token leaves the address bar as soon as it has been read (S11)", async () => {
    const reset = vi.spyOn(authClient, "resetPassword").mockResolvedValue({ data: {}, error: null });
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/reset-password?token=tok123"]);
    await screen.findByRole("heading", { name: "Choose a new password" });
    await waitFor(() => expect(router.state.location.search).toBe(""));
    // …and it still works: the form holds it.
    expect(field("password")).not.toBeNull();
    fill({ password: "a much longer password" });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(reset).toHaveBeenCalledWith({ newPassword: "a much longer password", token: "tok123" }),
    );
  });

  it("set password (after a verification link opened in another browser): token from the fragment, gone from the address bar, sent with the password", async () => {
    const reset = vi.spyOn(authClient, "resetPassword").mockResolvedValue({ data: {}, error: null });
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/set-password#token=tok456"]);
    await screen.findByRole("heading", { name: "Set your password" });
    expect(document.body.textContent).toContain("Your email is confirmed.");
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    fill({ password: "short" });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Use 12 characters or more.");
    expect(reset).not.toHaveBeenCalled();
    fill({ password: "a much longer password" });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(reset).toHaveBeenCalledWith({ newPassword: "a much longer password", token: "tok456" });
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      "Password set. Sign in to continue.",
    );
    expect(router.state.location.search).toBe("?reason=password_set");
  });

  it("set password without a token offers the reset-by-mail path instead of a form", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/set-password"]);
    await screen.findByRole("heading", { name: "Set your password" });
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      "This link is incomplete or was already used. Ask for a reset link to choose a password.",
    );
    expect(field("password")).toBeNull();
    expect(screen.getByRole("link", { name: "Send reset link" }).getAttribute("href")).toBe(
      "/forgot-password",
    );
  });

  it("the sign-in screen says why an address-change link sent the browser there", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login?reason=change_email"]);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      "Sign in first, then open the link in that email again to confirm your new address.",
    );
  });

  it("reset without a token offers a new link instead of a form", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/reset-password"]);
    await screen.findByRole("heading", { name: "Choose a new password" });
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe(
      "This reset link is incomplete. Request a new one.",
    );
    expect(field("password")).toBeNull();
  });
});

// ── an error that arrives in the URL ─────────────────────────────────────────────────────────
describe("?error= on the sign-in and sign-up screens", () => {
  const HOSTILE = "<img src=x onerror=alert(1)> Call +1 555 0100 to unlock your account";

  it("a known code picks OUR sentence; an unknown one the generic sentence; the description is never read", () => {
    expect(redirectErrorMessage("SIGNUP_INTENT_REQUIRED")).toBe(
      "To sign up with Google, start from the sign-up page.",
    );
    expect(redirectErrorMessage("INVITE_INVALID")).toBe("This invite code isn't valid.");
    expect(redirectErrorMessage("TOKEN_EXPIRED")).toBe(en["auth.redirect.linkExpired"]);
    expect(redirectErrorMessage("access_denied")).toBe("The Google sign-in was cancelled.");
    for (const unknown of [
      HOSTILE,
      "",
      "toString",
      "constructor",
      "__proto__",
      "invite_invalid",
      "x".repeat(5000),
    ])
      expect(redirectErrorMessage(unknown), unknown.slice(0, 20)).toBe("That didn't work. Try again.");
    expect(
      takeRedirectError(
        `?error=${encodeURIComponent(HOSTILE)}&error_description=${encodeURIComponent(HOSTILE)}&next=%2Ffolder`,
      ),
    ).toEqual({
      message: "That didn't work. Try again.",
      search: "?next=%2Ffolder",
    });
    // A description alone is removed and says nothing.
    expect(takeRedirectError(`?error_description=${encodeURIComponent(HOSTILE)}`)).toEqual({
      message: null,
      search: "",
    });
    expect(takeRedirectError("?next=%2Fx")).toEqual({ message: null, search: "?next=%2Fx" });
    expect(takeRedirectError("")).toEqual({ message: null, search: "" });
  });

  it.each([
    ["/login", "Sign in"],
    ["/signup", "Create your account"],
  ])(
    "%s shows the mapped sentence, never the parameter, and takes both out of the address",
    async (path, heading) => {
      shellFetch({ session: null });
      const { router } = renderRoutes(buildRoutes(), [
        `${path}?error=SIGNUP_INTENT_REQUIRED&error_description=${encodeURIComponent(HOSTILE)}&next=%2Ffolder%2Fabc`,
      ]);
      await screen.findByRole("heading", { name: heading });
      expect((await screen.findByRole("alert")).textContent).toBe(
        "To sign up with Google, start from the sign-up page.",
      );
      expect(document.body.textContent).not.toContain("555 0100");
      expect(document.body.innerHTML).not.toContain("onerror");
      expect(document.querySelector("img[src='x']")).toBeNull();
      await waitFor(() => expect(router.state.location.search).toBe("?next=%2Ffolder%2Fabc"));
      expect(router.state.historyAction).toBe("REPLACE");
      // The sentence stays after the address is cleaned (it was read once, into state).
      expect(screen.getByRole("alert").textContent).toBe(
        "To sign up with Google, start from the sign-up page.",
      );
    },
  );

  it("an unknown or hostile code shows only the generic sentence", async () => {
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), [`/login?error=${encodeURIComponent(HOSTILE)}`]);
    await screen.findByRole("heading", { name: "Sign in" });
    expect((await screen.findByRole("alert")).textContent).toBe("That didn't work. Try again.");
    expect(document.body.textContent).not.toContain("unlock your account");
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("a verification link that came back with an error does not say 'Email confirmed'", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login?reason=verified&error=TOKEN_EXPIRED"]);
    await screen.findByRole("heading", { name: "Sign in" });
    expect((await screen.findByRole("alert")).textContent).toBe(en["auth.redirect.linkExpired"]);
    expect(screen.queryByText("Email confirmed. Sign in to continue.")).toBeNull();
  });

  it("control: without an error the 'Email confirmed' notice is shown, and nothing is an alert", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login?reason=verified"]);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(await screen.findByText("Email confirmed. Sign in to continue.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ── after a sign-up; and an address that was never confirmed ─────────────────────────────────
describe("what the screens say about a sign-up that was answered", () => {
  const complete = {
    inviteCode: "HF-7K2Q",
    name: "Ada",
    email: "ada@example.com",
    password: "correct horse battery",
    birthMonth: "5",
    birthYear: "1990",
  };

  it("a sign-up that was answered REPLACES the form (Back cannot offer the same invite again) and tells the truth about the mail", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    const { router } = await openSignup();
    fill(complete);
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/verify-email");
    expect(router.state.historyAction).toBe("REPLACE");
    // Not "we sent": the server answers the same when the address already has an account.
    const lead = document.querySelector("[data-verify-email]")!.parentElement!.textContent;
    expect(lead).toBe(
      "If this address is new to Holdfast, we've sent a confirmation link to ada@example.com. It works for one hour. If you already have an account with it, sign in instead.",
    );
    // The link was just sent (if at all): sending again waits.
    expect(document.querySelector<HTMLButtonElement>("[data-resend]")!.disabled).toBe(true);
  });

  it("a second attempt with a used invite is told what most likely happened", async () => {
    vi.spyOn(authClient.signUp, "email").mockResolvedValue({
      data: null,
      error: {
        status: 400,
        statusText: "Bad Request",
        code: "INVITE_INVALID",
        message: "This invite code isn't valid.",
      },
    });
    await openSignup();
    fill(complete);
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(screen.getAllByRole("alert").map((node) => node.textContent)).toContain(
        en["signup.error.inviteUsed"],
      ),
    );
    expect(en["signup.error.inviteUsed"]).toMatch(/already been used/);
    expect(en["signup.error.inviteUsed"]).toMatch(/check your email/);
  });

  it("the right password for an unconfirmed address leads to a screen that can send the link again at once", async () => {
    vi.spyOn(authClient.signIn, "email").mockResolvedValue({
      data: null,
      error: {
        status: 403,
        statusText: "Forbidden",
        code: "EMAIL_NOT_VERIFIED",
        message: "Email not verified",
      },
    });
    const resend = vi
      .spyOn(authClient, "sendVerificationEmail")
      .mockResolvedValue({ data: { status: true }, error: null });
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "the right one" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Confirm your email" });
    expect(document.querySelector("[data-verify-email]")!.parentElement!.textContent).toBe(
      "The address ada@example.com hasn't been confirmed yet. We can send the link again.",
    );
    const button = document.querySelector<HTMLButtonElement>("[data-resend]")!;
    expect(button.disabled, "nothing was just sent: no wait").toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(resend).toHaveBeenCalledTimes(1));
    expect(resend.mock.calls[0]![0]).toMatchObject({
      email: "ada@example.com",
      callbackURL: "/login?reason=verified",
    });
    expect(await screen.findByText("Sent. Check your inbox.")).toBeTruthy();
    // And now it waits, like after any send.
    await waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>("[data-resend]")!.disabled).toBe(true),
    );
  });

  it("a wrong password for that same address says only 'wrong email or password' (no hint that it exists)", async () => {
    vi.spyOn(authClient.signIn, "email").mockResolvedValue({
      data: null,
      error: { status: 401, statusText: "Unauthorized", code: "INVALID_EMAIL_OR_PASSWORD" },
    });
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "nope" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong email or password.");
    expect(router.state.location.pathname).toBe("/login");
  });
});
