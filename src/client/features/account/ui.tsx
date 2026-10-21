// Small building blocks of the account screens: a section with its heading, a labelled field whose
// error is announced, a status line, and the password prompt.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField, { type TextFieldProps } from "@mui/material/TextField";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { hf, layout } from "../../theme/tokens";
import { t } from "./strings";

export function Section({
  id,
  title,
  children,
  action,
}: {
  id: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const headingId = useId();
  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      data-account-part={id}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        paddingBottom: 5,
        borderBottom: `1px solid ${hf.hairline}`,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 3 }}>
        <Box
          component="h2"
          id={headingId}
          sx={{ margin: 0, fontSize: 15, lineHeight: "22px", fontWeight: 600 }}
        >
          {title}
        </Box>
        {action}
      </Box>
      {children}
    </Box>
  );
}

/** A paragraph in the secondary colour. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <Box component="p" sx={{ margin: 0, color: hf.textSecondary, fontSize: 13, lineHeight: "20px" }}>
      {children}
    </Box>
  );
}

/** A text field with its label above it; `error` is announced (role="alert"). */
export function LabeledField({
  error,
  help,
  ...rest
}: Omit<TextFieldProps, "error" | "helperText"> & { error?: string | null; help?: string }) {
  return (
    <TextField
      variant="outlined"
      fullWidth
      size="small"
      {...rest}
      error={Boolean(error)}
      helperText={error || help}
      slotProps={{
        ...rest.slotProps,
        inputLabel: { shrink: true },
        formHelperText: error ? { role: "alert" } : undefined,
      }}
    />
  );
}

/** A line under a form: a confirmation (status) or a refusal (alert). */
export function StatusLine({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  if (!children) return null;
  return (
    <Box
      role={tone === "error" ? "alert" : "status"}
      data-account-status={tone}
      sx={{
        padding: "8px 12px",
        borderRadius: `${layout.radius.control}px`,
        backgroundColor: hf.surface2,
        boxShadow: `inset 2px 0 0 ${tone === "error" ? hf.danger : hf.textSecondary}`,
        color: hf.text,
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      {children}
    </Box>
  );
}

/** A dialog that asks for the account's password, then hands it to `onSubmit`. */
export function PasswordDialog({
  open,
  title,
  body,
  confirmLabel,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  error: string | null;
  busy: boolean;
  onSubmit(password: string): void;
  onCancel(): void;
}) {
  const [password, setPassword] = useState("");
  const titleId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password) onSubmit(password);
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="xs"
    >
      <Box component="form" onSubmit={submit} noValidate>
        <DialogTitle id={titleId}>{title}</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <Note>{body}</Note>
          <LabeledField
            label={t("account.passwordField")}
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={error}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>
            {t("account.cancel")}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || password === ""}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
