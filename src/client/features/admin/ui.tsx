// Building blocks of the console's screens: a section, a field, a status line, the error state
// every screen falls back to (it never throws), the dialog that asks for a typed reason, and the
// words for a refusal.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField, { type TextFieldProps } from "@mui/material/TextField";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { ApiError } from "../../lib/api";
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
      data-admin-part={id}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        paddingBottom: 4,
        borderBottom: `1px solid ${hf.hairline}`,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
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

export function Note({ children }: { children: ReactNode }) {
  return (
    <Box component="p" sx={{ margin: 0, color: hf.textSecondary, fontSize: 13, lineHeight: "20px" }}>
      {children}
    </Box>
  );
}

/** Label: value rows. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <Box
      component="dl"
      sx={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(140px, max-content) 1fr",
        gap: "4px 16px",
        fontSize: 13,
      }}
    >
      {rows.map(([label, value]) => (
        <Box key={label} sx={{ display: "contents" }}>
          <Box component="dt" sx={{ color: hf.textSecondary }}>
            {label}
          </Box>
          <Box component="dd" sx={{ margin: 0, overflowWrap: "anywhere" }}>
            {value}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function Field({
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

export function StatusLine({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  if (!children) return null;
  return (
    <Box
      role={tone === "error" ? "alert" : "status"}
      data-admin-status={tone}
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

/** What a screen shows when its read failed — a 404 or a 5xx included. Never a throw. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <Box data-admin-error>
      <EmptyState
        type="unavailable"
        title={t("common.loadFailed")}
        body={
          error instanceof ApiError && error.code === "admin_requires_2fa"
            ? t("stepUp.needed")
            : t("common.loadFailedBody")
        }
        requestId={requestId}
        actions={onRetry ? <Button onClick={onRetry}>{t("common.retry")}</Button> : undefined}
      />
    </Box>
  );
}

export function Loading() {
  return (
    <Box role="status" data-admin-loading sx={{ padding: 4, color: hf.textSecondary }}>
      {t("common.loading")}
    </Box>
  );
}

/**
 * Asks for the reason an action is taken (typed, required, audited) and, for a two-step action,
 * shows what the preview said before the confirm. `onSubmit` gets the reason.
 */
export type ReasonDialogProps = {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  children?: ReactNode;
  reasonLabel?: string;
  canSubmit?: boolean;
  onSubmit(reason: string): void;
  onCancel(): void;
};

export function ReasonDialog(props: ReasonDialogProps) {
  const titleId = useId();
  return (
    <Dialog
      open={props.open}
      onClose={props.busy ? undefined : props.onCancel}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="sm"
      data-admin-dialog
    >
      {/* Mounted per opening: the reason typed for one action is never offered for the next. */}
      {props.open ? <ReasonForm {...props} titleId={titleId} /> : null}
    </Dialog>
  );
}

function ReasonForm({
  titleId,
  title,
  body,
  confirmLabel,
  destructive,
  busy,
  error,
  children,
  reasonLabel,
  canSubmit = true,
  onSubmit,
  onCancel,
}: ReasonDialogProps & { titleId: string }) {
  const [reason, setReason] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() && canSubmit && !busy) onSubmit(reason.trim());
  };
  return (
    <Box component="form" noValidate onSubmit={submit}>
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {body ? <Note>{body}</Note> : null}
        {children}
        <Field
          label={reasonLabel ?? t("common.reason")}
          name="reason"
          multiline
          minRows={2}
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {error ? <StatusLine tone="error">{error}</StatusLine> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="contained"
          color={destructive ? "error" : "primary"}
          disabled={busy || !reason.trim() || !canSubmit}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Box>
  );
}

/** A small mono id. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <Box component="span" className="mono" sx={{ fontSize: 12 }}>
      {children}
    </Box>
  );
}
