import { useEffect } from "react";
import { dismissToast } from "../Toaster/store";
import { undoToast, type UndoToastOptions } from "./undo";

export interface UndoToastProps extends UndoToastOptions {
  open: boolean;
}

/** Declarative form: shows the toast while `open` is true. */
export function UndoToast({ open, message, onUndo, duration, undoLabel }: UndoToastProps) {
  useEffect(() => {
    if (!open) return;
    const id = undoToast({ message, onUndo, duration, undoLabel });
    return () => dismissToast(id);
  }, [open, message, onUndo, duration, undoLabel]);
  return null;
}
