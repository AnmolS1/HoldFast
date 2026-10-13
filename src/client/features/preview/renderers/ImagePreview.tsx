// Images. The browser draws them from an <img> (and applies EXIF orientation itself).
//   variant "inline"  the file's own bytes, from an inline URL
//   variant "thumb"   HEIC / HEIF, which no browser decodes: the 1280 px WebP thumbnail instead
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThumbImage } from "../../../components/ThumbImage";
import { hf, layout } from "../../../theme/tokens";
import { ErrorState } from "../parts";
import { useViewScope } from "../scope";
import { mintUrl } from "../source";
import { t } from "../strings";
import { usePreviewUrl } from "../usePreviewUrl";
import { NoPreview } from "./NoPreview";
import type { RendererProps } from "./types";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const STEP = 1.25;
const HEIC_SIZE = 1280;
const BLUR_SIZE = 320;

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** While the image is on its way: the 320 px thumbnail, blurred — or the skeleton without one. */
function BlurUp({ source, item }: Pick<RendererProps, "source" | "item">) {
  const skeleton = <Skeleton variant="rounded" animation="wave" sx={{ width: "100%", height: "100%" }} />;
  return (
    <Box
      data-preview-blurup={item.thumb ? "thumb" : "skeleton"}
      aria-hidden="true"
      sx={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 5,
        pointerEvents: "none",
      }}
    >
      <Box
        sx={{
          width: "min(60%, 480px)",
          borderRadius: `${layout.radius.card}px`,
          overflow: "hidden",
          "& img": { filter: "blur(16px)", transform: "scale(1.15)" },
        }}
      >
        {item.thumb ? (
          <ThumbImage
            nodeId={item.id}
            versionKey={item.versionKey}
            size={BLUR_SIZE}
            alt=""
            eligible
            getUrl={(nodeId, size) => mintUrl(source, nodeId, "thumb", size)}
            // A missing thumbnail is normal: the skeleton shows instead.
            fallback={skeleton}
          />
        ) : (
          <Box sx={{ aspectRatio: "4 / 3" }}>{skeleton}</Box>
        )}
      </Box>
    </Box>
  );
}

export default function ImagePreview(props: RendererProps & { variant: "inline" | "thumb" }) {
  const { source, item, variant, onRetry } = props;
  const preview = usePreviewUrl(
    source,
    item.id,
    variant === "thumb" ? "thumb" : "inline",
    variant === "thumb" ? HEIC_SIZE : undefined,
  );
  const [shown, setShown] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState(0);
  // null = fit the window; a number = displayed pixels per image pixel.
  const [zoom, setZoom] = useState<number | null>(null);
  const view = useViewScope();
  const viewport = useRef<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);

  const zoomBy = useCallback((factor: number) => {
    setZoom((current) => {
      const img = image.current;
      // Zooming out of "fit" starts from the size the image is shown at.
      const from = current ?? (img && img.naturalWidth > 0 ? img.clientWidth / img.naturalWidth : 1);
      return clampZoom(from * factor);
    });
  }, []);

  // Pinch (two fingers, or a trackpad's pinch, which arrives as ctrl + wheel) and the wheel zoom.
  // Native listeners: both must be able to cancel the browser's own page zoom.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const pinch = event.ctrlKey || event.metaKey;
      // A plain wheel scrolls a zoomed image; when the image fits there is nothing to scroll.
      if (!pinch && zoom !== null) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY / (pinch ? 100 : 300)));
    };
    let lastDistance = 0;
    const distance = (touches: TouchList) =>
      Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) lastDistance = distance(event.touches);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || lastDistance === 0) return;
      event.preventDefault();
      const next = distance(event.touches);
      zoomBy(next / lastDistance);
      lastDistance = next;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
    };
  }, [zoom, zoomBy]);

  if (preview.failure) {
    // The files host would not serve it, or the browser would not draw what it served (a file
    // that is not the image it claims, one too large to decode): no preview, only Download. For
    // HEIC that is normal — it has nothing but its thumbnail, and the image service may have none.
    if (preview.failure.host || (variant === "thumb" && preview.failure.notFound)) {
      return <NoPreview item={item} message={t("none.imageUnavailable")} />;
    }
    return <ErrorState failure={preview.failure} onRetry={onRetry} />;
  }

  const width = zoom !== null && naturalWidth > 0 ? naturalWidth * zoom : undefined;
  return (
    <Box
      data-preview-renderer={variant === "thumb" ? "heic" : "image"}
      sx={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <Box
        ref={viewport}
        data-preview-keys={zoom === null ? undefined : "own"}
        tabIndex={zoom === null ? undefined : 0}
        sx={{
          position: "relative",
          flex: "1 1 auto",
          minHeight: 0,
          overflow: zoom === null ? "hidden" : "auto",
          display: "flex",
          backgroundColor: hf.bg,
          touchAction: "pan-x pan-y",
        }}
      >
        {/* Held for as long as the request is pending — a large HEIC's thumbnail takes seconds. */}
        {shown ? null : <BlurUp source={source} item={item} />}
        {preview.url ? (
          <Box
            component="img"
            ref={image}
            src={preview.url}
            alt={item.name}
            draggable={false}
            onLoad={(event) => {
              // Loaded after the view ended or the account went: not shown.
              if (!view.alive()) return;
              setNaturalWidth(event.currentTarget.naturalWidth);
              setShown(true);
              // Decoded: nothing needs swapping any more.
              preview.settle();
            }}
            onError={() => {
              if (!view.alive()) return;
              setShown(false);
              void preview.reportFailure();
            }}
            sx={{
              margin: "auto",
              opacity: shown ? 1 : 0,
              flex: "none",
              ...(zoom === null
                ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
                : { width, maxWidth: "none" }),
            }}
          />
        ) : null}
      </Box>
      <Box
        sx={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: 2,
          padding: "8px 12px",
          borderTop: `1px solid ${hf.hairline}`,
        }}
      >
        {variant === "thumb" ? (
          <Typography variant="body2" sx={{ color: hf.textSecondary, marginRight: "auto" }}>
            {t("image.heic")}
          </Typography>
        ) : null}
        <Box role="group" aria-label={t("image.zoom")} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton aria-label={t("image.zoomOut")} onClick={() => zoomBy(1 / STEP)} disabled={!shown}>
            <Minus size={16} aria-hidden="true" />
          </IconButton>
          <Button aria-pressed={zoom === null} onClick={() => setZoom(null)} disabled={!shown}>
            {t("image.fit")}
          </Button>
          <Button aria-pressed={zoom === 1} onClick={() => setZoom(1)} disabled={!shown}>
            {t("image.actual")}
          </Button>
          <IconButton aria-label={t("image.zoomIn")} onClick={() => zoomBy(STEP)} disabled={!shown}>
            <Plus size={16} aria-hidden="true" />
          </IconButton>
        </Box>
      </Box>
    </Box>
  );
}
