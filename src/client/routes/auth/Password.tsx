import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, ApiError } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { EXTERNAL_LINKS } from "../../lib/contracts";
import { t, type MessageKey } from "../../lib/i18n";
import { usePublicConfig } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { AuthCard, Field, FormError, FormNotice, TurnstileBox } from "./parts";
import { isEmail, isThirteenOrOlder, parseBirth, PASSWORD_MAX, PASSWORD_MIN, storedForm } from "./validation";

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
        email: storedForm(email),
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
 * mounts — from `?token=` (Better Auth's reset link) or from `#token=` (a verification link
 * opened in another browser: the link's own token) — and the URL is then replaced by one without it, so the token is
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

function PasswordLinkPage({ copy }: { copy: PasswordLinkCopy }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = useLinkToken();
  const linkError = params.get("error");
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
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
    if (config?.turnstileSiteKey && !turnstile.token) {
      setError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    setBusy(true);
    const result = await callAuth(() =>
      authClient.resetPassword({
        newPassword: password,
        token,
        fetchOptions: captchaOptions(turnstile.token),
      }),
    );
    // A token is single-use, whatever the answer was.
    turnstile.reset();
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
          {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
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

/**
 * Where a verification link lands when it is opened anywhere but the browser that signed up
 * (the server's GET changed nothing — a mail scanner fetches links too). Nothing has happened
 * yet: the address is confirmed, the account made this person's and its password set by the ONE
 * request this form's button sends (`POST /api/account/confirm-email`), which also carries what
 * a sign-up states — the age check and the assent to the terms. This person never stated them:
 * whoever typed the address into the sign-up form did.
 */
export function SetPasswordPage() {
  const navigate = useNavigate();
  const token = useLinkToken();
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  const [password, setPassword] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; birth?: string; assent?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!token) return;
    const found: typeof errors = {};
    if (password.length < PASSWORD_MIN) found.password = t("signup.error.password");
    else if (password.length > PASSWORD_MAX) found.password = t("signup.error.passwordLong");
    const birth = parseBirth({ birthMonth, birthYear });
    if (!birth) found.birth = t("signup.error.birth");
    else if (!isThirteenOrOlder(birth.year, birth.month)) found.birth = t("signup.error.age");
    if (!acceptTerms) found.assent = t("signup.error.assent");
    setErrors(found);
    if (Object.keys(found).length > 0 || !birth) return;
    if (config?.turnstileSiteKey && !turnstile.token) {
      setFormError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    setBusy(true);
    try {
      await api("/api/account/confirm-email", {
        method: "POST",
        body: {
          token,
          newPassword: password,
          birthYear: birth.year,
          birthMonth: birth.month,
          acceptTerms: true,
        },
        ...captchaOptions(turnstile.token),
      });
    } catch (cause) {
      turnstile.reset();
      setBusy(false);
      const reason = cause instanceof ApiError ? cause.details?.reason : undefined;
      if (cause instanceof ApiError && cause.code === "invalid_token") setInvalid(true);
      else if (reason === "PASSWORD_COMPROMISED") setErrors({ password: t("signup.password.breached") });
      else if (cause instanceof ApiError && cause.code === "validation" && typeof reason === "string") {
        setFormError(cause.message);
      } else setFormError(t("auth.error.generic"));
      return;
    }
    navigate("/login?reason=password_set", { replace: true });
  };

  const unusable = !token || invalid;
  return (
    <AuthCard title={t("setPassword.title")} lead={unusable ? undefined : t("setPassword.body")}>
      {unusable ? (
        <FormNotice tone="danger">{t("setPassword.missing")}</FormNotice>
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
            errorText={errors.password}
          />
          <Box component="fieldset" sx={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <Box
              component="legend"
              sx={{
                padding: 0,
                marginBottom: "6px",
                fontSize: 12,
                lineHeight: "16px",
                color: hf.textSecondary,
              }}
            >
              {t("signup.birth")}
            </Box>
            <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
              <Field
                label={t("signup.birth.month")}
                hideLabel
                name="birthMonth"
                mono
                placeholder="MM"
                autoComplete="bday-month"
                value={birthMonth}
                onChange={(e) => setBirthMonth(e.target.value)}
                slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 2 } }}
              />
              <Field
                label={t("signup.birth.year")}
                hideLabel
                name="birthYear"
                mono
                placeholder="YYYY"
                autoComplete="bday-year"
                value={birthYear}
                onChange={(e) => setBirthYear(e.target.value)}
                slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 4 } }}
              />
            </Box>
            <Box sx={{ marginTop: "6px", fontSize: 12, lineHeight: "16px", color: hf.textSecondary }}>
              {t("signup.birth.note")}
            </Box>
            {errors.birth ? <FormError>{errors.birth}</FormError> : null}
          </Box>
          <Box>
            <Box
              component="label"
              sx={{
                display: "flex",
                alignItems: "flex-start",
                gap: 2,
                fontSize: 12,
                lineHeight: "16px",
                color: hf.textSecondary,
                minHeight: 24,
                cursor: "pointer",
                "@media (max-width:1023.95px)": { minHeight: 44, alignItems: "center" },
              }}
            >
              <Box
                component="input"
                type="checkbox"
                name="acceptTerms"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                sx={{ width: 16, height: 16, margin: 0, flex: "none" }}
              />
              <span className="prose">
                {t("signup.assent.before")}
                <a href={EXTERNAL_LINKS.terms} target="_blank" rel="noopener">
                  {t("legal.terms")}
                </a>
                {t("signup.assent.and")}
                <a href={EXTERNAL_LINKS.privacy} target="_blank" rel="noopener">
                  {t("terms.privacyPolicy")}
                </a>
                {t("signup.assent.after")}
              </span>
            </Box>
            {errors.assent ? <FormError>{errors.assent}</FormError> : null}
          </Box>
          {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
          <FormError>{formError}</FormError>
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            {t("setPassword.submit")}
          </Button>
        </Box>
      )}
      <Box component={RouterLink} to={unusable ? "/forgot-password" : "/login"} sx={backSx}>
        {unusable ? t("forgot.submit") : t("forgot.back")}
      </Box>
    </AuthCard>
  );
}
