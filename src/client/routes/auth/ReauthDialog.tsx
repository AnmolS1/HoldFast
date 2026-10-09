import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { cancelReauth, completeReauth, isReauthPending, subscribeGates } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { t } from "../../lib/i18n";
import { clearSession, getCachedSession, refreshSession, usePublicConfig } from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { Field, FormError, PasskeyIcon, TurnstileBox } from "./parts";

function ReauthForm() {
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  // The session query still holds the user the session belonged to.
  const email = getCachedSession()?.user.email ?? "";
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"password" | "code">("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    await refreshSession();
    completeReauth();
  };

  const onPasskey = async () => {
    setError(null);
    setBusy(true);
    const result = await callAuth(() => authClient.signIn.passkey());
    setBusy(false);
    if (result.error) {
      setError(result.error.code === "NOT_WIRED" ? t("auth.notWired") : t("auth.error.passkey"));
      return;
    }
    await finish();
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (step === "code") {
      setBusy(true);
      const result = await callAuth(() => authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") }));
      setBusy(false);
      if (result.error) {
        setError(t("twoFactor.failed"));
        return;
      }
      await finish();
      return;
    }
    if (password === "") {
      setError(t("reauth.failed"));
      return;
    }
    if (config?.turnstileSiteKey && !turnstile.token) {
      setError(t(turnstile.status === "error" ? "auth.humanFailed" : "auth.humanWait"));
      return;
    }
    setBusy(true);
    const result = await callAuth(() => authClient.signIn.email({ email, password, fetchOptions: captchaOptions(turnstile.token) }));
    turnstile.reset();
    setBusy(false);
    if (result.error) {
      setError(result.error.status === 401 ? t("reauth.failed") : authErrorMessage(result.error, "reauth.failed"));
      return;
    }
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      setStep("code");
      return;
    }
    await finish();
  };

  const signOut = () => {
    cancelReauth();
    clearSession();
    window.location.assign("/login");
  };

  return (
    <Box component="form" noValidate onSubmit={onSubmit} sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {step === "password" ? (
        <>
          <Button size="large" onClick={onPasskey} disabled={busy} startIcon={<PasskeyIcon />}>
            {t("reauth.passkey")}
          </Button>
          {/* The address is fixed: this dialog re-opens the same account, it does not switch accounts. */}
          <Field label={t("auth.email")} type="email" name="email" autoComplete="username" value={email} slotProps={{ htmlInput: { readOnly: true } }} />
          <Field label={t("reauth.password")} type="password" name="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
        </>
      ) : (
        <Field label={t("twoFactor.code")} name="code" mono autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 7 } }} />
      )}
      <FormError>{error}</FormError>
      <Button type="submit" variant="contained" size="large" disabled={busy}>
        {t(step === "password" ? "reauth.submit" : "app.continue")}
      </Button>
      <Button variant="text" onClick={signOut} disabled={busy}>
        {t("reauth.signOut")}
      </Button>
    </Box>
  );
}

/**
 * "Your session ended — sign in to continue." Opens when the API client holds a request that got
 * a qualifying 401; signing in here replays every held request. It cannot be dismissed: the only
 * ways out are to sign in or to leave for the sign-in page. Mounted once at the app root.
 */
export function ReauthDialog() {
  const open = useSyncExternalStore(subscribeGates, isReauthPending, isReauthPending);
  const titleId = useId();
  const bodyId = useId();
  return (
    <Dialog open={open} aria-labelledby={titleId} aria-describedby={bodyId} maxWidth="xs" fullWidth data-reauth-dialog>
      <DialogTitle id={titleId}>{t("reauth.title")}</DialogTitle>
      <DialogContent>
        <Typography id={bodyId} sx={{ color: hf.textSecondary, marginBottom: 3 }}>
          {t("reauth.body")}
        </Typography>
        {open ? <ReauthForm /> : null}
      </DialogContent>
    </Dialog>
  );
}
