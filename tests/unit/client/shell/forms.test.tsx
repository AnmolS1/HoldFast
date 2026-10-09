// Auth forms: sign-up validation, the resend cooldown, and what each screen sends.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authClient } from "../../../../src/client/lib/auth-client";
import { buildRoutes } from "../../../../src/client/router";
import { isThirteenOrOlder, passwordStrength, validateSignup, type SignupValues } from "../../../../src/client/routes/auth/validation";
import { RESEND_COOLDOWN_S } from "../../../../src/client/routes/auth/VerifyEmail";
import { envelope, json, renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const NOW = new Date("2026-10-08T12:00:00Z");
const valid: SignupValues = { name: "Ada", email: "ada@example.com", password: "correct horse battery", inviteCode: "HF-7K2Q", birthMonth: "5", birthYear: "1990", acceptTerms: true };
const check = (patch: Partial<SignupValues>, inviteRequired = true) => validateSignup({ ...valid, ...patch }, { inviteRequired, now: NOW });

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

  it("thirteen this month is old enough", () => {
    expect(isThirteenOrOlder(2013, 10, NOW)).toBe(true);
    expect(isThirteenOrOlder(2013, 11, NOW)).toBe(false);
    expect(isThirteenOrOlder(2012, 12, NOW)).toBe(true);
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

function fill(values: Partial<Record<"inviteCode" | "name" | "email" | "password" | "birthMonth" | "birthYear", string>>) {
  for (const [name, value] of Object.entries(values)) fireEvent.change(field(name), { target: { value } });
}

describe("sign-up screen", () => {
  it("has every field the policy needs, with the age note and the terms links", async () => {
    await openSignup();
    for (const name of ["inviteCode", "name", "email", "password", "birthMonth", "birthYear", "acceptTerms"]) expect(field(name), name).not.toBeNull();
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
      expect.arrayContaining(["Enter your invite code.", "Enter your name.", "Enter a valid email address.", "Use 12 characters or more.", "Enter the month (1–12) and a four-digit year.", "You need to accept the Terms and Privacy Policy."]),
    );
    expect(signUp).not.toHaveBeenCalled();
  });

  it("a valid form calls signUp.email with the policy fields and goes to /verify-email", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    const { router } = await openSignup();
    fill({ inviteCode: "HF-7K2Q", name: "Ada", email: "ada@example.com", password: "correct horse battery", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/verify-email"));
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ name: "Ada", email: "ada@example.com", password: "correct horse battery", inviteCode: "HF-7K2Q", birthYear: 1990, birthMonth: 5, acceptTerms: true }));
    expect((await screen.findByText("ada@example.com")).getAttribute("data-verify-email")).not.toBeNull();
    // The address travels in router state, not in the URL.
    expect(router.state.location.search).toBe("");
  });

  it("open sign-up mode has no invite field and sends no code", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    await openSignup({ signupMode: "open" });
    expect(field("inviteCode")).toBeNull();
    fill({ name: "Ada", email: "ada@example.com", password: "correct horse battery", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(signUp).toHaveBeenCalled());
    expect(signUp.mock.calls[0]![0].inviteCode).toBeUndefined();
  });

  it("a breached password is reported under the password field", async () => {
    vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: null, error: { status: 400, statusText: "", code: "PASSWORD_COMPROMISED", message: "x" } });
    await openSignup();
    fill({ inviteCode: "HF", name: "Ada", email: "ada@example.com", password: "password123456", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("This password appears in a known breach. Choose another.")).toBeTruthy();
  });

  it("the server's refusal sentence is shown as it is", async () => {
    vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: null, error: { status: 403, statusText: "", message: "This invite can't be used." } });
    await openSignup();
    fill({ inviteCode: "HF", name: "Ada", email: "ada@example.com", password: "correct horse battery", birthMonth: "5", birthYear: "1990" });
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
    expect(calls.find((call) => call.path === "/api/auth-intent")?.body).toEqual({ inviteCode: "HF-7K2Q", birthYear: 1990, birthMonth: 5, acceptTerms: true });
    expect(social).toHaveBeenCalledWith(expect.objectContaining({ provider: "google" }));
  });

  it("a refused intent does not start OAuth", async () => {
    const social = vi.spyOn(authClient.signIn, "social");
    shellFetch({ session: null, extra: (call) => (call.path === "/api/auth-intent" ? envelope("forbidden", 403) : undefined) });
    renderRoutes(buildRoutes(), ["/signup"]);
    await screen.findByRole("heading", { name: "Create your account" });
    fill({ inviteCode: "HF", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms"));
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByText("forbidden message")).toBeTruthy();
    expect(social).not.toHaveBeenCalled();
  });

  it("/invite/:code checks the code and prefills it", async () => {
    shellFetch({ session: null, extra: (call) => (call.path === "/api/invites/HF-GOOD" ? json({ valid: true }) : undefined) });
    const { router } = renderRoutes(buildRoutes(), ["/invite/HF-GOOD"]);
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup"));
    await waitFor(() => expect(field("inviteCode")?.value).toBe("HF-GOOD"));
    expect(screen.getByText("This invite is valid.")).toBeTruthy();
  });

  it("an invalid invite says so, without a reason", async () => {
    shellFetch({ session: null, extra: (call) => (call.path.startsWith("/api/invites/") ? json({ valid: false }) : undefined) });
    renderRoutes(buildRoutes(), ["/invite/HF-BAD"]);
    expect(await screen.findByText("This invite can't be used. Check the code or ask for a new one.")).toBeTruthy();
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
    vi.spyOn(authClient.signIn, "email").mockResolvedValue({ data: null, error: { status: 401, statusText: "Unauthorized" } });
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "nope" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong email or password.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with the placeholder auth client the screen says sign-in is not available yet", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/login"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "anything" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sign-in isn't available in this build yet.");
  });

  it("a second factor sends the user to /two-factor with next kept", async () => {
    vi.spyOn(authClient.signIn, "email").mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    shellFetch({ session: null });
    const { router } = renderRoutes(buildRoutes(), ["/login?next=/recent"]);
    await screen.findByRole("heading", { name: "Sign in" });
    fill({ email: "ada@example.com", password: "correct horse battery" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/two-factor"));
    expect(new URLSearchParams(router.state.location.search).get("next")).toBe("/recent");
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
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe("This account is suspended. Contact support.");
  });

  it("there is no /confirm-deletion screen", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/confirm-deletion"]);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("verify-email screen", () => {
  async function open() {
    const calls = shellFetch({ session: sessionOf({ emailVerified: false, email: "ada@example.com" }), extra: (call) => (call.path === "/api/account/pending-email" ? json({ ok: true }) : undefined) });
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
    await waitFor(() => expect(document.querySelector("[data-verify-email]")?.textContent).toBe("ada.l@example.com"));
    const patch = calls.find((call) => call.path === "/api/account/pending-email");
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ email: "ada.l@example.com" });
  });
});

describe("password reset", () => {
  it("forgot: the answer is the same whether or not the address exists", async () => {
    const request = vi.spyOn(authClient, "requestPasswordReset").mockResolvedValue({ data: null, error: { status: 404, statusText: "", message: "User not found" } });
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/forgot-password"]);
    await screen.findByRole("heading", { name: "Reset your password" });
    fill({ email: "nobody@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(document.querySelector("[data-form-notice]")?.textContent).toContain("If that address has an account"));
    expect(document.body.textContent).not.toContain("User not found");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ email: "nobody@example.com", redirectTo: expect.stringMatching(/\/reset-password$/) }));
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

  it("reset without a token offers a new link instead of a form", async () => {
    shellFetch({ session: null });
    renderRoutes(buildRoutes(), ["/reset-password"]);
    await screen.findByRole("heading", { name: "Choose a new password" });
    expect(document.querySelector("[data-form-notice]")?.textContent).toBe("This reset link is incomplete. Request a new one.");
    expect(field("password")).toBeNull();
  });
});
