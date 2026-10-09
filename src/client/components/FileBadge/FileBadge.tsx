import Box from "@mui/material/Box";
import { fontMono, hf } from "../../theme/tokens";
import type { MimeCategory } from "../types";
import { badgeText } from "./badge";

export interface FileBadgeProps {
  name: string;
  mimeCategory: MimeCategory;
  /** Glyph box in px: 16 in rows, 20 on mobile, larger in grid tiles. */
  size?: number;
}

/** The file glyph: one outlined document with a short letter badge. Decorative. */
export function FileBadge({ name, mimeCategory, size = 16 }: FileBadgeProps) {
  const text = badgeText(name, mimeCategory);
  const showText = size >= 28 && text.length > 0;
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-badge={text || undefined}
      sx={{ position: "relative", display: "inline-flex", width: size, height: size, flex: "none", color: hf.textSecondary }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size >= 28 ? 1.25 : 2} strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      {showText ? (
        <Box
          component="span"
          sx={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "22%",
            textAlign: "center",
            fontFamily: fontMono,
            fontSize: Math.max(8, Math.round(size / 4.5)),
            lineHeight: 1,
            fontWeight: 500,
            color: hf.textSecondary,
          }}
        >
          {text}
        </Box>
      ) : null}
    </Box>
  );
}

/** The folder glyph: the only filled glyph, always graphite. Selection is shown by the row. */
export function FolderGlyph({ size = 16 }: { size?: number }) {
  return (
    <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", width: size, height: size, flex: "none", color: hf.text }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      </svg>
    </Box>
  );
}
