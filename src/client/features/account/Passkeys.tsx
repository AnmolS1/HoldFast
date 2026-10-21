// Passkeys: the list (name and when it was added — Better Auth's table keeps no "last used"),
// add (a name, then the browser's own ceremony), rename, remove. A key that counts as a second
// factor needs the owner again to be renamed or removed (auth/hooks.ts): a session that passed
// the factor goes through; otherwise the server answers INVALID_PASSWORD and only then is the
// password asked for. Adding a key asks for nothing more than the session (ruling #14).
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toaster";
import { formatDate } from "../../lib/format";
import { accountEpoch, sameAccount, useSession } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { passkeysQuery } from "./api";
import {
  addPasskey,
  AUTH_CODES,
  deletePasskey,
  renamePasskey,
  type AuthFailure,
  type PasskeyRow,
} from "./auth-calls";
import { useSignInAgain } from "./session";
import { t } from "./strings";
import { failureText } from "./failures";
import { LabeledField, Note, PasswordDialog, Section, StatusLine } from "./ui";

function NameDialog({
  title,
  initial,
  busy,
  error,
  askPassword,
  passwordError,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: string;
  busy: boolean;
  error: string | null;
  askPassword: boolean;
  passwordError: string | null;
  onSubmit(name: string, password: string | undefined): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const [name, setName] = useState(initial);
  const [password, setPassword] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 200) {
      setNameError(t("passkeys.name.error"));
      return;
    }
    setNameError(null);
    onSubmit(trimmed, askPassword ? password : undefined);
  };
  return (
    <Dialog open onClose={busy ? undefined : onCancel} aria-labelledby={titleId} fullWidth maxWidth="xs">
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={titleId}>{title}</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <LabeledField
            label={t("passkeys.name")}
            name="passkeyName"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError ?? error}
            help={t("passkeys.name.help")}
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
          {askPassword ? (
            <>
              <Note>{t("passkeys.passwordNeeded")}</Note>
              <LabeledField
                label={t("account.passwordField")}
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                error={passwordError}
              />
            </>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>
            {t("account.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t("account.save")}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

type Editing =
  | { kind: "add" }
  | { kind: "rename"; key: PasskeyRow; askPassword: boolean }
  | { kind: "remove"; key: PasskeyRow }
  | { kind: "remove-password"; key: PasskeyRow }
  | null;

const nameOf = (key: PasskeyRow) => key.name?.trim() || t("passkeys.unnamed");

export function PasskeysPart() {
  const queryClient = useQueryClient();
  const zone = useSession().data?.user.timezone;
  const keys = useQuery(passkeysQuery);
  const signInAgain = useSignInAgain();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notFresh, setNotFresh] = useState(false);
  const [nudge, setNudge] = useState(false);

  const close = () => {
    setEditing(null);
    setError(null);
    setPasswordError(null);
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });

  /** A refusal of rename or remove. True when it was handled by asking for the password. */
  const refused = (failure: AuthFailure, hadPassword: boolean): boolean => {
    if (failure.code === AUTH_CODES.invalidPassword) {
      if (hadPassword) setPasswordError(t("account.passwordWrong"));
      return true;
    }
    if (failure.code === AUTH_CODES.sessionNotFresh) {
      close();
      setNotFresh(true);
      return false;
    }
    close();
    setFailure(failureText(failure));
    return false;
  };

  const onAdd = async (name: string) => {
    const then = accountEpoch();
    const first = (keys.data?.length ?? 0) === 0;
    setBusy(true);
    const result = await addPasskey(name);
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      setError(result.error.status === 400 ? t("passkeys.cancelled") : failureText(result.error));
      return;
    }
    close();
    toast({ message: t("passkeys.added"), key: "passkey" });
    setNudge(first);
    await refresh();
  };

  const onRename = async (key: PasskeyRow, name: string, password: string | undefined) => {
    const then = accountEpoch();
    setBusy(true);
    setPasswordError(null);
    const result = await renamePasskey({ id: key.id, name, ...(password ? { password } : {}) });
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      if (refused(result.error, password !== undefined))
        setEditing({ kind: "rename", key, askPassword: true });
      return;
    }
    close();
    toast({ message: t("passkeys.renamed"), key: "passkey" });
    await refresh();
  };

  const onRemove = async (key: PasskeyRow, password: string | undefined) => {
    const then = accountEpoch();
    setBusy(true);
    setPasswordError(null);
    const result = await deletePasskey({ id: key.id, ...(password ? { password } : {}) });
    if (!sameAccount(then)) return;
    setBusy(false);
    if (result.error) {
      if (refused(result.error, password !== undefined)) setEditing({ kind: "remove-password", key });
      return;
    }
    close();
    toast({ message: t("passkeys.deleted"), key: "passkey" });
    await refresh();
  };

  return (
    <Section
      id="passkeys"
      title={t("passkeys.title")}
      action={
        <Button variant="outlined" onClick={() => setEditing({ kind: "add" })} disabled={!keys.data}>
          {t("passkeys.add")}
        </Button>
      }
    >
      <Note>{t("passkeys.body")}</Note>
      {nudge ? <StatusLine tone="ok">{t("passkeys.nudge")}</StatusLine> : null}
      <StatusLine tone="error">{failure}</StatusLine>
      {notFresh ? (
        <StatusLine tone="error">
          {t("account.signInAgain")}{" "}
          <Button size="small" onClick={() => void signInAgain()}>
            {t("account.signInAgain.action")}
          </Button>
        </StatusLine>
      ) : null}
      {keys.isError ? <StatusLine tone="error">{t("account.error.title")}</StatusLine> : null}
      {keys.data && keys.data.length === 0 ? <Note>{t("passkeys.empty")}</Note> : null}
      {keys.data && keys.data.length > 0 ? (
        <Box component="ul" data-passkeys sx={{ margin: 0, padding: 0, listStyle: "none" }}>
          {keys.data.map((key) => (
            <Box
              component="li"
              key={key.id}
              data-passkey={key.id}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                minHeight: layout.rowHeight,
                padding: "6px 0",
                borderBottom: `1px solid ${hf.hairline}`,
                flexWrap: "wrap",
              }}
            >
              <Box sx={{ flex: "1 1 200px", minWidth: 0 }}>
                <Box sx={{ overflowWrap: "anywhere" }}>{nameOf(key)}</Box>
                <Box sx={{ fontSize: 12, color: hf.textSecondary }}>
                  {t("passkeys.created", { date: formatDate(key.createdAt, { timeZone: zone }) })}
                </Box>
              </Box>
              <Button
                size="small"
                onClick={() => setEditing({ kind: "rename", key, askPassword: false })}
                aria-label={`${t("passkeys.rename")}: ${nameOf(key)}`}
              >
                {t("passkeys.rename")}
              </Button>
              <Button
                size="small"
                color="error"
                onClick={() => setEditing({ kind: "remove", key })}
                aria-label={`${t("passkeys.delete")}: ${nameOf(key)}`}
              >
                {t("passkeys.delete")}
              </Button>
            </Box>
          ))}
        </Box>
      ) : null}

      {editing?.kind === "add" ? (
        <NameDialog
          title={t("passkeys.add")}
          initial=""
          busy={busy}
          error={error}
          askPassword={false}
          passwordError={null}
          onSubmit={(name) => void onAdd(name)}
          onCancel={close}
        />
      ) : null}
      {editing?.kind === "rename" ? (
        <NameDialog
          key={editing.askPassword ? "with-password" : "name-only"}
          title={t("passkeys.rename.title")}
          initial={nameOf(editing.key)}
          busy={busy}
          error={error}
          askPassword={editing.askPassword}
          passwordError={passwordError}
          onSubmit={(name, password) => void onRename(editing.key, name, password)}
          onCancel={close}
        />
      ) : null}
      <ConfirmDialog
        open={editing?.kind === "remove"}
        title={t("passkeys.delete.title")}
        consequence={
          editing?.kind === "remove" ? t("passkeys.delete.body", { name: nameOf(editing.key) }) : ""
        }
        confirmLabel={t("passkeys.delete")}
        destructive
        busy={busy}
        onConfirm={() => {
          if (editing?.kind === "remove") void onRemove(editing.key, undefined);
        }}
        onCancel={close}
      />
      <PasswordDialog
        open={editing?.kind === "remove-password"}
        title={t("passkeys.delete.title")}
        body={t("passkeys.passwordNeeded")}
        confirmLabel={t("passkeys.delete")}
        error={passwordError}
        busy={busy}
        onSubmit={(password) => {
          if (editing?.kind === "remove-password") void onRemove(editing.key, password);
        }}
        onCancel={close}
      />
    </Section>
  );
}
