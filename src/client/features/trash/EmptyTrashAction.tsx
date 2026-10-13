// "Empty trash": the button, its confirmation, and the progress of the `202` loop. Used on the
// Trash page and as the shortcut on the Storage page.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toaster";
import { emitNodesChanged } from "../../lib/contracts";
import { hf } from "../../theme/tokens";
import { CONFIRM_WORD, emptyTrash, isAbort, needsTypedConfirm, useTrash, type TrashSize } from "./queries";
import { t } from "./strings";

type Run =
  | { state: "idle" }
  | { state: "running"; remaining: number | null }
  | { state: "stopped"; remaining: number | null };

function consequence(size: TrashSize): string {
  const folders = t("trash.delete.folders");
  if (size.count === null) return `${t("trash.emptyTrash.everything")} ${folders}`;
  if (size.more) return `${t("trash.emptyTrash.more", { count: size.count })} ${folders}`;
  if (size.count === 1) return `${t("trash.delete.consequence.one")} ${folders}`;
  return `${t("trash.delete.consequence", { count: size.count })} ${folders}`;
}

export function EmptyTrashAction() {
  const trash = useTrash();
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<Run>({ state: "idle" });
  const controller = useRef<AbortController | null>(null);
  // Leaving the page stops the loop after the request in flight.
  const stop = useCallback(() => controller.current?.abort(), []);
  useEffect(() => stop, [stop]);

  const size: TrashSize = trash.data
    ? {
        count: trash.data.pages.reduce((sum, page) => sum + page.items.length, 0),
        more: trash.hasNextPage,
      }
    : { count: null, more: false };
  const knownEmpty = size.count === 0 && !size.more;
  const typed = needsTypedConfirm(size);

  const start = async () => {
    setConfirming(false);
    setRun({ state: "running", remaining: null });
    const own = new AbortController();
    controller.current = own;
    let remaining: number | null = null;
    try {
      await emptyTrash((left) => {
        remaining = left;
        setRun({ state: "running", remaining: left });
      }, own.signal);
      setRun({ state: "idle" });
      toast({ message: t("trash.emptyTrash.done"), key: "empty-trash" });
    } catch (error) {
      if (isAbort(error)) return;
      setRun({ state: "stopped", remaining });
    } finally {
      // No live listing changed; this feature's own trash and storage numbers did.
      if (!own.signal.aborted) emitNodesChanged([]);
    }
  };

  return (
    <Box data-empty-trash sx={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
      <Button onClick={() => setConfirming(true)} disabled={run.state === "running" || knownEmpty}>
        {t("trash.emptyTrash")}
      </Button>
      <Box
        role="status"
        aria-live="polite"
        className="num"
        data-empty-trash-progress
        sx={{ color: hf.textSecondary }}
      >
        {run.state !== "running"
          ? ""
          : run.remaining === null
            ? t("trash.emptyTrash.starting")
            : t("trash.emptyTrash.progress", { remaining: run.remaining })}
      </Box>
      {run.state === "stopped" ? (
        <Box role="alert" data-empty-trash-stopped>
          {run.remaining === null
            ? t("trash.emptyTrash.stopped")
            : t("trash.emptyTrash.stoppedLeft", { remaining: run.remaining })}
        </Box>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t("trash.emptyTrash.title")}
        consequence={consequence(size)}
        confirmLabel={t("trash.emptyTrash")}
        destructive
        typeToConfirm={typed ? CONFIRM_WORD : undefined}
        typeToConfirmLabel={typed ? t("trash.emptyTrash.type", { word: CONFIRM_WORD }) : undefined}
        onConfirm={() => void start()}
        onCancel={() => setConfirming(false)}
      />
    </Box>
  );
}
