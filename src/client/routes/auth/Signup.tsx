import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router";
import { api, ApiError } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { EXTERNAL_LINKS } from "../../lib/contracts";
import { t } from "../../lib/i18n";
import { usePublicConfig } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { AuthCard, Field, FormError, FormNotice, GoogleIcon, OrDivider, TurnstileBox } from "./parts";
import { parseBirth, passwordStrength, safeNext, validateIntent, validateSignup, type SignupErrors, type SignupValues } from "./validation";

const linkSx = { color: hf.text, textDecoration: "underline", textUnderlineOffset: "2px" } as const;

function StrengthMeter({ password }: { password: string }) {
  const score = passwordStrength(password);
  if (password === "") return <>{t("signup.password.help")}</>;
  return (
    <>
      <Box component="span" aria-hidden="true" sx={{ display: "flex", gap: "4px", margin: "2px 0 4px" }}>
        {[1, 2, 3, 4].map((step) => (
          <Box key={step} component="span" sx={{ flex: 1, height: 3, borderRadius: "2px", backgroundColor: step <= score ? hf.text : hf.hairline }} />
        ))}
      </Box>
      <span data-strength={score}>
        {t(`signup.password.strength.${score}`)}. {t("signup.password.help")}
      </span>
    </>
  );
}

/** Sign up: invite (beta), age check (not stored), terms assent, Turnstile. */
export function SignupPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const config = usePublicConfig().data;
  const inviteRequired = config?.signupMode === "invite";
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  const [values, setValues] = useState<SignupValues>({
    name: "",
    email: "",
    password: "",
    inviteCode: params.get("invite") ?? "",
    birthMonth: "",
    birthYear: "",
    acceptTerms: false,
  });
  const [errors, setErrors] = useState<SignupErrors>({});
  const [passwordServerError, setPasswordServerError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inviteState = params.get("valid");

  const set = <K extends keyof SignupValues>(key: K, value: SignupValues[K]) => setValues((current) => ({ ...current, [key]: value }));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setPasswordServerError(null);
    const found = validateSignup(values, { inviteRequired });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (config?.turnstileSiteKey && !turnstile.token) {
      setFormError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    const birth = parseBirth(values);
    if (!birth) return;
    setBusy(true);
    const result = await callAuth(() =>
      authClient.signUp.email({
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
        inviteCode: inviteRequired ? values.inviteCode.trim() : undefined,
        birthYear: birth.year,
        birthMonth: birth.month,
        acceptTerms: true,
        callbackURL: "/login?reason=verified",
        fetchOptions: captchaOptions(turnstile.token),
      }),
    );
    turnstile.reset();
    setBusy(false);
    if (result.error) {
      if (result.error.code === "PASSWORD_COMPROMISED") setPasswordServerError(t("signup.password.breached"));
      else setFormError(authErrorMessage(result.error));
      return;
    }
    navigate("/verify-email", { state: { email: values.email.trim() } });
  };

  // Google sign-ups carry invite, age and assent through a signed intent cookie set first.
  const onGoogle = async () => {
    setFormError(null);
    const found = validateIntent(values, { inviteRequired });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const birth = parseBirth(values);
    if (!birth) return;
    setBusy(true);
    try {
      await api("/api/auth-intent", {
        method: "POST",
        body: { inviteCode: inviteRequired ? values.inviteCode.trim() : undefined, birthYear: birth.year, birthMonth: birth.month, acceptTerms: true },
      });
    } catch (cause) {
      setBusy(false);
      setFormError(cause instanceof ApiError && cause.status >= 400 && cause.status < 500 ? cause.message : t("auth.error.generic"));
      return;
    }
    const result = await callAuth(() => authClient.signIn.social({ provider: "google", callbackURL: next, errorCallbackURL: "/signup" }));
    setBusy(false);
    if (result.error) setFormError(authErrorMessage(result.error));
  };

  return (
    <AuthCard title={t("signup.title")} lead={inviteRequired ? t("signup.invite.note") : undefined}>
      {inviteState === "0" ? <FormNotice tone="danger">{t("signup.invite.invalid")}</FormNotice> : null}
      {inviteState === "1" ? <FormNotice>{t("signup.invite.valid")}</FormNotice> : null}
      <Box component="form" noValidate onSubmit={onSubmit} sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {inviteRequired ? (
          <Field label={t("signup.invite")} name="inviteCode" mono autoComplete="off" value={values.inviteCode} onChange={(e) => set("inviteCode", e.target.value)} errorKey={errors.inviteCode} slotProps={{ htmlInput: { autoCapitalize: "characters", spellCheck: false } }} />
        ) : null}
        <Field label={t("auth.name")} name="name" autoComplete="name" value={values.name} onChange={(e) => set("name", e.target.value)} errorKey={errors.name} />
        <Field label={t("auth.email")} type="email" name="email" autoComplete="email" value={values.email} onChange={(e) => set("email", e.target.value)} errorKey={errors.email} />
        <Field
          label={t("auth.password")}
          type="password"
          name="password"
          autoComplete="new-password"
          value={values.password}
          onChange={(e) => set("password", e.target.value)}
          errorKey={errors.password}
          errorText={passwordServerError ?? undefined}
          help={<StrengthMeter password={values.password} />}
        />
        <Box component="fieldset" sx={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Box component="legend" sx={{ padding: 0, marginBottom: "6px", fontSize: 12, lineHeight: "16px", color: hf.textSecondary }}>
            {t("signup.birth")}
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
            <Field label={t("signup.birth.month")} hideLabel name="birthMonth" mono placeholder="MM" autoComplete="bday-month" value={values.birthMonth} onChange={(e) => set("birthMonth", e.target.value)} slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 2 } }} />
            <Field label={t("signup.birth.year")} hideLabel name="birthYear" mono placeholder="YYYY" autoComplete="bday-year" value={values.birthYear} onChange={(e) => set("birthYear", e.target.value)} slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 4 } }} />
          </Box>
          <Box sx={{ marginTop: "6px", fontSize: 12, lineHeight: "16px", color: hf.textSecondary }}>{t("signup.birth.note")}</Box>
          {errors.birth ? <FormError>{t(errors.birth)}</FormError> : null}
        </Box>
        <Box>
          <Box component="label" sx={{ display: "flex", alignItems: "flex-start", gap: 2, fontSize: 12, lineHeight: "16px", color: hf.textSecondary, minHeight: 24, cursor: "pointer", "@media (max-width:1023.95px)": { minHeight: 44, alignItems: "center" } }}>
            <Box component="input" type="checkbox" name="acceptTerms" checked={values.acceptTerms} onChange={(e) => set("acceptTerms", e.target.checked)} sx={{ width: 16, height: 16, margin: "0 0 0 0", flex: "none" }} />
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
          {errors.acceptTerms ? <FormError>{t(errors.acceptTerms)}</FormError> : null}
        </Box>
        {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
        <FormError>{formError}</FormError>
        <Button type="submit" variant="contained" size="large" disabled={busy}>
          {t("signup.submit")}
        </Button>
        <OrDivider />
        <Button size="large" onClick={onGoogle} disabled={busy} startIcon={<GoogleIcon />}>
          {t("auth.google")}
        </Button>
      </Box>
      <Box component={RouterLink} to="/login" sx={{ ...linkSx, fontSize: 12, display: "inline-flex", alignItems: "center", minHeight: 24, "@media (max-width:1023.95px)": { minHeight: 44 } }}>
        {t("signup.have")}
      </Box>
    </AuthCard>
  );
}
