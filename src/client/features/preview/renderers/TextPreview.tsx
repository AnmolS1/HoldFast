// Text and code, shown as SOURCE (Markdown too). The bytes are fetched with an inline URL and
// every character reaches the page as a React text node — a file that says <script> shows the
// eight characters.
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useState } from "react";
import { fontMono, hf } from "../../../theme/tokens";
import { ErrorState, PreviewSkeleton } from "../parts";
import { t } from "../strings";
import { fetchPreview, usePreviewUrl } from "../usePreviewUrl";
import type { Line } from "./highlight";
import { decodeText, HIGHLIGHT_MAX_CHARS, TEXT_MAX_LINES } from "./text";
import type { RendererProps } from "./types";

// One weight and two neutrals: the design has no colour that means "keyword".
const TOKEN_STYLES = {
  '& [data-token="comment"]': { color: hf.textSecondary, fontStyle: "italic" },
  '& [data-token="string"], & [data-token="string-expression"]': { color: hf.textSecondary },
  '& [data-token="punctuation"]': { color: hf.textSecondary },
  '& [data-token="keyword"]': { fontWeight: 500 },
  '& [data-token="function"]': { fontWeight: 500 },
} as const;

export default function TextPreview({ source, item, download }: RendererProps) {
  const preview = usePreviewUrl(source, item.id, "inline");
  const [text, setText] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<Line[] | null>(null);
  const [wrap, setWrap] = useState(false);

  // The bytes are fetched once, starting from the first URL; a refused one is re-minted inside.
  const [firstUrl, setFirstUrl] = useState<string | null>(null);
  if (firstUrl === null && preview.url !== null) setFirstUrl(preview.url);
  const { reportFailure, fail, settle } = preview;
  useEffect(() => {
    if (firstUrl === null) return;
    const abort = new AbortController();
    void (async () => {
      const response = await fetchPreview(firstUrl, { reportFailure, fail }, abort.signal);
      if (!response) return;
      try {
        // A file's final line break ends its last line; it is not one more (empty) line.
        const decoded = decodeText(await response.arrayBuffer()).replace(/(\r\n|\r|\n)$/, "");
        if (abort.signal.aborted) return;
        // The text is in hand: no URL is needed any more.
        settle();
        setText(decoded);
      } catch {
        if (!abort.signal.aborted) fail();
      }
    })();
    return () => abort.abort();
  }, [firstUrl, reportFailure, fail, settle]);

  const all = useMemo(() => (text === null ? [] : text.split(/\r\n|\r|\n/)), [text]);
  const plain = useMemo<Line[]>(
    () => all.slice(0, TEXT_MAX_LINES).map((line) => (line.length > 0 ? [{ text: line }] : [])),
    [all],
  );

  useEffect(() => {
    if (text === null || text.length > HIGHLIGHT_MAX_CHARS) return;
    let cancelled = false;
    // The highlighter is its own chunk and is asked for only when there is something to colour.
    void import("./highlight")
      .then(async ({ highlight, languageFor }) => {
        const lang = languageFor(item.ext);
        if (!lang) return;
        const lines = await highlight(text, lang);
        if (!cancelled) setHighlighted(lines.slice(0, TEXT_MAX_LINES));
      })
      // No grammar, no colours: the plain text is already showing.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text, item.ext]);

  if (preview.failure) return <ErrorState failure={preview.failure} actions={download} />;
  if (text === null) return <PreviewSkeleton />;

  const lines = highlighted ?? plain;
  return (
    <Box
      data-preview-renderer="text"
      data-highlighted={highlighted ? "true" : "false"}
      sx={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <Box
        sx={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 3,
          padding: "0 20px",
          borderBottom: `1px solid ${hf.hairline}`,
        }}
      >
        <FormControlLabel
          control={
            <Checkbox size="small" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
          }
          label={t("text.wrap")}
        />
        {all.length > TEXT_MAX_LINES ? (
          <Typography variant="body2" role="note" sx={{ color: hf.textSecondary }}>
            {t("text.capped", { shown: TEXT_MAX_LINES, count: all.length })}
          </Typography>
        ) : null}
      </Box>
      <Box
        component="pre"
        tabIndex={0}
        aria-label={t("text.label", { name: item.name })}
        data-preview-keys="own"
        data-wrap={wrap ? "true" : "false"}
        sx={{
          flex: "1 1 auto",
          minHeight: 0,
          margin: 0,
          padding: "12px 0",
          overflow: "auto",
          fontFamily: fontMono,
          fontSize: 12,
          lineHeight: "18px",
          color: hf.text,
          backgroundColor: hf.surface,
          tabSize: 2,
          counterReset: "line",
          // Styled from here, not per line: a file can have thousands of them.
          "& [data-line]": {
            display: "flex",
            minHeight: "18px",
            counterIncrement: "line",
            paddingRight: "20px",
          },
          // The number is drawn by the stylesheet, so copying the text never includes it.
          "& [data-line]::before": {
            content: "counter(line)",
            flex: "none",
            width: "5ch",
            marginRight: "16px",
            textAlign: "right",
            color: hf.textSecondary,
            userSelect: "none",
          },
          "& [data-line] > span": { flex: "1 1 auto", minWidth: 0, whiteSpace: "pre" },
          '&[data-wrap="true"] [data-line] > span': { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
          ...TOKEN_STYLES,
        }}
      >
        <code>
          {lines.map((line, index) => (
            // Lines never reorder.
            <span key={index} data-line>
              <span>
                {line.map((piece, at) =>
                  piece.token ? (
                    <span key={at} data-token={piece.token}>
                      {piece.text}
                    </span>
                  ) : (
                    piece.text
                  ),
                )}
              </span>
            </span>
          ))}
        </code>
      </Box>
    </Box>
  );
}
