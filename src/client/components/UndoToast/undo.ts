import { t } from "../../lib/i18n";
import { toast } from "../Toaster/store";

export const UNDO_MIN_MS = 5000;
export const UNDO_MAX_MS = 8000;

export interface UndoToastOptions {
  /** "3 items moved to trash" */
  message: string;
  onUndo(): void;
  /** Clamped to 5–8 s. Default 6 s. */
  duration?: number;
  undoLabel?: string;
}

export function clampUndoDuration(duration: number | undefined): number {
  return Math.min(UNDO_MAX_MS, Math.max(UNDO_MIN_MS, duration ?? 6000));
}

/** Raise an undo toast. Returns its id (pass to `dismissToast` to remove it early). */
export function undoToast({ message, onUndo, duration, undoLabel }: UndoToastOptions): number {
  return toast({
    message,
    duration: clampUndoDuration(duration),
    key: "undo",
    action: { label: undoLabel ?? t("app.undo"), onClick: onUndo },
  });
}
