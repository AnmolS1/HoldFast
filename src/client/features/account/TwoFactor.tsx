// Two-factor (TOTP): turn on (the password, then the app's key and a code), backup codes (shown
// once, downloadable as .txt, made anew), turn off. Every call that reads or changes the factor
// goes through the step-up (./StepUp.tsx). Disabling asks for the password — and for a code too
// when this session has not passed the factor (the step-up).
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "../../components/Toaster";
import { accountEpoch, refreshSession, sameAccount, useSession } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { accountKeys, twoFactorQuery } from "./api";
import {
  AUTH_CODES,
  disableTwoFactor,
  enableTwoFactor,
  generateBackupCodes,
  secretOf,
  verifyTotp,
} from "./auth-calls";
import { saveText } from "./download";
import { failureText } from "./failures";
import { useStepUp } from "./step-up";
import { t } from "./strings";
import { LabeledField, Note, PasswordDialog, Section, StatusLine } from "./ui";

function BackupCodes({ codes, email, onDone }: { codes: string[]; email: string; onDone(): void }) {
  return (
    <Box data-backup-codes sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box component="h3" sx={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        {t("twoFactor.backup.title")}
      </Box>
      <Note>{t("twoFactor.backup.body")}</Note>
      <Box
        component="ul"
        className="mono"
        sx={{
          margin: 0,
          padding: 3,
          listStyle: "none",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 1,
          backgroundColor: hf.surface2,
          borderRadius: `${layout.radius.control}px`,
        }}
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </Box>
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        <Button
          variant="outlined"
          onClick={() =>
            saveText(
              `${t("twoFactor.backup.file", { email })}\n\n${codes.join("\n")}\n`,
              "holdfast-backup-codes.txt",
            )
          }
        >
          {t("twoFactor.backup.download")}
        </Button>
        <Button variant="contained" onClick={onDone}>
          {t("twoFactor.backup.done")}
        </Button>
      </Box>
    </Box>
  );
}

type Stage =
  { at: "idle" } | { at: "verify"; uri: string; codes: string[] } | { at: "codes"; codes: string[] };

type Asking = "enable" | "regenerate" | "disable" | null;

export function TwoFactorPart() {
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const email = useSession().data?.user.email ?? "";
  const state = useQuery(twoFactorQuery);
  const [stage, setStage] = useState<Stage>({ at: "idle" });
  const [asking, setAsking] = useState<Asking>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  const enabled = state.data === true;

  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: accountKeys.twoFactor });
    void refreshSession().catch(() => {});
  };

  const onPassword = async (password: string) => {
    const then = accountEpoch();
    setBusy(true);
    setPasswordError(null);
    setFailure(null);
    const result =
      asking === "enable"
        ? await stepUp(() => enableTwoFactor(password))
        : asking === "regenerate"
          ? await stepUp(() => generateBackupCodes(password))
          : await stepUp(() => disableTwoFactor(password));
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      if (result.error.code === AUTH_CODES.invalidPassword) setPasswordError(t("account.passwordWrong"));
      else {
        setAsking(null);
        // The step-up's own refusal was shown in its prompt; the action did not happen.
        if (result.error.code !== AUTH_CODES.secondFactorRequired) setFailure(failureText(result.error));
      }
      return;
    }
    const doing = asking;
    setAsking(null);
    if (doing === "enable") {
      const data = result.data as { totpURI: string; backupCodes: string[] };
      setStage({ at: "verify", uri: data.totpURI, codes: data.backupCodes });
    } else if (doing === "regenerate") {
      setStage({ at: "codes", codes: (result.data as { backupCodes: string[] }).backupCodes });
    } else {
      setStage({ at: "idle" });
      toast({ message: t("twoFactor.disabled"), key: "two-factor" });
      await changed();
    }
  };

  const onVerify = async (event: FormEvent, codes: string[]) => {
    event.preventDefault();
    const value = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(value)) {
      setCodeError(t("twoFactor.code.error"));
      return;
    }
    const then = accountEpoch();
    setCodeError(null);
    setBusy(true);
    const result = await verifyTotp(value);
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      setCodeError(result.error.status === 429 ? failureText(result.error) : t("twoFactor.code.wrong"));
      return;
    }
    setCode("");
    setStage({ at: "codes", codes });
    toast({ message: t("twoFactor.enabled"), key: "two-factor" });
    await changed();
  };

  return (
    <Section id="two-factor" title={t("twoFactor.title")}>
      {state.isError ? (
        <StatusLine tone="error">{t("account.error.title")}</StatusLine>
      ) : (
        <Note>{enabled ? t("twoFactor.on") : t("twoFactor.off")}</Note>
      )}
      <StatusLine tone="error">{failure}</StatusLine>
      {stage.at === "idle" && state.data !== undefined ? (
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          {enabled ? (
            <>
              <Button variant="outlined" onClick={() => setAsking("regenerate")}>
                {t("twoFactor.backup.regenerate")}
              </Button>
              <Button variant="outlined" color="error" onClick={() => setAsking("disable")}>
                {t("twoFactor.disable")}
              </Button>
            </>
          ) : (
            <Button variant="contained" onClick={() => setAsking("enable")}>
              {t("twoFactor.enable")}
            </Button>
          )}
        </Box>
      ) : null}
      {stage.at === "verify" ? (
        <Box
          component="form"
          noValidate
          data-two-factor-setup
          onSubmit={(event) => void onVerify(event, stage.codes)}
          sx={{ display: "flex", flexDirection: "column", gap: 3 }}
        >
          <Box component="h3" sx={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {t("twoFactor.setup.title")}
          </Box>
          <Note>{t("twoFactor.setup.step1")}</Note>
          <Box>
            <Button component="a" href={stage.uri} variant="outlined">
              {t("twoFactor.setup.link")}
            </Button>
          </Box>
          <Box>
            <Box sx={{ fontSize: 12, color: hf.textSecondary }}>{t("twoFactor.setup.secret")}</Box>
            <Box
              className="mono"
              data-totp-secret
              sx={{ overflowWrap: "anywhere", fontSize: 15, letterSpacing: "0.08em" }}
            >
              {secretOf(stage.uri)}
            </Box>
          </Box>
          <Note>{t("twoFactor.setup.step2")}</Note>
          <LabeledField
            label={t("twoFactor.code")}
            name="code"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            error={codeError}
            slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 6 } }}
          />
          <Box sx={{ display: "flex", gap: 2 }}>
            <Button type="submit" variant="contained" disabled={busy}>
              {t("twoFactor.verify")}
            </Button>
            <Button onClick={() => setStage({ at: "idle" })} disabled={busy}>
              {t("account.cancel")}
            </Button>
          </Box>
        </Box>
      ) : null}
      {stage.at === "codes" ? (
        <BackupCodes codes={stage.codes} email={email} onDone={() => setStage({ at: "idle" })} />
      ) : null}
      <PasswordDialog
        open={asking !== null}
        title={
          asking === "disable"
            ? t("twoFactor.disable")
            : asking === "regenerate"
              ? t("twoFactor.backup.regenerate")
              : t("twoFactor.setup.title")
        }
        body={
          asking === "disable"
            ? t("twoFactor.disable.body")
            : asking === "regenerate"
              ? t("twoFactor.backup.regenerate.body")
              : t("twoFactor.enable.password")
        }
        confirmLabel={asking === "disable" ? t("twoFactor.disable") : t("stepUp.submit")}
        error={passwordError}
        busy={busy}
        onSubmit={(password) => void onPassword(password)}
        onCancel={() => {
          setAsking(null);
          setPasswordError(null);
        }}
      />
    </Section>
  );
}
