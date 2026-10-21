// The step-up screen (EXECUTION 2026-10-11 ruling (6)). Once an enrolment is confirmed, the
// endpoints that read or change the second factor answer a session that has not itself passed it
// `403 SECOND_FACTOR_REQUIRED` (auth/second-factor.ts TWO_FACTOR_MANAGE_PATHS). Here that answer
// opens a prompt for a code — from the app or a backup code — which steps THIS session up
// (`/two-factor/verify-totp` or `/verify-backup-code` sent by a session), and then the action is
// repeated once. A spent budget is `429 SECOND_FACTOR_THROTTLED` with `Retry-After`: the wait is
// shown and recorded in the shell's registry, submit stays disabled until it has passed, and
// nothing is sent by itself.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { useCallback, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AUTH_CODES, verifyBackupCode, verifyTotp } from "./auth-calls";
import { failureText, holdFor, useSecondsLeft, waitText } from "./failures";
import { STEP_UP_WAIT, StepUpContext, type Run } from "./step-up";
import { t } from "./strings";
import { LabeledField, Note, StatusLine } from "./ui";

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const settle = useRef<((passed: boolean) => void) | null>(null);

  const run = useCallback<Run>(async (action) => {
    const first = await action();
    if (first.error?.code !== AUTH_CODES.secondFactorRequired) return first;
    const passed = await new Promise<boolean>((resolve) => {
      settle.current = resolve;
      setOpen(true);
    });
    settle.current = null;
    setOpen(false);
    // Given up: the refusal stands, nothing is sent again.
    if (!passed) return first;
    return action();
  }, []);

  return (
    <StepUpContext.Provider value={run}>
      {children}
      {open ? <StepUpDialog onDone={(passed) => settle.current?.(passed)} /> : null}
    </StepUpContext.Provider>
  );
}

function StepUpDialog({ onDone }: { onDone(passed: boolean): void }) {
  const titleId = useId();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = useSecondsLeft(STEP_UP_WAIT);

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
      onDone(true);
      return;
    }
    if (result.error.status === 429 && result.error.code === AUTH_CODES.secondFactorThrottled) {
      holdFor(STEP_UP_WAIT, result.error);
      if (result.error.retryAfter === undefined) setError(result.error.message ?? t("account.failed"));
      return;
    }
    setError(
      result.error.status === 401 || result.error.status === 400
        ? t("stepUp.wrong")
        : failureText(result.error),
    );
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : () => onDone(false)}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="xs"
      data-step-up
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={titleId}>{t("stepUp.title")}</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <Note>{t("stepUp.body")}</Note>
          <LabeledField
            label={backup ? t("stepUp.backup") : t("stepUp.code")}
            name="code"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            error={error}
            slotProps={{ htmlInput: { inputMode: backup ? "text" : "numeric", maxLength: backup ? 32 : 6 } }}
          />
          {left > 0 ? (
            <StatusLine tone="error">
              <Box component="span" data-step-up-wait={left}>
                {t("stepUp.throttled", { wait: waitText(left) })}
              </Box>
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => onDone(false)} disabled={busy}>
            {t("account.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || left > 0}>
            {t("stepUp.submit")}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
