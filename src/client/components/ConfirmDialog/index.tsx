import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useId, useState, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { hf } from "../../theme/tokens";

export interface ConfirmDialogProps {
  open: boolean;
  /** What will happen, as a question or statement: "Delete 3 items forever?" */
  title: string;
  /** The blast radius, in plain words: "3 people lose access. This can't be undone." */
  consequence: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /** The user must type this text before the confirm button enables (large irreversible acts). */
  typeToConfirm?: string;
  typeToConfirmLabel?: string;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Confirmation for irreversible acts only (everything reversible uses trash + undo). It always
 * states the blast radius. Focus starts on Cancel, so Enter never destroys anything by reflex.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    title,
    consequence,
    confirmLabel,
    cancelLabel,
    destructive = false,
    typeToConfirm,
    typeToConfirmLabel,
    busy = false,
    onConfirm,
    onCancel,
  } = props;
  const titleId = useId();
  const bodyId = useId();
  const [typed, setTyped] = useState("");
  const blocked = typeToConfirm !== undefined && typed.trim() !== typeToConfirm;
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      maxWidth="xs"
      fullWidth
      slotProps={{ transition: { onExited: () => setTyped("") } }}
    >
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <Typography id={bodyId} component="div" sx={{ color: hf.textSecondary }}>
          {consequence}
        </Typography>
        {typeToConfirm !== undefined ? (
          <TextField
            fullWidth
            margin="normal"
            label={typeToConfirmLabel ?? typeToConfirm}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: "off" } }}
          />
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onCancel} disabled={busy}>
          {cancelLabel ?? t("app.cancel")}
        </Button>
        <Button
          variant="contained"
          color={destructive ? "error" : "primary"}
          onClick={onConfirm}
          disabled={busy || blocked}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
