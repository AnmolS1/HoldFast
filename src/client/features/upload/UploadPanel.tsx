// The rows of the transfer ribbon's expanded panel: one per file, with its state in words, its
// speed, and what can be done with it.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { Pause, Play, RotateCw, X } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { ProgressUnderline } from "../../components/ProgressUnderline";
import { StatusDot } from "../../components/StatusDot";
import { t as shellT } from "../../lib/i18n";
import { TOUCH_QUERY } from "../../theme";
import { hf, layout } from "../../theme/tokens";
import {
  canCancel,
  cancelItem,
  pauseAll,
  pauseItem,
  recheckAll,
  recheckItem,
  removeItem,
  resumeAll,
  resumeItem,
  retryItem,
} from "./manager";
import { openPicker } from "./picker";
import { PANEL_ROWS } from "./plan";
import { isRestored, useUploads, type UploadItem } from "./store";
import { t } from "./strings";
import { describeItem, isStillChecking, rowsToDraw } from "./summary";

const touch = `@media ${TOUCH_QUERY}`;

function RowButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <IconButton
      aria-label={label}
      title={label}
      onClick={onClick}
      sx={{ flex: "none", [touch]: { width: layout.touchTarget, height: layout.touchTarget } }}
    >
      {children}
    </IconButton>
  );
}

// Memoised: a progress sample of one file re-renders that file's row, not the whole list.
const Row = memo(function Row({ item, onGone }: { item: UploadItem; onGone(): void }) {
  const name = item.finalName ?? item.name;
  const status = describeItem(item);
  const flagged =
    item.state === "done" &&
    item.scanStatus !== null &&
    item.scanStatus !== "clean" &&
    item.scanStatus !== "pending";
  const moving = item.state === "uploading" || item.state === "hashing" || item.state === "completing";
  // Once `complete` is on its way nothing is offered: the row says why.
  const pausable =
    !item.completeSent && (item.state === "uploading" || item.state === "hashing" || item.state === "queued");
  const resumable =
    item.state === "paused" && !isRestored(item) && item.pauseReason !== null && item.pauseReason !== "auth";
  const waitsForFile = item.state === "paused" && isRestored(item);
  const removable =
    item.state === "error" || item.state === "refused" || waitsForFile || item.state === "done";
  const cancellable = canCancel(item) && item.state !== "error";
  // Given up by the scan bound: the file can be followed again.
  const recheckable = item.state === "done" && item.scanStatus === "pending" && item.nodeId !== null;
  // Red means blocked, and nothing else (a refusal is one); an upload that did not finish is
  // said in the ordinary text colour.
  const tone = item.state === "refused" ? hf.danger : item.state === "error" ? hf.text : hf.textSecondary;

  return (
    <Box
      component="li"
      data-upload-row={item.state}
      data-upload-name={name}
      sx={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 2,
        minHeight: layout.rowHeight,
        py: 1,
        pr: 3,
        pl: 5,
        borderBottom: `1px solid ${hf.hairline}`,
        [touch]: { minHeight: layout.touchRowHeight },
      }}
    >
      <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
        <Typography
          variant="subtitle1"
          component="div"
          sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {name}
          {item.path ? (
            <Typography variant="body1" component="span" sx={{ color: hf.textSecondary }}>
              {" "}
              {t("panel.in", { folder: item.path })}
            </Typography>
          ) : null}
        </Typography>
        {status !== null ? (
          <Typography variant="body2" component="div" data-upload-status sx={{ color: tone }}>
            {status}
            {item.state === "error" && item.requestId ? (
              <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
                {" "}
                {shellT("app.requestId", { id: item.requestId })}
              </Box>
            ) : null}
          </Typography>
        ) : null}
        {flagged && item.scanStatus ? (
          <StatusDot status={item.scanStatus} reason={item.scanReason} variant="sentence" />
        ) : null}
      </Box>
      {waitsForFile ? (
        <Button
          size="small"
          aria-label={t("action.selectNamed", { name })}
          onClick={() => openPicker("files", item.parentId)}
        >
          {t("action.select")}
        </Button>
      ) : null}
      {pausable || resumable ? (
        // One button for both, so focus stays on it when the state flips.
        <RowButton
          label={pausable ? t("action.pause", { name }) : t("action.resume", { name })}
          onClick={() => (pausable ? pauseItem(item.id) : resumeItem(item.id))}
        >
          {pausable ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </RowButton>
      ) : null}
      {item.state === "error" && item.canRetry && !isRestored(item) ? (
        <RowButton label={t("action.retry", { name })} onClick={() => retryItem(item.id)}>
          <RotateCw size={16} aria-hidden="true" />
        </RowButton>
      ) : null}
      {recheckable ? (
        <RowButton label={t("action.checkAgain", { name })} onClick={() => recheckItem(item.id)}>
          <RotateCw size={16} aria-hidden="true" />
        </RowButton>
      ) : null}
      {cancellable ? (
        <RowButton
          label={t("action.cancel", { name })}
          onClick={() => {
            cancelItem(item.id);
            onGone();
          }}
        >
          <X size={16} aria-hidden="true" />
        </RowButton>
      ) : removable ? (
        <RowButton
          label={t("action.remove", { name })}
          onClick={() => {
            removeItem(item.id);
            onGone();
          }}
        >
          <X size={16} aria-hidden="true" />
        </RowButton>
      ) : null}
      {moving ? (
        <ProgressUnderline
          key={item.id}
          value={item.progress}
          label={t("row.progress", { name, status: status ?? "" })}
        />
      ) : item.state === "scanning" ? (
        <ProgressUnderline key={`${item.id}-scan`} value={null} label={t("row.scanningNamed", { name })} />
      ) : null}
    </Box>
  );
});

export function UploadPanel() {
  const { items } = useUploads();
  const title = useRef<HTMLHeadingElement>(null);
  const anySending = items.some(
    (item) =>
      !item.completeSent &&
      (item.state === "queued" || item.state === "uploading" || item.state === "hashing"),
  );
  const anyPausedByHand = items.some(
    (item) => item.state === "paused" && item.pauseReason === "user" && !isRestored(item),
  );
  // A row that goes takes the focus with it: put it on the panel's heading, never on <body>.
  const focusTitle = useCallback(() => title.current?.focus(), []);
  const root = useRef<HTMLDivElement>(null);
  // And when the panel itself goes (its last row was removed, or the queue finished) while the
  // focus is inside it, the focus moves to the page — a layout effect, so it runs while the
  // panel is still in the document.
  useLayoutEffect(() => {
    const panel = root.current;
    return () => {
      if (panel?.contains(document.activeElement)) {
        document.querySelector<HTMLElement>("[data-main]")?.focus();
      }
    };
  }, []);
  // A drop of thousands of files is counted, not drawn — but every row that is moving or has
  // failed is drawn, wherever it stands in the queue: those are the ones to act on.
  const shown = rowsToDraw(items, PANEL_ROWS);
  const drawn = new Set(shown.map((item) => item.id));
  const checking = items.filter((item) => !drawn.has(item.id) && isStillChecking(item)).length;
  const more = items.length - shown.length - checking;

  return (
    <Box data-upload-panel ref={root}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          py: 1,
          pr: 3,
          pl: 5,
          borderBottom: `1px solid ${hf.hairline}`,
        }}
      >
        <Typography
          variant="h3"
          component="h2"
          ref={title}
          tabIndex={-1}
          sx={{ flex: "1 1 auto", margin: 0 }}
        >
          {t("panel.title")}
        </Typography>
        {anySending || anyPausedByHand ? (
          <Button size="small" onClick={() => (anySending ? pauseAll() : resumeAll())}>
            {anySending ? t("panel.pauseAll") : t("panel.resumeAll")}
          </Button>
        ) : null}
      </Box>
      <Box component="ul" sx={{ listStyle: "none", margin: 0, padding: 0 }}>
        {shown.map((item) => (
          <Row key={item.id} item={item} onGone={focusTitle} />
        ))}
      </Box>
      {more > 0 ? (
        <Typography variant="body2" data-upload-more sx={{ color: hf.textSecondary, py: 2, pr: 3, pl: 5 }}>
          {more === 1 ? t("panel.more.one") : t("panel.more.other", { count: more })}
        </Typography>
      ) : null}
      {checking > 0 ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 2, pr: 3, pl: 5 }}>
          <Typography variant="body2" data-upload-checking sx={{ flex: "1 1 auto", color: hf.textSecondary }}>
            {checking === 1 ? t("panel.checking.one") : t("panel.checking.other", { count: checking })}
          </Typography>
          {items.some((item) => item.state === "done" && item.scanStatus === "pending") ? (
            <Button size="small" onClick={recheckAll}>
              {t("panel.checkAgain")}
            </Button>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
