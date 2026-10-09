import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { api, ApiError } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { formatCountdown } from "../../lib/format";
import { t } from "../../lib/i18n";
import { usePublicConfig, useSession } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { AuthCard, Field, FormError, FormNotice, TurnstileBox } from "./parts";
import { isEmail } from "./validation";

export const RESEND_COOLDOWN_S = 60;

/** Seconds left until `until` (ms epoch), ticking once a second; never more than `max`. */
function useCountdown(until: number, max: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  // `now` is up to a second old when `until` is pushed out, hence the cap.
  return Math.min(max, Math.max(0, Math.ceil((until - now) / 1000)));
}

/** "Check your email", with the two escapes people need: send it again, and fix a wrong address. */
export function VerifyEmailPage() {
  const location = useLocation();
  const session = useSession().data;
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  const state = location.state as { email?: unknown; unconfirmed?: unknown } | null;
  const fromState = state?.email;
  // Arrived from a sign-in that was refused because the address is unconfirmed: nothing was sent
  // just now, so there is nothing to wait for before sending.
  const unconfirmed = state?.unconfirmed === true;
  const [email, setEmail] = useState<string | null>(
    session?.user.email ?? (typeof fromState === "string" ? fromState : null),
  );
  const [cooldownUntil, setCooldownUntil] = useState(() =>
    unconfirmed ? 0 : Date.now() + RESEND_COOLDOWN_S * 1000,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const left = useCountdown(cooldownUntil, RESEND_COOLDOWN_S);

  const onResend = async () => {
    if (!email || left > 0) return;
    setError(null);
    setNotice(null);
    if (config?.turnstileSiteKey && !turnstile.token) {
      setError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    setBusy(true);
    const result = await callAuth(() =>
      authClient.sendVerificationEmail({
        email,
        callbackURL: "/login?reason=verified",
        fetchOptions: captchaOptions(turnstile.token),
      }),
    );
    turnstile.reset();
    setBusy(false);
    if (result.error) {
      setError(
        result.error.code === "NOT_WIRED" ? authErrorMessage(result.error) : t("verify.resend.failed"),
      );
      return;
    }
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_S * 1000);
    setNotice(t("verify.resent"));
  };

  const onChange = async (event: FormEvent) => {
    event.preventDefault();
    setDraftError(null);
    setNotice(null);
    const next = draft.trim();
    if (!isEmail(next)) {
      setDraftError(t("signup.error.email"));
      return;
    }
    setBusy(true);
    try {
      await api("/api/account/pending-email", { method: "PATCH", body: { email: next } });
    } catch (cause) {
      setBusy(false);
      setDraftError(
        cause instanceof ApiError && cause.code === "validation" ? cause.message : t("verify.change.failed"),
      );
      return;
    }
    setBusy(false);
    setEmail(next);
    setChanging(false);
    setDraft("");
    setCooldownUntil(Date.now() + RESEND_COOLDOWN_S * 1000);
    setNotice(t("verify.change.done"));
  };

  return (
    <AuthCard
      title={t(unconfirmed ? "verify.unconfirmed.title" : "verify.title")}
      lead={
        email ? (
          <>
            {t(unconfirmed ? "verify.unconfirmed.before" : "verify.body.before")}
            <Box
              component="strong"
              data-verify-email
              sx={{ color: hf.text, fontWeight: 500, overflowWrap: "anywhere" }}
            >
              {email}
            </Box>
            {t(unconfirmed ? "verify.unconfirmed.after" : "verify.body.after")}
          </>
        ) : (
          t("verify.body.unknown")
        )
      }
    >
      {notice ? <FormNotice>{notice}</FormNotice> : null}
      {email ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
          <Button size="large" onClick={onResend} disabled={busy || left > 0} data-resend>
            {t("verify.resend")}
            {left > 0 ? (
              <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
                {t("verify.resend.in", { time: formatCountdown(left) })}
              </Box>
            ) : null}
          </Button>
          <FormError>{error}</FormError>
          {changing ? (
            <Box
              component="form"
              noValidate
              onSubmit={onChange}
              sx={{ display: "flex", flexDirection: "column", gap: 2 }}
            >
              <Field
                label={t("verify.change.label")}
                type="email"
                name="newEmail"
                autoComplete="email"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                errorText={draftError ?? undefined}
              />
              <Button type="submit" variant="contained" size="large" disabled={busy}>
                {t("verify.change.submit")}
              </Button>
            </Box>
          ) : (
            <Button variant="text" size="large" onClick={() => setChanging(true)}>
              {t("verify.change")}
            </Button>
          )}
        </Box>
      ) : null}
      <Box
        component={RouterLink}
        to="/login"
        sx={{
          color: hf.text,
          fontSize: 12,
          textDecoration: "underline",
          textUnderlineOffset: "2px",
          display: "inline-flex",
          alignItems: "center",
          minHeight: 24,
          "@media (max-width:1023.95px)": { minHeight: 44 },
        }}
      >
        {t("forgot.back")}
      </Box>
    </AuthCard>
  );
}
