import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { t, type MessageKey } from "../../lib/i18n";
import { usePublicConfig } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { AuthCard, Field, FormError, FormNotice, TurnstileBox } from "./parts";
import { isEmail, PASSWORD_MAX, PASSWORD_MIN } from "./validation";

const backSx = {
  color: hf.text,
  fontSize: 12,
  textDecoration: "underline",
  textUnderlineOffset: "2px",
  display: "inline-flex",
  alignItems: "center",
  minHeight: 24,
  "@media (max-width:1023.95px)": { minHeight: 44 },
} as const;

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
      authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${window.location.origin}/reset-password`,
        fetchOptions: captchaOptions(turnstile.token),
      }),
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
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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

/**
 * The token of a mailed link, taken out of the address bar. It is read ONCE, when the screen
 * mounts — from `?token=` (Better Auth's reset link) or from `#token=` (the set-password step
 * after a verification link) — and the URL is then replaced by one without it, so the token is
 * not left in the history, in a copied link or in a bookmark.
 */
function useLinkToken(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState<string | null>(() => {
    const fromQuery = new URLSearchParams(location.search).get("token");
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
    return fromQuery || fromHash || null;
  });
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (!query.has("token") && !hash.has("token")) return;
    query.delete("token");
    hash.delete("token");
    const search = query.toString();
    const fragment = hash.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : "",
        hash: fragment ? `#${fragment}` : "",
      },
      { replace: true, state: location.state },
    );
  }, [location, navigate]);
  return token;
}

type PasswordLinkCopy = {
  title: MessageKey;
  lead?: MessageKey;
  submit: MessageKey;
  missing: MessageKey;
  failed: MessageKey;
  /** `reason` on the sign-in screen afterwards. */
  done: string;
};

const RESET_COPY: PasswordLinkCopy = {
  title: "reset.title",
  submit: "reset.submit",
  missing: "reset.missing",
  failed: "reset.failed",
  done: "reset",
};

// The verification link was opened in a browser other than the one that signed up: the address
// is confirmed, the account has no password yet, and this screen is where its owner chooses one.
const SET_COPY: PasswordLinkCopy = {
  title: "setPassword.title",
  lead: "setPassword.body",
  submit: "setPassword.submit",
  missing: "setPassword.missing",
  failed: "setPassword.missing",
  done: "password_set",
};

function PasswordLinkPage({ copy }: { copy: PasswordLinkCopy }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = useLinkToken();
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
      else if (result.error.code === "INVALID_TOKEN") setError(t(copy.failed));
      else setError(authErrorMessage(result.error, copy.failed));
      return;
    }
    navigate(`/login?reason=${copy.done}`, { replace: true });
  };

  const unusable = !token || Boolean(linkError);
  return (
    <AuthCard title={t(copy.title)} lead={!unusable && copy.lead ? t(copy.lead) : undefined}>
      {unusable ? (
        <FormNotice tone="danger">{t(linkError ? copy.failed : copy.missing)}</FormNotice>
      ) : (
        <Box
          component="form"
          noValidate
          onSubmit={onSubmit}
          sx={{ display: "flex", flexDirection: "column", gap: 3 }}
        >
          <Field
            label={t("reset.new")}
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            help={t("signup.password.help")}
            errorText={error ?? undefined}
          />
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            {t(copy.submit)}
          </Button>
        </Box>
      )}
      <Box component={RouterLink} to={unusable ? "/forgot-password" : "/login"} sx={backSx}>
        {unusable ? t("forgot.submit") : t("forgot.back")}
      </Box>
    </AuthCard>
  );
}

/** Choose a new password with the token from the emailed reset link. */
export function ResetPasswordPage() {
  return <PasswordLinkPage copy={RESET_COPY} />;
}

/** Choose the account's first password, after its address was confirmed from another browser. */
export function SetPasswordPage() {
  return <PasswordLinkPage copy={SET_COPY} />;
}
