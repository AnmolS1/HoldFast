import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { t } from "../../lib/i18n";
import { usePublicConfig } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { AuthCard, Field, FormError, FormNotice, TurnstileBox } from "./parts";
import { isEmail, PASSWORD_MAX, PASSWORD_MIN } from "./validation";

const backSx = { color: hf.text, fontSize: 12, textDecoration: "underline", textUnderlineOffset: "2px", display: "inline-flex", alignItems: "center", minHeight: 24 } as const;

/** Ask for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordPage() {
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!isEmail(email)) {
      setError(t("signup.error.email"));
      return;
    }
    if (config?.turnstileSiteKey && !turnstile.token) {
      setError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    setBusy(true);
    const result = await callAuth(() =>
      authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${window.location.origin}/reset-password`, fetchOptions: captchaOptions(turnstile.token) }),
    );
    turnstile.reset();
    setBusy(false);
    // Only failures that say nothing about the address are shown; everything else looks the same.
    if (result.error && (result.error.status === 429 || result.error.status === 0)) {
      setError(authErrorMessage(result.error));
      return;
    }
    setSent(true);
  };

  return (
    <AuthCard title={t("forgot.title")} lead={sent ? undefined : t("forgot.body")}>
      {sent ? (
        <FormNotice>{t("forgot.sent")}</FormNotice>
      ) : (
        <Box component="form" noValidate onSubmit={onSubmit} sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <Field label={t("auth.email")} type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
          <FormError>{error}</FormError>
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            {t("forgot.submit")}
          </Button>
        </Box>
      )}
      <Box component={RouterLink} to="/login" sx={backSx}>
        {t("forgot.back")}
      </Box>
    </AuthCard>
  );
}

/** Choose a new password with the token from the emailed link. */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const linkError = params.get("error");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!token) return;
    if (password.length < PASSWORD_MIN) {
      setError(t("signup.error.password"));
      return;
    }
    if (password.length > PASSWORD_MAX) {
      setError(t("signup.error.passwordLong"));
      return;
    }
    setBusy(true);
    const result = await callAuth(() => authClient.resetPassword({ newPassword: password, token }));
    setBusy(false);
    if (result.error) {
      if (result.error.code === "PASSWORD_COMPROMISED") setError(t("signup.password.breached"));
      else if (result.error.code === "INVALID_TOKEN") setError(t("reset.failed"));
      else setError(authErrorMessage(result.error, "reset.failed"));
      return;
    }
    navigate("/login?reason=reset", { replace: true });
  };

  const unusable = !token || Boolean(linkError);
  return (
    <AuthCard title={t("reset.title")}>
      {unusable ? (
        <FormNotice tone="danger">{t(linkError ? "reset.failed" : "reset.missing")}</FormNotice>
      ) : (
        <Box component="form" noValidate onSubmit={onSubmit} sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <Field label={t("reset.new")} type="password" name="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} help={t("signup.password.help")} errorText={error ?? undefined} />
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            {t("reset.submit")}
          </Button>
        </Box>
      )}
      <Box component={RouterLink} to={unusable ? "/forgot-password" : "/login"} sx={backSx}>
        {unusable ? t("forgot.submit") : t("forgot.back")}
      </Box>
    </AuthCard>
  );
}
