// Video and audio, played by the browser's own element from an inline URL. Seeking is a Range
// request to the files host, so the URL has to stay valid for as long as the file plays: when a
// fresh one arrives the element is moved onto it at the same position.
import Box from "@mui/material/Box";
import { useEffect, useRef, useState } from "react";
import { FileBadge } from "../../../components/FileBadge";
import { hf } from "../../../theme/tokens";
import { ErrorState } from "../parts";
import { useViewScope } from "../scope";
import { t } from "../strings";
import { usePreviewUrl } from "../usePreviewUrl";
import { NoPreview } from "./NoPreview";
import type { RendererProps } from "./types";

interface Position {
  time: number;
  playing: boolean;
  rate: number;
}

export default function MediaPreview(props: RendererProps & { kind: "video" | "audio" }) {
  const { source, item, kind, onRetry } = props;
  const preview = usePreviewUrl(source, item.id, "inline");
  const element = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  // Where playback was when the URL was swapped; applied once the new one has its metadata.
  const resume = useRef<Position | null>(null);
  // The last position the element reported (an element in its error state may report none).
  const last = useRef<Position>({ time: 0, playing: false, rate: 1 });
  // Errors seen in this view of the file. Never reset: metadata loading again on a fresh URL is
  // not progress — a file that fails at the same second every time would otherwise mint for ever.
  const failures = useRef(0);
  const probing = useRef(false);
  const [unsupported, setUnsupported] = useState(false);
  // The element's handlers ask this first: false after unmount and after a purge of the account.
  const view = useViewScope();

  const track = () => {
    const media = element.current;
    if (!media || media.error) return;
    last.current = {
      time: media.currentTime,
      playing: !media.paused && !media.ended,
      rate: media.playbackRate,
    };
  };

  const { url, reportFailure, settle } = preview;
  useEffect(() => {
    const media = element.current;
    if (!media || !url) return;
    const current = media.getAttribute("src");
    if (current === url) return;
    if (current) {
      // A fresh URL for a file that is already loaded: remember where it is.
      if (!media.error) {
        last.current = {
          time: media.currentTime,
          playing: !media.paused && !media.ended,
          rate: media.playbackRate,
        };
      }
      resume.current = { ...last.current };
    }
    // Set on the element directly: the URL is a bearer token and stays out of what React renders.
    media.src = url;
  }, [url]);

  // A media element that leaves the page keeps playing until it is collected: stop it.
  useEffect(() => {
    const media = element.current;
    return () => {
      if (!media) return;
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, []);

  const onLoadedMetadata = () => {
    const media = element.current;
    if (!media || !view.alive()) return;
    const position = resume.current;
    resume.current = null;
    if (!position) return;
    media.currentTime = position.time;
    media.playbackRate = position.rate;
    if (position.playing) void media.play().catch(() => {});
  };

  const onError = () => {
    const media = element.current;
    if (!media || !media.error || !view.alive()) return;
    failures.current += 1;
    if (failures.current === 1) {
      // An expired or refused URL: one more, then playback resumes where it was.
      void reportFailure();
      return;
    }
    // Failed again. If the files host does serve the URL, the bytes are fine and it is the
    // browser that cannot play them; otherwise this is the second failure and it is final.
    // Either way this view of the file ends here: nothing more is minted.
    if (probing.current) return;
    probing.current = true;
    const current = media.currentSrc || media.src;
    // The question carries the view's signal: it is dropped when the view ends or the account
    // is purged, and its answer is not acted on after either.
    fetch(current, { method: "HEAD", mode: "cors", credentials: "omit", signal: view.signal() }).then(
      (response) => {
        if (!view.alive()) return;
        if (!response.ok) return void reportFailure();
        // Nothing will be played: the URL need not be kept fresh behind the card.
        settle();
        setUnsupported(true);
      },
      () => {
        if (view.alive()) void reportFailure();
      },
    );
  };

  if (unsupported) return <NoPreview item={item} message={t("media.unsupported")} />;
  if (preview.failure) return <ErrorState failure={preview.failure} onRetry={onRetry} />;

  const shared = {
    controls: true,
    preload: "metadata",
    onLoadedMetadata,
    onError,
    onTimeUpdate: track,
    onPlay: track,
    onPause: track,
    onRateChange: track,
    onSeeked: track,
  } as const;
  return (
    <Box
      data-preview-renderer={kind}
      sx={{
        flex: "1 1 auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: kind === "video" ? 0 : 8,
        backgroundColor: hf.bg,
      }}
    >
      {kind === "video" ? (
        <Box
          component="video"
          ref={element}
          playsInline
          aria-label={t("media.video", { name: item.name })}
          sx={{ width: "100%", height: "100%", minHeight: 0, objectFit: "contain" }}
          {...shared}
        />
      ) : (
        <>
          <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={56} />
          <Box
            component="audio"
            ref={element}
            aria-label={t("media.audio", { name: item.name })}
            sx={{ width: "min(100%, 480px)" }}
            {...shared}
          />
        </>
      )}
    </Box>
  );
}
