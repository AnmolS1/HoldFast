// "Empty trash": the button, its confirmation, and the progress of the run (empty-run.ts). Used
// on the Trash page and as the shortcut on the Storage page.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { hf } from "../../theme/tokens";
import { startEmptyTrash, stoppedMessage, useEmptyRun } from "./empty-run";
import { CONFIRM_WORD, needsTypedConfirm, useTrash, type TrashSize } from "./queries";
import { t } from "./strings";

const UNKNOWN: TrashSize = { count: null, more: false };

function consequence(size: TrashSize): string {
  const folders = t("trash.delete.folders");
  if (size.count === null) return `${t("trash.emptyTrash.everything")} ${folders}`;
  if (size.more) {
    const more =
      size.count === 1 ? t("trash.emptyTrash.more.one") : t("trash.emptyTrash.more", { count: size.count });
    return `${more} ${folders}`;
  }
  if (size.count === 1) return `${t("trash.delete.consequence.one")} ${folders}`;
  return `${t("trash.delete.consequence", { count: size.count })} ${folders}`;
}

export function EmptyTrashAction() {
  const trash = useTrash();
  const run = useEmptyRun();
  const [checking, setChecking] = useState(false);
  // What the dialog was opened with: the trash as the server had it at that moment.
  const [asked, setAsked] = useState<TrashSize | null>(null);

  const cached: TrashSize = trash.data
    ? {
        count: trash.data.pages.reduce((sum, page) => sum + page.items.length, 0),
        more: trash.hasNextPage,
      }
    : UNKNOWN;
  const knownEmpty = cached.count === 0 && !cached.more;

  // The count decides whether the word must be typed, so it is read again first: the list in
  // memory may be seconds old, or from before another device filled the trash.
  const ask = async () => {
    setChecking(true);
    try {
      const fresh = await trash.refetch();
      const pages = fresh.isSuccess ? fresh.data.pages : null;
      setAsked(
        pages
          ? {
              count: pages.reduce((sum, page) => sum + page.items.length, 0),
              more: (pages.at(-1)?.nextCursor ?? null) !== null,
            }
          : UNKNOWN,
      );
    } finally {
      setChecking(false);
    }
  };
  const size = asked ?? UNKNOWN;
  const typed = needsTypedConfirm(size);

  return (
    <Box data-empty-trash sx={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
      <Button
        onClick={() => void ask()}
        disabled={run.state === "running" || checking || knownEmpty}
        data-empty-trash-button
      >
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
          {stoppedMessage(run.remaining)}
        </Box>
      ) : null}
      <ConfirmDialog
        open={asked !== null}
        title={t("trash.emptyTrash.title")}
        consequence={consequence(size)}
        confirmLabel={t("trash.emptyTrash")}
        destructive
        typeToConfirm={typed ? CONFIRM_WORD : undefined}
        typeToConfirmLabel={typed ? t("trash.emptyTrash.type", { word: CONFIRM_WORD }) : undefined}
        onConfirm={() => {
          setAsked(null);
          startEmptyTrash();
        }}
        onCancel={() => setAsked(null)}
      />
    </Box>
  );
}
