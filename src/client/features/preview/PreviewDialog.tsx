// The preview dialog: a large modal on desktop, full-screen below the layout breakpoint. It shows
// one file from either source and walks its siblings. Nothing from a file's content ever runs
// here — every renderer draws to an <img>, a canvas, text nodes or a media element.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { ChevronLeft, ChevronRight, Download, Share2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Bytes } from "../../components/Bytes";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { FileBadge } from "../../components/FileBadge";
import { ProgressUnderline } from "../../components/ProgressUnderline";
import type { PreviewDialogProps } from "../../components/slots";
import { toastApiError } from "../../lib/api";
import { useIsDesktop } from "../../theme/breakpoints";
import { hf, layout } from "../../theme/tokens";
import { ReportLink } from "../report";
import { ShareDialog } from "../share";
import { typeLabel } from "./labels";
import { ErrorState, PreviewSkeleton } from "./parts";
import { rendererFor } from "./renderer-map";
import { NoPreview } from "./renderers/NoPreview";
import type { RendererProps } from "./renderers/types";
import { nobodySignedIn, openScope, usePurgeCount } from "./scope";
import { mintUrl, type LoadedItem, type PreviewSource } from "./source";
import { t } from "./strings";
import { useItem, useSiblingIds } from "./useItem";

const ImagePreview = lazy(() => import("./renderers/ImagePreview"));
const PdfPreview = lazy(() => import("./renderers/PdfPreview"));
const TextPreview = lazy(() => import("./renderers/TextPreview"));
const MediaPreview = lazy(() => import("./renderers/MediaPreview"));

/**
 * Start a browser download in a tab of its own: the files host answers a download as an
 * attachment, and when it answers anything else (a refusal, in plain text) it is that tab which
 * shows it — the app is never unloaded and its address bar never carries the URL. The URL is used
 * once and kept nowhere.
 */
function startDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
}

function DownloadButton({ nodeId }: { nodeId: string }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    // The view that pressed the button: an answer that arrives after it has gone — closed, or
    // its account purged — starts no download and says nothing.
    const scope = openScope();
    try {
      // The only `download`-kind mint in the preview: every renderer uses `inline`.
      const minted = await mintUrl("owner", nodeId, "download");
      // Only ever a files-host address over http(s): nothing else is opened.
      if (scope.alive() && /^https?:\/\//i.test(minted.url)) startDownload(minted.url);
    } catch (error) {
      if (scope.alive()) toastApiError(error);
    } finally {
      scope.close();
      setBusy(false);
    }
  };
  return (
    <Button onClick={() => void onClick()} disabled={busy} data-preview-download>
      <Download size={16} aria-hidden="true" />
      {t("preview.download")}
    </Button>
  );
}

/** May this viewer download the file? Only through the signed-in API, and never a blocked file. */
function downloadAllowed(source: PreviewSource, item: LoadedItem): boolean {
  if (source !== "owner") return false;
  if (item.scanStatus === "clean") return true;
  // Unscanned files: their owner only, with the warning.
  return (item.scanStatus === "skipped" || item.scanStatus === "error") && item.node?.role === "owner";
}

function Scanning({ item }: { item: LoadedItem }) {
  return (
    <Box
      data-preview-state="scanning"
      sx={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: 240,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        padding: 8,
        textAlign: "center",
      }}
    >
      <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={56} />
      <Typography role="status">{t("scan.pending")}</Typography>
      <Typography sx={{ color: hf.textSecondary, maxWidth: 320 }}>{t("scan.pending.body")}</Typography>
      <ProgressUnderline value={null} label={t("scan.pending.label", { name: item.name })} />
    </Box>
  );
}

function Content({ source, item, onRetry }: RendererProps) {
  // The one Download button is the header's; here it only decides what the sentence says.
  const canDownload = downloadAllowed(source, item);
  const status = item.scanStatus;
  // Only clean files are previewed.
  if (status === "pending") return <Scanning item={item} />;
  if (status === "infected" || status === "under_review" || status === "suspected_csam") {
    return <NoPreview item={item} message={t("none.blocked")} />;
  }
  if (status === "skipped" || status === "error") {
    return (
      <NoPreview
        item={item}
        message={canDownload ? t("none.typeDownload") : t("none.title")}
        warning={canDownload ? t("preview.unscanned") : undefined}
      />
    );
  }
  const choice = rendererFor(item);
  const props: RendererProps = { source, item, onRetry };
  switch (choice.kind) {
    case "image":
      return <ImagePreview {...props} variant="inline" />;
    case "heic":
      // No thumbnail to ask for (too large for the image service): nothing to show but Download.
      if (!item.thumb) return <NoPreview item={item} message={t("none.imageUnavailable")} />;
      return <ImagePreview {...props} variant="thumb" />;
    case "pdf":
      return <PdfPreview {...props} />;
    case "text":
      return <TextPreview {...props} />;
    case "video":
    case "audio":
      return <MediaPreview {...props} kind={choice.kind} />;
    case "none":
      return (
        <NoPreview
          item={item}
          message={
            choice.reason === "tooLarge"
              ? t("none.tooLarge")
              : canDownload
                ? t("none.typeDownload")
                : t("none.title")
          }
        />
      );
  }
}

interface ViewProps extends PreviewDialogProps {
  /** Route mode: told about the file once it is known (its folder is where Close goes). */
  onItem?(item: LoadedItem): void;
}

interface BodyProps {
  nodeId: string;
  source: PreviewSource;
  titleId: string;
  siblingIds: string[] | undefined;
  onNavigate: ((nodeId: string) => void) | undefined;
  onClose(): void;
  onItem: ((item: LoadedItem) => void) | undefined;
  registerKeys(keys: { previous?: () => void; next?: () => void }): void;
}

function Body(props: BodyProps) {
  const { nodeId, source, titleId, onNavigate, onClose, onItem, registerKeys } = props;
  const { state, retry } = useItem(source, nodeId);
  const item = state.status === "ready" ? state.item : null;
  const ids = useSiblingIds(source, props.siblingIds, item);
  // The share dialog is open for one file; moving to the next closes it.
  const [sharing, setSharing] = useState<string | null>(null);
  const shareOpen = sharing === nodeId;
  // Bumped by a renderer's "Try again": the file's preview starts over as a NEW view. A person
  // pressing a button is the bound — nothing re-arms itself.
  const [view, setView] = useState(0);

  const index = ids.indexOf(nodeId);
  const previousId = onNavigate && index > 0 ? ids[index - 1] : undefined;
  const nextId = onNavigate && index >= 0 && index < ids.length - 1 ? ids[index + 1] : undefined;
  const walkable = Boolean(onNavigate) && index >= 0 && ids.length > 1;

  useEffect(() => {
    registerKeys({
      previous: previousId ? () => onNavigate?.(previousId) : undefined,
      next: nextId ? () => onNavigate?.(nextId) : undefined,
    });
  });

  const latestOnItem = useRef(onItem);
  useEffect(() => {
    latestOnItem.current = onItem;
  });
  useEffect(() => {
    // Once per file loaded, not per render of the caller.
    if (item) latestOnItem.current?.(item);
  }, [item]);

  const canShare = source === "owner" && item?.node?.role === "owner";
  return (
    <>
      <Box
        component="header"
        sx={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 2,
          minHeight: layout.header,
          padding: "8px 12px 8px 20px",
          borderBottom: `1px solid ${hf.hairline}`,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 3, minWidth: 0, flex: "1 1 200px" }}>
          {item ? <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={20} /> : null}
          <Box sx={{ minWidth: 0 }}>
            <Typography
              id={titleId}
              component="h2"
              variant="h2"
              sx={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {item ? item.name : state.status === "error" ? t("preview.title") : t("preview.loading")}
            </Typography>
            {item ? (
              <Typography
                variant="body2"
                data-preview-meta
                sx={{ color: hf.textSecondary, display: "flex", gap: 2, whiteSpace: "nowrap" }}
              >
                <span>{typeLabel(item)}</span>
                <Bytes value={item.size} />
                {walkable ? (
                  <span className="mono">
                    {t("preview.position", { index: index + 1, count: ids.length })}
                  </span>
                ) : null}
              </Typography>
            ) : null}
          </Box>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flex: "none", marginLeft: "auto" }}>
          {walkable ? (
            <>
              <IconButton
                aria-label={t("preview.previous")}
                disabled={!previousId}
                onClick={() => previousId && onNavigate?.(previousId)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </IconButton>
              <IconButton
                aria-label={t("preview.next")}
                disabled={!nextId}
                onClick={() => nextId && onNavigate?.(nextId)}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </IconButton>
            </>
          ) : null}
          {item && downloadAllowed(source, item) ? <DownloadButton nodeId={item.id} /> : null}
          {canShare ? (
            <Button onClick={() => setSharing(nodeId)}>
              <Share2 size={16} aria-hidden="true" />
              {t("preview.share")}
            </Button>
          ) : null}
          {item ? (
            <ReportLink
              target={
                source !== "owner" && source.reportTarget ? source.reportTarget(item.id) : { nodeId: item.id }
              }
            />
          ) : null}
          <IconButton aria-label={t("preview.close")} onClick={onClose} data-preview-close>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>
      </Box>
      <Box
        data-preview-content
        sx={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {state.status === "loading" ? <PreviewSkeleton /> : null}
        {state.status === "error" ? <ErrorState failure={state.failure} onRetry={retry} /> : null}
        {item ? (
          // A renderer that fails to load or throws shows the error state, never a broken page.
          <ErrorBoundary
            resetKey={`${item.id}|${item.scanStatus}`}
            fallback={() => <ErrorState failure={{}} onRetry={retry} />}
          >
            <Suspense fallback={<PreviewSkeleton />}>
              {/* A different file is a different preview: no state of the last one survives. */}
              <Content
                key={`${item.id}|${view}`}
                source={source}
                item={item}
                onRetry={() => setView((count) => count + 1)}
              />
            </Suspense>
          </ErrorBoundary>
        ) : null}
      </Box>
      {canShare ? <ShareDialog open={shareOpen} nodeId={nodeId} onClose={() => setSharing(null)} /> : null}
    </>
  );
}

/** Keys the dialog itself owns: a renderer that needs the arrows marks its element with this. */
const OWN_KEYS = "video, audio, input, textarea, select, [contenteditable='true'], [data-preview-keys='own']";

export function PreviewDialogView(props: ViewProps) {
  const { open, nodeId, siblingIds, onNavigate, onClose, source, onItem } = props;
  const desktop = useIsDesktop();
  const titleId = useId();
  const keys = useRef<{ previous?: () => void; next?: () => void }>({});
  // Changes when the account's state is purged: everything the dialog shows is thrown away and
  // read again for whoever is signed in now (every renderer's cleanup runs: transfers abort, the
  // pdf.js document is destroyed, the media element is stopped).
  const purges = usePurgeCount();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys of a dialog opened from inside this one (share, a confirm) are that dialog's.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    // Escape is left to the dialog, which closes on it. (The page's own shortcuts — Delete, "/" —
    // are ignored by the shell while a dialog is open; nothing here has to stop them.)
    if (event.key === "Escape") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target instanceof Element && event.target.closest(OWN_KEYS)) return;
    const go = event.key === "ArrowLeft" ? keys.current.previous : keys.current.next;
    if (!go) return;
    event.preventDefault();
    go();
  };

  return (
    <Dialog
      open={open && nodeId !== null}
      onClose={onClose}
      onKeyDown={onKeyDown}
      fullScreen={!desktop}
      maxWidth={false}
      aria-labelledby={titleId}
      data-preview-dialog
      slotProps={{
        paper: {
          sx: desktop
            ? { width: "min(1200px, calc(100vw - 64px))", height: "calc(100vh - 64px)", maxHeight: "none" }
            : { margin: 0, border: 0, borderRadius: 0 },
        },
      }}
    >
      {/* After a sign-out the dialog reads nothing more: there is no session to read with. */}
      {nodeId !== null && !(source === "owner" && nobodySignedIn()) ? (
        <Body
          key={purges}
          nodeId={nodeId}
          source={source}
          titleId={titleId}
          siblingIds={siblingIds}
          onNavigate={onNavigate}
          onClose={onClose}
          onItem={onItem}
          registerKeys={(next) => {
            keys.current = next;
          }}
        />
      ) : null}
    </Dialog>
  );
}

/** The slot other features and the public page use (props: `components/slots.ts`). */
export function PreviewDialog(props: PreviewDialogProps) {
  return <PreviewDialogView {...props} />;
}
