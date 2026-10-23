// The closed-test notice on the sign-up forms (DEMONOTICE, 2026-10-22). While the public config's
// `demoMode` is on, the sign-up screen and the set-password screen (a verification link opened in
// another browser: the person who becomes the account holder there never saw the sign-up form)
// show the notice with a checkbox the tester must tick; the request then carries
// `acceptDemo: true` (the server refuses without it). With `demoMode` off the forms are exactly as
// before: no notice, no checkbox, no `acceptDemo` in any request.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { authClient } from "../../../../src/client/lib/auth-client";
import { buildRoutes } from "../../../../src/client/router";
import { redirectErrorMessage } from "../../../../src/client/routes/auth/errors";
import {
  validateIntent,
  validateSignup,
  type SignupValues,
} from "../../../../src/client/routes/auth/validation";
import { json, renderRoutes, setupShell, shellFetch } from "./helpers";

setupShell();

const NOTICE =
  "Holdfast is in a closed test. Don't store anything important — files may be deleted when the test ends. Report problems to support@holdfast.ponderance.dev.";

function field(name: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
}

function fill(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) fireEvent.change(field(name)!, { target: { value } });
}

const COMPLETE = {
  inviteCode: "HF-7K2Q",
  name: "Ada",
  email: "ada@example.com",
  password: "correct horse battery",
  birthMonth: "5",
  birthYear: "1990",
};

async function openSignup(demoMode: boolean, extra?: NonNullable<Parameters<typeof shellFetch>[0]>["extra"]) {
  const calls = shellFetch({ session: null, config: { demoMode }, extra });
  const view = renderRoutes(buildRoutes(), ["/signup"]);
  await screen.findByRole("heading", { name: "Create your account" });
  // The invite field appears once the public config has arrived (signupMode "invite").
  await waitFor(() => expect(field("inviteCode")).not.toBeNull());
  return { ...view, calls };
}

describe("validation (pure)", () => {
  const NOW = new Date("2026-10-08T12:00:00Z");
  const valid: SignupValues = { ...COMPLETE, acceptTerms: true };
  it("demo mode on: the notice must be accepted, for the email sign-up and the Google intent alike", () => {
    const options = { inviteRequired: true, demoMode: true, now: NOW };
    expect(validateSignup(valid, options)).toEqual({ acceptDemo: "signup.error.demo" });
    expect(validateIntent(valid, options)).toEqual({ acceptDemo: "signup.error.demo" });
    expect(validateSignup({ ...valid, acceptDemo: true }, options)).toEqual({});
  });
  it("demo mode off: nothing is asked", () => {
    expect(validateSignup(valid, { inviteRequired: true, now: NOW })).toEqual({});
    expect(validateSignup(valid, { inviteRequired: true, demoMode: false, now: NOW })).toEqual({});
  });
});

describe("a Google sign-up refused at the callback (?error=DEMO_NOT_ACCEPTED)", () => {
  it("reads as our sentence, not the generic one", () => {
    expect(redirectErrorMessage("DEMO_NOT_ACCEPTED")).toBe("Accept the closed-test notice to continue.");
  });
});

describe("sign-up screen", () => {
  it("demo mode off: no notice, no checkbox — and the request carries no acceptDemo", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    const { router } = await openSignup(false);
    expect(document.body.textContent).not.toContain("closed test");
    expect(field("acceptDemo")).toBeNull();
    fill(COMPLETE);
    fireEvent.click(field("acceptTerms")!);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/verify-email"));
    expect(signUp.mock.calls[0]![0]).not.toHaveProperty("acceptDemo");
  });

  it("demo mode on: the notice is shown with a labelled checkbox described by it, unticked", async () => {
    await openSignup(true);
    const notice = document.querySelector("[data-demo-notice]")!;
    expect(notice.textContent).toBe(NOTICE);
    const box = screen.getByRole("checkbox", { name: "I understand" }) as HTMLInputElement;
    expect(box).toBe(field("acceptDemo"));
    expect(box.checked).toBe(false);
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(notice.id);
    // A native checkbox: in the tab order, focusable.
    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it("demo mode on, the notice not accepted: an error tied to the checkbox, and nothing is sent", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email");
    const { router } = await openSignup(true);
    fill(COMPLETE);
    fireEvent.click(field("acceptTerms")!);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Accept the closed-test notice to continue.");
    const box = field("acceptDemo")!;
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signUp).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/signup");
  });

  it("demo mode on, accepted: signUp.email carries acceptDemo: true", async () => {
    const signUp = vi.spyOn(authClient.signUp, "email").mockResolvedValue({ data: {}, error: null });
    const { router } = await openSignup(true);
    fill(COMPLETE);
    fireEvent.click(field("acceptTerms")!);
    fireEvent.click(field("acceptDemo")!);
    expect(field("acceptDemo")!.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/verify-email"));
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({ acceptTerms: true, acceptDemo: true }));
  });

  it("demo mode on: the Google intent needs the assent too, and carries it", async () => {
    const social = vi.spyOn(authClient.signIn, "social").mockResolvedValue({ data: {}, error: null });
    const { calls } = await openSignup(true, (call) =>
      call.path === "/api/auth-intent" ? json({ ok: true }) : undefined,
    );
    fill({ inviteCode: "HF-7K2Q", birthMonth: "5", birthYear: "1990" });
    fireEvent.click(field("acceptTerms")!);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await screen.findByRole("alert");
    expect(calls.some((call) => call.path === "/api/auth-intent")).toBe(false);
    fireEvent.click(field("acceptDemo")!);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(social).toHaveBeenCalled());
    expect(calls.find((call) => call.path === "/api/auth-intent")?.body).toEqual({
      inviteCode: "HF-7K2Q",
      birthYear: 1990,
      birthMonth: 5,
      acceptTerms: true,
      acceptDemo: true,
    });
  });
});

describe("set-password screen (a verification link opened elsewhere)", () => {
  async function openSetPassword(demoMode: boolean) {
    const calls = shellFetch({
      session: null,
      config: { demoMode },
      extra: (call) => (call.path === "/api/account/confirm-email" ? json({ ok: true }) : undefined),
    });
    renderRoutes(buildRoutes(), ["/set-password#token=tok456"]);
    await waitFor(() => expect(field("password")).not.toBeNull());
    // The page renders before the public config has arrived: wait for it (and its render).
    await waitFor(() => expect(calls.some((call) => call.path === "/api/public/config")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return () => calls.filter((call) => call.path === "/api/account/confirm-email");
  }
  const SUBMIT = /set password/i;

  it("demo mode on: asks for the assent before sending, then sends acceptDemo: true", async () => {
    const sent = await openSetPassword(true);
    await waitFor(() => expect(document.querySelector("[data-demo-notice]")?.textContent).toBe(NOTICE));
    fill({ password: "a much longer password", birthMonth: "6", birthYear: "1990" });
    fireEvent.click(field("acceptTerms")!);
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
    expect((await screen.findByRole("alert")).textContent).toBe("Accept the closed-test notice to continue.");
    expect(sent()).toEqual([]);
    fireEvent.click(field("acceptDemo")!);
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.body).toMatchObject({ acceptTerms: true, acceptDemo: true });
  });

  it("demo mode off: no notice, and the request carries no acceptDemo", async () => {
    const sent = await openSetPassword(false);
    expect(field("acceptDemo")).toBeNull();
    expect(document.body.textContent).not.toContain("closed test");
    fill({ password: "a much longer password", birthMonth: "6", birthYear: "1990" });
    fireEvent.click(field("acceptTerms")!);
    fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.body).not.toHaveProperty("acceptDemo");
  });
});
