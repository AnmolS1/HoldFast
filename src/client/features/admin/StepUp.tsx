// The step-up prompt of the console (R-g; the account feature has its own — PLAN §6 rule 2: no
// cross-feature import). A code from the authenticator app or a backup code, posted by THIS
// session to Better Auth's verify endpoints, marks the session as having passed the second factor
// (auth/second-factor.ts grant 2); the refused request is then sent again by `withStepUp`. An
// account without two-factor cannot step up: it is told to turn it on first. A spent code budget
// (`429`, `Retry-After`) is held in the shell's wait registry; nothing is sent by itself.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { api } from "../../lib/api";
import { holdUntil } from "../../lib/query";
import { SECOND_FACTOR_THROTTLED, verifyBackupCode, verifyTotp } from "./auth-calls";
import { answerStepUp, registerStepUpProvider, STEP_UP_WAIT, useStepUpOpen } from "./step-up";
import { t } from "./strings";
import { Field, Note, StatusLine } from "./ui";
import { useSecondsLeft, waitText } from "./words";

export function StepUpProvider({ children }: { children: ReactNode }) {
  useEffect(() => registerStepUpProvider(), []);
  const open = useStepUpOpen();
  return (
    <>
      {children}
      {open ? <StepUpDialog /> : null}
    </>
  );
}

/** Whether the account has two-factor at all (the session's raw user carries the flag). */
async function accountHasTwoFactor(): Promise<boolean> {
  try {
    const raw = await api<{ user?: { twoFactorEnabled?: unknown } } | null>("/api/auth/get-session");
    return raw?.user?.twoFactorEnabled === true;
  } catch {
    return true;
  }
}

function StepUpDialog() {
  const titleId = useId();
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = useSecondsLeft(STEP_UP_WAIT);

  useEffect(() => {
    let live = true;
    void accountHasTwoFactor().then((value) => {
      if (live) setEnrolled(value);
    });
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (left > 0 || busy) return;
    const value = code.trim().replace(/\s+/g, "");
    const valid = backup ? /^[A-Za-z0-9-]{1,32}$/.test(value) : /^\d{6}$/.test(value);
    if (!valid) {
      setError(t("stepUp.code.error"));
      return;
    }
    setError(null);
    setBusy(true);
    const result = backup ? await verifyBackupCode(value) : await verifyTotp(value);
    setBusy(false);
    if (!result.error) {
      answerStepUp(true);
      return;
    }
    if (result.error.status === 429 && result.error.code === SECOND_FACTOR_THROTTLED) {
      if (result.error.retryAfter !== undefined) {
        holdUntil(STEP_UP_WAIT, Date.now() + result.error.retryAfter * 1000);
      } else setError(t("common.failed"));
      return;
    }
    setError(
      result.error.status === 401 || result.error.status === 400 ? t("stepUp.wrong") : t("common.failed"),
    );
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : () => answerStepUp(false)}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="xs"
      data-admin-step-up
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={titleId}>{t("stepUp.title")}</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {enrolled === false ? (
            <Note>
              {t("stepUp.noFactor")}{" "}
              <RouterLink to="/account/security" onClick={() => answerStepUp(false)}>
                {t("stepUp.enable")}
              </RouterLink>
            </Note>
          ) : (
            <>
              <Note>{t("stepUp.body")}</Note>
              <Field
                label={backup ? t("stepUp.backup") : t("stepUp.code")}
                name="code"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                error={error}
                slotProps={{
                  htmlInput: { inputMode: backup ? "text" : "numeric", maxLength: backup ? 32 : 6 },
                }}
              />
              {left > 0 ? (
                <StatusLine tone="error">
                  <span data-step-up-wait={left}>{t("stepUp.throttled", { wait: waitText(left) })}</span>
                </StatusLine>
              ) : null}
              <Box>
                <Button
                  size="small"
                  onClick={() => {
                    setBackup((value) => !value);
                    setCode("");
                    setError(null);
                  }}
                >
                  {backup ? t("stepUp.useApp") : t("stepUp.useBackup")}
                </Button>
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => answerStepUp(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          {enrolled === false ? null : (
            <Button type="submit" variant="contained" disabled={busy || left > 0}>
              {t("stepUp.submit")}
            </Button>
          )}
        </DialogActions>
      </Box>
    </Dialog>
  );
}
