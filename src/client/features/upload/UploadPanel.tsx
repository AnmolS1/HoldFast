// The rows of the transfer ribbon's expanded panel: one per file, with its state in words, its
// speed, and what can be done with it.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import { Pause, Play, RotateCw, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { ProgressUnderline } from "../../components/ProgressUnderline";
import { StatusDot } from "../../components/StatusDot";
import { t as shellT } from "../../lib/i18n";
import { TOUCH_QUERY } from "../../theme";
import { hf, layout } from "../../theme/tokens";
import { cancelItem, pauseAll, pauseItem, removeItem, resumeAll, resumeItem, retryItem } from "./manager";
import { openPicker } from "./picker";
import { useUploads, type UploadItem } from "./store";
import { t } from "./strings";
import { describeItem } from "./summary";

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

function Row({ item, onGone }: { item: UploadItem; onGone(): void }) {
  const name = item.finalName ?? item.name;
  const status = describeItem(item);
  const flagged = item.state === "done" && item.scanStatus !== null && item.scanStatus !== "clean";
  const moving = item.state === "uploading" || item.state === "hashing" || item.state === "completing";
  const pausable = moving || item.state === "queued";
  const resumable =
    item.state === "paused" &&
    item.file !== null &&
    (item.pauseReason === "user" || item.pauseReason === "ceiling" || item.pauseReason === "disabled");
  const waitsForFile = item.state === "paused" && item.file === null;
  const removable =
    item.state === "error" || item.state === "refused" || flagged || waitsForFile || item.state === "done";
  const cancellable =
    pausable || item.state === "conflict" || (item.state === "paused" && item.file !== null);
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
        padding: "4px 12px 4px 20px",
        borderBottom: `1px solid ${hf.hairline}`,
        [touch]: { minHeight: layout.touchRowHeight },
      }}
    >
      <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
        <Box sx={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
          {item.path ? (
            <Box component="span" sx={{ color: hf.textSecondary, fontWeight: 400 }}>
              {" "}
              {t("panel.in", { folder: item.path })}
            </Box>
          ) : null}
        </Box>
        {status !== null ? (
          <Box data-upload-status sx={{ color: tone, fontSize: 12, lineHeight: "16px" }}>
            {status}
            {item.state === "error" && item.requestId ? (
              <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
                {" "}
                {shellT("app.requestId", { id: item.requestId })}
              </Box>
            ) : null}
          </Box>
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
      {item.state === "error" && item.canRetry && item.file !== null ? (
        <RowButton label={t("action.retry", { name })} onClick={() => retryItem(item.id)}>
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
        <ProgressUnderline key={item.id} value={item.progress} label={`${name}: ${status ?? ""}`} />
      ) : item.state === "scanning" ? (
        <ProgressUnderline key={`${item.id}-scan`} value={null} label={`${t("row.scanning")} ${name}`} />
      ) : null}
    </Box>
  );
}

export function UploadPanel() {
  const { items } = useUploads();
  const title = useRef<HTMLHeadingElement>(null);
  const anySending = items.some(
    (item) =>
      item.state === "queued" ||
      item.state === "uploading" ||
      item.state === "hashing" ||
      item.state === "completing",
  );
  const anyPausedByHand = items.some(
    (item) => item.state === "paused" && item.pauseReason === "user" && item.file !== null,
  );
  // A row that goes takes the focus with it: put it on the panel's heading, never on <body>.
  const focusTitle = () => title.current?.focus();

  return (
    <Box data-upload-panel>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "4px 12px 4px 20px",
          borderBottom: `1px solid ${hf.hairline}`,
        }}
      >
        <Box
          component="h2"
          ref={title}
          tabIndex={-1}
          sx={{ flex: "1 1 auto", margin: 0, fontSize: 13, lineHeight: "20px", fontWeight: 600 }}
        >
          {t("panel.title")}
        </Box>
        {anySending || anyPausedByHand ? (
          <Button size="small" onClick={() => (anySending ? pauseAll() : resumeAll())}>
            {anySending ? t("panel.pauseAll") : t("panel.resumeAll")}
          </Button>
        ) : null}
      </Box>
      <Box component="ul" sx={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((item) => (
          <Row key={item.id} item={item} onGone={focusTitle} />
        ))}
      </Box>
    </Box>
  );
}
