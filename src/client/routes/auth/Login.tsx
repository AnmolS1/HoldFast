import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { t, type MessageKey } from "../../lib/i18n";
import { refreshSession, usePublicConfig } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions, useRedirectError } from "./errors";
import {
  AuthCard,
  Field,
  FormError,
  FormNotice,
  GoogleIcon,
  OrDivider,
  PasskeyIcon,
  TurnstileBox,
} from "./parts";
import { isEmail, safeNext } from "./validation";

const REASONS: Record<string, { key: MessageKey; tone: "neutral" | "danger" }> = {
  suspended: { key: "login.suspended", tone: "danger" },
  verified: { key: "login.verified", tone: "neutral" },
  reset: { key: "login.reset", tone: "neutral" },
};

const linkSx = {
  color: hf.text,
  textDecoration: "underline",
  textUnderlineOffset: "2px",
  display: "inline-flex",
  alignItems: "center",
  minHeight: 24,
  "@media (max-width:1023.95px)": { minHeight: 44 },
} as const;

/** Sign in: passkey first (and offered in the email field), password second, Google third. */
export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const redirectError = useRedirectError();
  // A link that came back with an error did not do what its `reason` says: no "Email confirmed"
  // beside "that link has expired".
  const reason = redirectError ? undefined : REASONS[params.get("reason") ?? ""];
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(redirectError);
  const [busy, setBusy] = useState<"password" | "passkey" | "google" | null>(null);
  const started = useRef(false);

  const finish = async () => {
    await refreshSession();
    navigate(next, { replace: true });
  };

  // Conditional UI: where the browser supports it, passkeys appear in the email field's autofill.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const available = (
      window.PublicKeyCredential as
        | (typeof PublicKeyCredential & { isConditionalMediationAvailable?: () => Promise<boolean> })
        | undefined
    )?.isConditionalMediationAvailable;
    if (!available) return;
    let cancelled = false;
    void available
      .call(window.PublicKeyCredential)
      .then((ok) => (ok && !cancelled ? callAuth(() => authClient.signIn.passkey({ autoFill: true })) : null))
      .then((result) => {
        if (result && !result.error && !cancelled) void finish();
      })
      .catch(() => {
        // No conditional mediation: the button below still works.
      });
    return () => {
      cancelled = true;
    };
    // Runs once: the autofill request lives for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPasskey = async () => {
    setError(null);
    setBusy("passkey");
    const result = await callAuth(() => authClient.signIn.passkey());
    setBusy(null);
    if (result.error) {
      setError(result.error.code === "NOT_WIRED" ? t("auth.notWired") : t("auth.error.passkey"));
      return;
    }
    await finish();
  };

  const onGoogle = async () => {
    setError(null);
    setBusy("google");
    const result = await callAuth(() =>
      authClient.signIn.social({ provider: "google", callbackURL: next, errorCallbackURL: "/login" }),
    );
    setBusy(null);
    if (result.error) setError(authErrorMessage(result.error));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!isEmail(email) || password === "") {
      setError(t("auth.error.credentials"));
      return;
    }
    if (config?.turnstileSiteKey && !turnstile.token) {
      setError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    setBusy("password");
    const result = await callAuth(() =>
      authClient.signIn.email({
        email: email.trim(),
        password,
        fetchOptions: captchaOptions(turnstile.token),
      }),
    );
    turnstile.reset();
    setBusy(null);
    if (result.error) {
      if (result.error.status === 403 && result.error.code === "EMAIL_NOT_VERIFIED") {
        // The right password for an address that was never confirmed. Nothing has been sent by
        // this attempt: the next screen offers to send the link again, at once.
        navigate("/verify-email", { state: { email: email.trim(), unconfirmed: true } });
        return;
      }
      setError(authErrorMessage(result.error));
      return;
    }
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      navigate(`/two-factor?next=${encodeURIComponent(next)}`);
      return;
    }
    await finish();
  };

  return (
    <AuthCard title={t("login.title")}>
      {reason ? <FormNotice tone={reason.tone}>{t(reason.key)}</FormNotice> : null}
      <Box
        component="form"
        noValidate
        onSubmit={onSubmit}
        sx={{ display: "flex", flexDirection: "column", gap: 3 }}
      >
        <Field
          label={t("auth.email")}
          type="email"
          name="email"
          autoComplete="username webauthn"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button size="large" onClick={onPasskey} disabled={busy !== null} startIcon={<PasskeyIcon />}>
          {t("auth.passkey")}
        </Button>
        <OrDivider />
        <Field
          label={t("auth.password")}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
        <FormError>{error}</FormError>
        <Button type="submit" variant="contained" size="large" disabled={busy !== null}>
          {t("login.submit")}
        </Button>
        <Button size="large" onClick={onGoogle} disabled={busy !== null} startIcon={<GoogleIcon />}>
          {t("auth.google")}
        </Button>
      </Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 2, fontSize: 12 }}>
        <Box component={RouterLink} to="/forgot-password" sx={linkSx}>
          {t("login.forgot")}
        </Box>
        <Box component={RouterLink} to="/signup" sx={linkSx}>
          {t("login.create")}
        </Box>
      </Box>
    </AuthCard>
  );
}
