// "Empty trash": the button, its confirmation, and the progress of the run (empty-run.ts). Used
// on the Trash page and as the shortcut on the Storage page.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { onlineManager } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { accountEpoch, sameAccount } from "../../lib/query";
import { hf } from "../../theme/tokens";
import { useBlockedUntil } from "../starred/view-state";
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
  // A run stopped by a `429` may not be started again before the time the API named.
  const waiting = useBlockedUntil(run.state === "stopped" ? run.retryAt : 0);

  // The count decides whether the word must be typed, so it is read again first: the list in
  // memory may be seconds old, or from before another device filled the trash.
  const ask = async () => {
    // Offline that read would wait for the connection and the dialog would open out of nowhere
    // later: ask now, with the size unknown (which asks for the word).
    if (!onlineManager.isOnline()) {
      setAsked(UNKNOWN);
      return;
    }
    setChecking(true);
    const account = accountEpoch();
    try {
      const fresh = await trash.refetch();
      // Another account since the click: no dialog about the previous one's trash.
      if (!sameAccount(account)) return;
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
        disabled={run.state === "running" || checking || knownEmpty || waiting}
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
