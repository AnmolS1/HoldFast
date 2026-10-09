import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { completeReauth, isReauthPending, subscribeGates } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { t } from "../../lib/i18n";
import {
  confirmReauthIdentity,
  getCachedSession,
  getKnownUserId,
  purgeUserState,
  usePublicConfig,
} from "../../lib/query";
import { useTurnstile } from "../../lib/turnstile";
import { hf } from "../../theme/tokens";
import { authErrorMessage, captchaOptions } from "./errors";
import { Field, FormError, PasskeyIcon, TurnstileBox } from "./parts";

function ReauthForm() {
  const config = usePublicConfig().data;
  const turnstile = useTurnstile(config?.turnstileSiteKey);
  // The session query still holds the user the session belonged to.
  const email = getCachedSession()?.user.email ?? "";
  // Whose session ended. The held requests carry THAT person's intent.
  const [expectedUserId] = useState(() => getCachedSession()?.user.id ?? getKnownUserId());
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"password" | "code">("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Replay only for the same account. A passkey (or a 2FA step) can sign a DIFFERENT account in:
  // then the held requests are discarded, the old account's state is purged, and the page starts
  // again at the root as the new account.
  const finish = async () => {
    const outcome = await confirmReauthIdentity(expectedUserId);
    if (outcome === "same") {
      completeReauth();
      return;
    }
    window.location.assign("/");
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
      const result = await callAuth(() =>
        authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") }),
      );
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
    const result = await callAuth(() =>
      authClient.signIn.email({ email, password, fetchOptions: captchaOptions(turnstile.token) }),
    );
    turnstile.reset();
    setBusy(false);
    if (result.error) {
      setError(
        result.error.status === 401 ? t("reauth.failed") : authErrorMessage(result.error, "reauth.failed"),
      );
      return;
    }
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      setStep("code");
      return;
    }
    await finish();
  };

  // Leaving instead of signing in: end the session on the server too, discard what was held,
  // drop the account's state, and load the sign-in page fresh.
  const signOut = async () => {
    setBusy(true);
    await callAuth(() => authClient.signOut());
    await purgeUserState();
    window.location.assign("/login");
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={onSubmit}
      sx={{ display: "flex", flexDirection: "column", gap: 3 }}
    >
      {step === "password" ? (
        <>
          <Button size="large" onClick={onPasskey} disabled={busy} startIcon={<PasskeyIcon />}>
            {t("reauth.passkey")}
          </Button>
          {/* The address is fixed: this dialog re-opens the same account, it does not switch accounts. */}
          <Field
            label={t("auth.email")}
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            slotProps={{ htmlInput: { readOnly: true } }}
          />
          <Field
            label={t("reauth.password")}
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {config?.turnstileSiteKey ? <TurnstileBox turnstile={turnstile} /> : null}
        </>
      ) : (
        <Field
          label={t("twoFactor.code")}
          name="code"
          mono
          autoFocus
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 7 } }}
        />
      )}
      <FormError>{error}</FormError>
      <Button type="submit" variant="contained" size="large" disabled={busy}>
        {t(step === "password" ? "reauth.submit" : "app.continue")}
      </Button>
      <Button variant="text" onClick={() => void signOut()} disabled={busy}>
        {t("reauth.signOut")}
      </Button>
    </Box>
  );
}

/**
 * "Your session ended — sign in to continue." Opens when the API client holds a request that got
 * a qualifying 401; signing in here AS THE SAME ACCOUNT replays every held request (another
 * account discards them and starts clean). The backdrop is opaque. It cannot be dismissed: the only
 * ways out are to sign in or to leave for the sign-in page. Mounted once at the app root.
 */
export function ReauthDialog() {
  const open = useSyncExternalStore(subscribeGates, isReauthPending, isReauthPending);
  const titleId = useId();
  const bodyId = useId();
  return (
    <Dialog
      open={open}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      maxWidth="xs"
      fullWidth
      data-reauth-dialog
      // Opaque, not the usual scrim: with no session, the previous screen must not stay readable.
      slotProps={{ backdrop: { "data-reauth-backdrop": true, sx: { backgroundColor: hf.bg } } as object }}
    >
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
