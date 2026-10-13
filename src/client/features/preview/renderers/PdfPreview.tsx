// PDF. The bytes are fetched with an inline URL and handed to pdf.js whole; pages are drawn to
// canvases as they come near the window, each with a text layer for selection and find-in-page.
// A PDF is never navigated to and never put in a frame.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Typography from "@mui/material/Typography";
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { accountEpoch, sameAccount } from "../../../lib/query";
import { hf, layout } from "../../../theme/tokens";
import { ErrorState, PreviewSkeleton } from "../parts";
import { t } from "../strings";
import { fetchLimitFor } from "../renderer-map";
import { fetchPreview, readLimited, TOO_LARGE, usePreviewUrl } from "../usePreviewUrl";
import { NoPreview } from "./NoPreview";
import { createRenderBudget, PDF_MAX_PAGES, pixelRatioFor, type RenderBudget } from "./pdf-limits";
import { safeExternalUrl } from "./pdf-links";
import {
  openPdf,
  PdfLockedError,
  type PdfDocument,
  type PdfLink,
  type PdfPage,
  type PdfRender,
} from "./pdf-engine";
import type { RendererProps } from "./types";

const PAGE_GAP = 12;
const PADDING = 16;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const AUTO_MAX_SCALE = 1.5;
const STEP = 1.25;
const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

// What pdf.js's text layer needs to line its (transparent) text up with the canvas: structure
// only. The selection colour is the system's own.
const TEXT_LAYER = {
  "& .textLayer": {
    position: "absolute",
    inset: 0,
    overflow: "clip",
    lineHeight: 1,
    textAlign: "initial",
    transformOrigin: "0 0",
    zIndex: 0,
    textSizeAdjust: "none",
    forcedColorAdjust: "none",
    "--min-font-size": 1,
    "--text-scale-factor": "calc(var(--total-scale-factor) * var(--min-font-size))",
    "--min-font-size-inv": "calc(1 / var(--min-font-size))",
  },
  "& .textLayer :is(span, br)": {
    color: "transparent",
    position: "absolute",
    whiteSpace: "pre",
    cursor: "text",
    transformOrigin: "0% 0%",
  },
  "& .textLayer > :not(.markedContent), & .textLayer .markedContent span:not(.markedContent)": {
    zIndex: 1,
    "--font-height": 0,
    fontSize: "calc(var(--text-scale-factor) * var(--font-height))",
    "--scale-x": 1,
    "--rotate": "0deg",
    transform: "rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))",
  },
  "& .textLayer .markedContent": { display: "contents" },
  "& .textLayer ::selection": {
    color: "transparent",
    background: "color-mix(in srgb, Highlight 40%, transparent)",
  },
  "& .textLayer .endOfContent": {
    display: "block",
    position: "absolute",
    inset: "100% 0 0",
    zIndex: 0,
    cursor: "default",
    userSelect: "none",
  },
} as const;

interface PageViewProps {
  doc: PdfDocument;
  number: number;
  scale: number;
  /** Size at scale 1 until the page's own is known (page 1's). */
  baseWidth: number;
  baseHeight: number;
  onExternalLink(url: string): void;
  onInternalLink(dest: unknown): void;
  /** The document's: who may draw now. */
  budget: RenderBudget;
  register(number: number, element: HTMLDivElement | null): void;
}

function PageView(props: PageViewProps) {
  const { doc, number, scale, baseWidth, baseHeight, onExternalLink, onInternalLink, budget, register } =
    props;
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const textLayer = useRef<HTMLDivElement | null>(null);
  // Without IntersectionObserver every page counts as near.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [page, setPage] = useState<PdfPage | null>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);

  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    // A page is drawn while it is within one window of the visible part, and dropped beyond.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNear(entry.isIntersecting);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let loaded: PdfPage | null = null;
    doc.page(number).then(
      (next) => {
        if (cancelled) return next.release();
        loaded = next;
        setPage(next);
      },
      () => {
        // A page that cannot be read stays an empty sheet; the others still show.
      },
    );
    return () => {
      cancelled = true;
      loaded?.release();
      setPage(null);
      setLinks([]);
    };
  }, [doc, number, near]);

  useEffect(() => {
    const surface = canvas.current;
    const layer = textLayer.current;
    if (!page || !surface || !layer) return;
    let cancelled = false;
    let render: PdfRender | null = null;
    const ratio = pixelRatioFor(page.width * scale, page.height * scale, window.devicePixelRatio);
    // Drawn when the document's budget allows: two pages at a time, and only while the canvases
    // already alive leave room for this one.
    const slot = budget.request(
      Math.floor(page.width * scale * ratio) * Math.floor(page.height * scale * ratio),
    );
    void slot.granted.then((ok) => {
      if (!ok || cancelled) return;
      render = page.render(surface, layer, scale, ratio);
      // A cancelled render rejects; that is not a failure.
      render.done.then(slot.finished, slot.finished);
      page.links(scale).then(
        (found) => {
          if (!cancelled) setLinks(found);
        },
        () => {},
      );
    });
    return () => {
      cancelled = true;
      render?.cancel();
      // The canvas gives its pixels back now, not when it is collected.
      surface.width = 0;
      surface.height = 0;
      slot.release();
    };
  }, [page, scale, budget]);

  const width = Math.floor((page?.width ?? baseWidth) * scale);
  const height = Math.floor((page?.height ?? baseHeight) * scale);
  return (
    <Box
      ref={(element: HTMLDivElement | null) => {
        box.current = element;
        register(number, element);
      }}
      role="group"
      aria-label={t("pdf.pageLabel", { page: number })}
      data-pdf-page={number}
      data-pdf-rendered={page ? "true" : "false"}
      style={{ width, height, ["--total-scale-factor" as string]: String(scale) }}
      sx={{
        position: "relative",
        flex: "none",
        // A sheet of paper is white in both schemes: pdf.js paints the canvas white.
        backgroundColor: hf.surface2,
        border: `1px solid ${hf.hairline}`,
        boxSizing: "content-box",
        "--scale-round-x": "1px",
        "--scale-round-y": "1px",
      }}
    >
      {near ? (
        <>
          <canvas ref={canvas} style={{ display: "block", width, height }} />
          <div ref={textLayer} className="textLayer" />
          {links.map((link, index) => (
            <Box
              component="button"
              type="button"
              key={index}
              data-pdf-link={link.url ? "external" : "internal"}
              aria-label={link.url ?? t("pdf.internalLink")}
              title={link.url}
              onClick={() => (link.url ? onExternalLink(link.url) : onInternalLink(link.dest))}
              style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
              sx={{
                position: "absolute",
                zIndex: 2,
                padding: 0,
                border: 0,
                background: "transparent",
                cursor: "pointer",
              }}
            />
          ))}
        </>
      ) : null}
    </Box>
  );
}

interface Opened {
  doc: PdfDocument;
  width: number;
  height: number;
}

function Pages({ opened, name }: { opened: Opened; name: string }) {
  const { doc, width: baseWidth, height: baseHeight } = opened;
  const count = Math.min(doc.pageCount, PDF_MAX_PAGES);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pages = useRef(new Map<number, HTMLDivElement>());
  const inputId = useId();
  const [available, setAvailable] = useState(0);
  // null = sized to the window's width (never above 150 %).
  const [chosen, setChosen] = useState<number | null>(null);
  const [current, setCurrent] = useState(1);
  const [typed, setTyped] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [budget] = useState(() => createRenderBudget());

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = available > 0 ? clampScale((available - 2 * PADDING - 2) / baseWidth) : 1;
  const scale = chosen ?? Math.min(fit, AUTO_MAX_SCALE);

  const register = useCallback((number: number, element: HTMLDivElement | null) => {
    if (element) pages.current.set(number, element);
    else pages.current.delete(number);
  }, []);

  const goTo = useCallback(
    (number: number) => {
      const target = Math.min(count, Math.max(1, Math.round(number)));
      const element = pages.current.get(target);
      if (element && scroller.current) scroller.current.scrollTop = element.offsetTop - PADDING;
      setCurrent(target);
    },
    [count],
  );

  // After a zoom the page that was showing is still the one showing.
  const anchored = useRef(scale);
  useEffect(() => {
    if (anchored.current === scale) return;
    anchored.current = scale;
    const element = pages.current.get(current);
    if (element && scroller.current) scroller.current.scrollTop = element.offsetTop - PADDING;
  }, [scale, current]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const line = element.scrollTop + element.clientHeight / 3;
    let found = 1;
    for (let number = 1; number <= count; number += 1) {
      const page = pages.current.get(number);
      if (!page || page.offsetTop > line) break;
      found = number;
    }
    setCurrent(found);
  };

  const onInternalLink = useCallback(
    (dest: unknown) => {
      void doc.pageOfDest(dest).then((number) => {
        if (number !== null) goTo(number);
      });
    },
    [doc, goTo],
  );

  const commitTyped = () => {
    const number = Number(typed);
    setTyped(null);
    if (Number.isFinite(number) && number >= 1) goTo(number);
  };

  return (
    <Box
      data-preview-renderer="pdf"
      sx={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <Box
        sx={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 2,
          padding: "6px 12px",
          borderBottom: `1px solid ${hf.hairline}`,
        }}
      >
        <IconButton
          aria-label={t("pdf.previousPage")}
          disabled={current <= 1}
          onClick={() => goTo(current - 1)}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          aria-label={t("pdf.nextPage")}
          disabled={current >= count}
          onClick={() => goTo(current + 1)}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </IconButton>
        <Box component="label" htmlFor={inputId} sx={{ color: hf.textSecondary }}>
          {t("pdf.page")}
        </Box>
        <InputBase
          id={inputId}
          value={typed ?? String(current)}
          onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
          onBlur={() => typed !== null && commitTyped()}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTyped();
          }}
          inputProps={{ inputMode: "numeric", "data-pdf-page-input": "" }}
          className="mono"
          sx={{
            width: 56,
            padding: "0 8px",
            border: `1px solid ${hf.hairline}`,
            borderRadius: `${layout.radius.control}px`,
            "& input": { textAlign: "right", padding: "4px 0" },
          }}
        />
        <Typography component="span" className="mono" data-pdf-page-count sx={{ color: hf.textSecondary }}>
          {t("pdf.pageOf", { count })}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, marginLeft: "auto" }}>
          <IconButton
            aria-label={t("pdf.zoomOut")}
            disabled={scale <= MIN_SCALE}
            onClick={() => setChosen(clampScale(scale / STEP))}
          >
            <Minus size={16} aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label={t("pdf.zoomIn")}
            disabled={scale >= MAX_SCALE}
            onClick={() => setChosen(clampScale(scale * STEP))}
          >
            <Plus size={16} aria-hidden="true" />
          </IconButton>
          <Button aria-pressed={chosen === null} onClick={() => setChosen(null)}>
            {t("pdf.fitWidth")}
          </Button>
        </Box>
      </Box>
      {doc.pageCount > PDF_MAX_PAGES ? (
        <Typography
          variant="body2"
          role="note"
          sx={{
            flex: "none",
            padding: "6px 20px",
            color: hf.textSecondary,
            borderBottom: `1px solid ${hf.hairline}`,
          }}
        >
          {t("pdf.capped", { shown: PDF_MAX_PAGES, count: doc.pageCount })}
        </Typography>
      ) : null}
      <Box
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={t("text.label", { name })}
        data-preview-keys="own"
        data-pdf-scroller
        sx={{
          position: "relative",
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "safe center",
          gap: `${PAGE_GAP}px`,
          padding: `${PADDING}px`,
          backgroundColor: hf.bg,
          ...TEXT_LAYER,
        }}
      >
        {Array.from({ length: count }, (_, index) => (
          <PageView
            key={index + 1}
            doc={doc}
            number={index + 1}
            scale={scale}
            baseWidth={baseWidth}
            baseHeight={baseHeight}
            onExternalLink={setLeaving}
            onInternalLink={onInternalLink}
            budget={budget}
            register={register}
          />
        ))}
      </Box>
      <ConfirmDialog
        open={leaving !== null}
        title={t("pdf.leave.title")}
        consequence={
          <>
            {t("pdf.leave.body")}{" "}
            <Box component="span" className="mono" sx={{ overflowWrap: "anywhere", color: hf.text }}>
              {leaving}
            </Box>
          </>
        }
        confirmLabel={t("pdf.leave.confirm")}
        onCancel={() => setLeaving(null)}
        onConfirm={() => {
          // Checked again where it is used: only http(s) and mailto ever leave the app.
          const url = safeExternalUrl(leaving);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
          setLeaving(null);
        }}
      />
    </Box>
  );
}

export default function PdfPreview({ source, item }: RendererProps) {
  const preview = usePreviewUrl(source, item.id, "inline");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [locked, setLocked] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);

  // The bytes are fetched once, starting from the first URL; a refused one is re-minted inside.
  const [firstUrl, setFirstUrl] = useState<string | null>(null);
  if (firstUrl === null && preview.url !== null) setFirstUrl(preview.url);
  const { reportFailure, fail, settle } = preview;
  useEffect(() => {
    if (firstUrl === null) return;
    const abort = new AbortController();
    // Bytes of the account that asked: after a purge they are dropped, not opened.
    const account = accountEpoch();
    let doc: PdfDocument | null = null;
    void (async () => {
      // A mount that is undone at once (development's double mount) fetches nothing.
      await Promise.resolve();
      if (abort.signal.aborted) return;
      const response = await fetchPreview(firstUrl, { reportFailure, fail }, abort.signal);
      if (!response) return;
      try {
        // Counted as it arrives: a file larger than the viewer takes is dropped mid-transfer.
        const bytes = await readLimited(response, fetchLimitFor("pdf"));
        if (abort.signal.aborted) return;
        if (!sameAccount(account)) return abort.abort();
        if (bytes === TOO_LARGE) {
          abort.abort();
          settle();
          return setTooLarge(true);
        }
        // pdf.js holds the whole file from here on: no URL is needed any more.
        settle();
        doc = await openPdf(bytes);
        const first = await doc.page(1);
        const size = { width: first.width, height: first.height };
        first.release();
        if (abort.signal.aborted) return doc.destroy();
        setOpened({ doc, ...size });
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof PdfLockedError) setLocked(true);
        else fail();
      }
    })();
    return () => {
      abort.abort();
      doc?.destroy();
      setOpened(null);
    };
  }, [firstUrl, reportFailure, fail, settle]);

  if (tooLarge) return <NoPreview item={item} message={t("none.tooLarge")} />;
  if (locked) return <NoPreview item={item} message={t("pdf.locked")} />;
  if (preview.failure) return <ErrorState failure={preview.failure} />;
  if (!opened) return <PreviewSkeleton />;
  return <Pages opened={opened} name={item.name} />;
}
