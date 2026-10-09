import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { t } from "../../lib/i18n";
import { refreshSession } from "../../lib/query";
import { hf } from "../../theme/tokens";
import { AuthCard, Field } from "./parts";
import { safeNext } from "./validation";

/** The second factor: a six-digit code, or a backup code; optionally trust this device. */
export function TwoFactorPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const value = code.replace(/\s+/g, "");
    if (mode === "totp" && !/^\d{6}$/.test(value)) {
      setError(t("twoFactor.error.code"));
      return;
    }
    if (mode === "backup" && value === "") {
      setError(t("twoFactor.error.backup"));
      return;
    }
    setBusy(true);
    const result = await callAuth(() =>
      mode === "totp" ? authClient.twoFactor.verifyTotp({ code: value, trustDevice: trust }) : authClient.twoFactor.verifyBackupCode({ code: value, trustDevice: trust }),
    );
    setBusy(false);
    if (result.error) {
      setError(result.error.code === "NOT_WIRED" ? t("auth.notWired") : result.error.status === 429 ? t("auth.error.rate") : t("twoFactor.failed"));
      return;
    }
    await refreshSession();
    navigate(next, { replace: true });
  };

  const totp = mode === "totp";
  return (
    <AuthCard title={t(totp ? "twoFactor.title" : "twoFactor.backup.title")} lead={t(totp ? "twoFactor.body" : "twoFactor.backup.body")}>
      <Box component="form" noValidate onSubmit={onSubmit} sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <Field
          key={mode}
          label={t(totp ? "twoFactor.code" : "twoFactor.backup.code")}
          hideLabel
          name="code"
          mono
          autoFocus
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          errorText={error ?? undefined}
          slotProps={{ htmlInput: totp ? { inputMode: "numeric", maxLength: 7, style: { fontSize: 20, letterSpacing: "0.3em", textAlign: "center", height: 48 } } : { spellCheck: false, autoCapitalize: "off" } }}
        />
        <Box component="label" sx={{ display: "flex", alignItems: "center", gap: 2, fontSize: 12, color: hf.textSecondary, minHeight: 24, cursor: "pointer" }}>
          <Box component="input" type="checkbox" name="trustDevice" checked={trust} onChange={(e) => setTrust(e.target.checked)} sx={{ width: 16, height: 16, margin: 0 }} />
          {t("twoFactor.trust")}
        </Box>
        <Button type="submit" variant="contained" size="large" disabled={busy}>
          {t("app.continue")}
        </Button>
      </Box>
      <Button
        variant="text"
        onClick={() => {
          setMode(totp ? "backup" : "totp");
          setCode("");
          setError(null);
        }}
      >
        {t(totp ? "twoFactor.useBackup" : "twoFactor.useTotp")}
      </Button>
    </AuthCard>
  );
}
