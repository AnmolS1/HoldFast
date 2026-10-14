// "Empty trash": the button, its confirmation, and the progress of the run (empty-run.ts). Used
// on the Trash page and as the shortcut on the Storage page.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import { onlineManager } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { accountEpoch, queryClient, sameAccount } from "../../lib/query";
import { hf } from "../../theme/tokens";
import { viewKeys } from "../starred/view-queries";
import { isHeld, useBlockedUntil } from "../starred/view-state";
import {
  dismissStopped,
  setPreConfirmRead,
  startEmptyTrash,
  stoppedMessage,
  useEmptyRun,
  usePreConfirmRead,
} from "./empty-run";
import { CONFIRM_WORD, needsTypedConfirm, useTrash, type TrashSize } from "./queries";
import { t } from "./strings";

const UNKNOWN: TrashSize = { count: null, more: false };

/** What ends the moment "Empty trash cancelled." describes. */
const NEXT_ACTS = ["pointerdown", "keydown"] as const;

/** What a user does that is not "waiting for the dialog I asked for". */
const OTHER_ACTS = ["pointerdown", "keydown", "click"] as const;

/**
 * Keys that only move the focus or are held with another key: pressing one is not doing
 * something else — a keyboard or screen-reader user may well move on while the button says
 * "Checking…" — so it does not withdraw the question. Every other key may act on the page.
 */
const PASSIVE_KEYS = new Set([
  "Tab",
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

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
  const checking = usePreConfirmRead();
  // What the dialog was opened with: the trash as the server had it at that moment.
  const [asked, setAsked] = useState<TrashSize | null>(null);
  // The question was withdrawn by something else the user did: said in the status line.
  const [withdrawnNote, setWithdrawnNote] = useState(false);
  // It describes a moment: the user's next act (a key, a press) clears it. The polite region has
  // announced it already. (Not on a timer: the shell exports no status-line timeout — SEAM.)
  useEffect(() => {
    if (!withdrawnNote) return;
    const clear = () => setWithdrawnNote(false);
    for (const type of NEXT_ACTS) document.addEventListener(type, clear, true);
    return () => {
      for (const type of NEXT_ACTS) document.removeEventListener(type, clear, true);
    };
  }, [withdrawnNote]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    setWithdrawnNote(false);
    // No read is possible (offline) or allowed (the API named a wait for this list): ask now,
    // with the size unknown — which asks for the word.
    const cachedQuery = queryClient.getQueryCache().find({ queryKey: viewKeys.trash });
    if (!onlineManager.isOnline() || (cachedQuery && isHeld(cachedQuery))) {
      setAsked(UNKNOWN);
      return;
    }
    // A destructive confirmation may open only as the direct continuation of the click that
    // asked for it. While the read is out, anything else the user does — a key that acts, a
    // press, a click anywhere, leaving the page — withdraws the question: the answer is then
    // dropped, nothing opens, and the status line says so. (The click that started this is
    // already past the document's capture phase, so it does not count.)
    let withdrawn = false;
    const withdraw = (event: Event) => {
      if (event instanceof KeyboardEvent && PASSIVE_KEYS.has(event.key)) return;
      if (withdrawn) return;
      withdrawn = true;
      setPreConfirmRead(false);
      if (mounted.current) setWithdrawnNote(true);
    };
    for (const type of OTHER_ACTS) document.addEventListener(type, withdraw, true);
    setPreConfirmRead(true);
    const account = accountEpoch();
    try {
      const fresh = await trash.refetch();
      // Another account since the click, or the user has moved on: no dialog.
      if (!sameAccount(account) || withdrawn || !mounted.current) return;
      // Never a second dialog, whatever opened meanwhile.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
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
      for (const type of OTHER_ACTS) document.removeEventListener(type, withdraw, true);
      if (sameAccount(account)) setPreConfirmRead(false);
    }
  };
  const size = asked ?? UNKNOWN;
  const typed = needsTypedConfirm(size);
  const showStopped = run.state === "stopped" && !run.dismissed && !knownEmpty;

  return (
    <Box data-empty-trash sx={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
      <Button
        onClick={() => void ask()}
        disabled={run.state === "running" || checking || knownEmpty || waiting}
        aria-busy={checking || undefined}
        data-empty-trash-button
      >
        {checking ? t("trash.emptyTrash.checking") : t("trash.emptyTrash")}
      </Button>
      <Box
        role="status"
        aria-live="polite"
        className="num"
        data-empty-trash-progress
        sx={{ color: hf.textSecondary }}
      >
        {run.state !== "running"
          ? withdrawnNote
            ? t("trash.emptyTrash.withdrawn")
            : ""
          : run.remaining === null
            ? t("trash.emptyTrash.starting")
            : t("trash.emptyTrash.progress", { remaining: run.remaining })}
      </Box>
      {showStopped ? (
        // Not a live region: the stop was announced once already, by a toast.
        <Box data-empty-trash-stopped sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          {stoppedMessage(run.remaining)}
          <IconButton aria-label={t("trash.dismiss")} onClick={dismissStopped}>
            <X size={16} aria-hidden="true" />
          </IconButton>
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
