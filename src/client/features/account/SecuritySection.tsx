// Security: password, passkeys, two-factor, connected accounts — all Better Auth endpoints, through
// ./auth-calls.ts. The step-up prompt (./StepUp.tsx) wraps the section.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toaster";
import { accountEpoch, sameAccount } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { accountKeys, linkedQuery } from "./api";
import { AUTH_CODES, changePassword, linkGoogle, unlinkAccount, type AuthFailure } from "./auth-calls";
import { browserNavigation } from "./navigation";
import { PasskeysPart } from "./Passkeys";
import { useSignInAgain } from "./session";
import { StepUpProvider } from "./StepUp";
import { PASSWORD_MAX, PASSWORD_MIN, passwordStrength } from "./strength";
import { t } from "./strings";
import { TwoFactorPart } from "./TwoFactor";
import { failureText } from "./failures";
import { LabeledField, Note, PasswordDialog, Section, StatusLine } from "./ui";

function StrengthMeter({ password }: { password: string }) {
  const score = passwordStrength(password);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
      <Box
        role="meter"
        aria-label={t("password.strength.label", { strength: t(`password.strength.${score}`) })}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        data-strength={score}
        sx={{ display: "flex", gap: "4px", flex: "0 0 120px" }}
      >
        {[1, 2, 3, 4].map((step) => (
          <Box
            key={step}
            sx={{
              flex: 1,
              height: 4,
              borderRadius: "2px",
              backgroundColor: step <= score ? (score <= 1 ? hf.danger : hf.text) : hf.hairline,
            }}
          />
        ))}
      </Box>
      <Box sx={{ fontSize: 12, color: hf.textSecondary }}>{t(`password.strength.${score}`)}</Box>
    </Box>
  );
}

function PasswordPart({ hasPassword }: { hasPassword: boolean }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!hasPassword) {
    return (
      <Section id="password" title={t("password.title")}>
        <Note>{t("password.none")}</Note>
      </Section>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setCurrentError(null);
    setNextError(null);
    setFailure(null);
    if (current === "") {
      setCurrentError(t("account.passwordWrong"));
      return;
    }
    if (next.length < PASSWORD_MIN) {
      setNextError(t("password.short"));
      return;
    }
    if (next.length > PASSWORD_MAX) {
      setNextError(t("password.long"));
      return;
    }
    const then = accountEpoch();
    setBusy(true);
    const result = await changePassword({
      currentPassword: current,
      newPassword: next,
      // Always: a password is changed most often because a session is suspected — that one must
      // not stay signed in (T23 review m1; the server forces it too, hooks.ts). This browser stays.
      revokeOtherSessions: true,
    });
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      if (result.error.code === AUTH_CODES.invalidPassword) setCurrentError(t("account.passwordWrong"));
      else if (result.error.code === AUTH_CODES.compromised) setNextError(t("password.compromised"));
      else setFailure(failureText(result.error));
      return;
    }
    setCurrent("");
    setNext("");
    toast({ message: t("password.changed"), key: "password" });
    await queryClient.invalidateQueries({ queryKey: accountKeys.sessions });
  };

  return (
    <Section id="password" title={t("password.title")}>
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        data-password-form
        sx={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: 420 }}
      >
        <LabeledField
          label={t("password.current")}
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          error={currentError}
        />
        <LabeledField
          label={t("password.new")}
          type="password"
          name="newPassword"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          error={nextError}
          help={t("password.new.help")}
          slotProps={{ htmlInput: { maxLength: PASSWORD_MAX } }}
        />
        <StrengthMeter password={next} />
        <Note>{t("password.revokeOthers")}</Note>
        <StatusLine tone="error">{failure}</StatusLine>
        <Box>
          <Button type="submit" variant="contained" disabled={busy}>
            {t("password.submit")}
          </Button>
        </Box>
      </Box>
    </Section>
  );
}

type LinkAsk = { kind: "connect" } | { kind: "disconnect"; accountId: string; password?: boolean } | null;

function LinkedPart({ hasPassword }: { hasPassword: boolean }) {
  const queryClient = useQueryClient();
  const linked = useQuery(linkedQuery);
  const signInAgain = useSignInAgain();
  const [asking, setAsking] = useState<LinkAsk>(null);
  const [busy, setBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notFresh, setNotFresh] = useState(false);
  const google = linked.data?.find((row) => row.providerId === "google") ?? null;

  const refused = (error: AuthFailure) => {
    if (error.code === AUTH_CODES.invalidPassword) {
      setPasswordError(t("account.passwordWrong"));
      return;
    }
    setAsking(null);
    if (error.code === AUTH_CODES.sessionNotFresh) setNotFresh(true);
    else if (error.code === AUTH_CODES.lastAccount) setFailure(t("linked.lastMethod"));
    else if (error.code === AUTH_CODES.unlinkNotAvailable) setFailure(t("linked.notAvailable"));
    else setFailure(failureText(error));
  };

  const connect = async (password?: string) => {
    const then = accountEpoch();
    setBusy(true);
    setFailure(null);
    setPasswordError(null);
    const result = await linkGoogle(password);
    // Another account by now: its browser is not sent to link Google to anything.
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      refused(result.error);
      return;
    }
    if (result.data.url) browserNavigation.assign(result.data.url);
  };

  const disconnect = async (accountId: string, password?: string) => {
    const then = accountEpoch();
    setBusy(true);
    setFailure(null);
    setPasswordError(null);
    const result = await unlinkAccount({ accountId, ...(password ? { password } : {}) });
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      refused(result.error);
      return;
    }
    setAsking(null);
    toast({ message: t("linked.disconnected"), key: "linked" });
    await queryClient.invalidateQueries({ queryKey: linkedQuery.queryKey });
  };

  return (
    <Section id="linked" title={t("linked.title")}>
      <StatusLine tone="error">{failure}</StatusLine>
      {notFresh ? (
        <StatusLine tone="error">
          {t("account.signInAgain")}{" "}
          <Button size="small" onClick={() => void signInAgain()}>
            {t("account.signInAgain.action")}
          </Button>
        </StatusLine>
      ) : null}
      {linked.isError ? <StatusLine tone="error">{t("account.error.title")}</StatusLine> : null}
      {linked.data ? (
        <Box
          data-linked="google"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            minHeight: layout.rowHeight,
            flexWrap: "wrap",
          }}
        >
          <Box sx={{ flex: "1 1 160px" }}>
            <Box>{t("linked.google")}</Box>
            <Box sx={{ fontSize: 12, color: hf.textSecondary }}>
              {google ? t("linked.connected") : t("linked.notConnected")}
            </Box>
          </Box>
          {google ? (
            <Button
              variant="outlined"
              onClick={() => setAsking({ kind: "disconnect", accountId: google.id })}
            >
              {t("linked.disconnect")}
            </Button>
          ) : (
            <Button
              variant="outlined"
              disabled={busy}
              onClick={() => (hasPassword ? setAsking({ kind: "connect" }) : void connect())}
            >
              {t("linked.connect")}
            </Button>
          )}
        </Box>
      ) : null}
      <ConfirmDialog
        open={asking?.kind === "disconnect" && !asking.password}
        title={t("linked.disconnect.title")}
        consequence={t("linked.disconnect.body")}
        confirmLabel={t("linked.disconnect")}
        destructive
        busy={busy}
        onConfirm={() => {
          if (asking?.kind !== "disconnect") return;
          if (hasPassword) setAsking({ ...asking, password: true });
          else void disconnect(asking.accountId);
        }}
        onCancel={() => setAsking(null)}
      />
      <PasswordDialog
        open={asking?.kind === "connect" || (asking?.kind === "disconnect" && asking.password === true)}
        title={asking?.kind === "connect" ? t("linked.connect") : t("linked.disconnect.title")}
        body={asking?.kind === "connect" ? t("linked.connect.body") : t("linked.disconnect.body")}
        confirmLabel={asking?.kind === "connect" ? t("linked.connect") : t("linked.disconnect")}
        error={passwordError}
        busy={busy}
        onSubmit={(password) => {
          if (asking?.kind === "connect") void connect(password);
          else if (asking?.kind === "disconnect") void disconnect(asking.accountId, password);
        }}
        onCancel={() => {
          setAsking(null);
          setPasswordError(null);
        }}
      />
    </Section>
  );
}

export function SecuritySection() {
  const linked = useQuery(linkedQuery);
  // Unknown until read: the forms ask for the password (the server ignores it where there is none).
  const hasPassword = linked.data?.some((row) => row.providerId === "credential") ?? true;
  return (
    <StepUpProvider>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <PasswordPart hasPassword={hasPassword} />
        <PasskeysPart />
        <TwoFactorPart hasPassword={hasPassword} />
        <LinkedPart hasPassword={hasPassword} />
      </Box>
    </StepUpProvider>
  );
}
