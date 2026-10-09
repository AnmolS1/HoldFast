import Box from "@mui/material/Box";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { hf } from "../../theme/tokens";
import { keyOf, resolveUrl, thumbCache, type ThumbSize } from "./cache";

export interface ThumbImageProps {
  nodeId: string;
  /** Cache key for the content version (the DTO's etag). */
  versionKey: string;
  size: ThumbSize;
  alt: string;
  /** The caller decides: only a clean image is eligible. When false nothing is ever requested. */
  eligible: boolean;
  /** Mints a short-lived URL. The URL is a bearer token: it is never logged or stored. */
  getUrl(nodeId: string, size: ThumbSize): Promise<{ url: string; expiresAt: string }>;
  /** Shown when ineligible, while unavailable, and after the retry failed. */
  fallback: ReactNode;
  /** Aspect ratio of the fixed box (no layout shift). Default 1. */
  aspectRatio?: number;
}

function Thumb(props: ThumbImageProps) {
  const { nodeId, versionKey, size, alt, eligible, getUrl, fallback, aspectRatio = 1 } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Without IntersectionObserver there is nothing to wait for.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retried = useRef(false);
  const latestGetUrl = useRef(getUrl);
  useEffect(() => {
    latestGetUrl.current = getUrl;
  });

  useEffect(() => {
    const element = boxRef.current;
    if (!eligible || visible || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [eligible, visible]);

  useEffect(() => {
    if (!eligible || !visible || failed || url) return;
    let cancelled = false;
    resolveUrl({ nodeId, versionKey, size, getUrl: (id, s) => latestGetUrl.current(id, s) }, false).then(
      (entry) => {
        if (!cancelled) setUrl(entry.url);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [eligible, visible, failed, url, nodeId, versionKey, size]);

  // One re-request when the image itself fails to load (an expired or refused URL), then the fallback.
  const onError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    thumbCache.delete(keyOf(nodeId, versionKey, size));
    resolveUrl({ nodeId, versionKey, size, getUrl: (id, s) => latestGetUrl.current(id, s) }, true).then(
      (entry) => setUrl(entry.url),
      () => setFailed(true),
    );
  };

  const showImage = eligible && !failed && url !== null;
  return (
    <Box
      ref={boxRef}
      data-thumb={showImage ? "image" : eligible && !failed ? "pending" : "fallback"}
      sx={{
        position: "relative",
        width: "100%",
        aspectRatio: String(aspectRatio),
        backgroundColor: hf.thumbPlaceholder,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {showImage ? (
        <Box
          component="img"
          src={url}
          alt={alt}
          draggable={false}
          decoding="async"
          onError={onError}
          sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : !eligible || failed ? (
        fallback
      ) : null}
    </Box>
  );
}

/**
 * A lazily loaded thumbnail in a fixed box. The URL is requested when the box nears the viewport,
 * kept in memory until shortly before it expires, re-requested once if the image fails to load,
 * and replaced by `fallback` after that. A missing thumbnail is normal, never an error.
 */
export function ThumbImage(props: ThumbImageProps) {
  // A different node, version or size is a different thumbnail: start from a clean state.
  return <Thumb key={keyOf(props.nodeId, props.versionKey, props.size)} {...props} />;
}
