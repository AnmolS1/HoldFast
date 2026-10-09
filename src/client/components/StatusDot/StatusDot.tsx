import Box from "@mui/material/Box";
import { hf, hfAccent } from "../../theme/tokens";
import type { ScanStatus } from "../types";
import { STATUS_PRESENTATION, statusSentence, type StatusToken } from "./presentation";

const TOKEN_COLOR: Record<Exclude<StatusToken, null>, string> = {
  danger: hf.danger,
  attention: hf.attention,
  textSecondary: hf.textSecondary,
  accentText: hfAccent.text,
};

export interface StatusDotProps {
  status: ScanStatus;
  reason?: string | null;
  /** "glyph": the icon alone, named for assistive tech. "sentence": icon plus the sentence. */
  variant?: "glyph" | "sentence";
}

/**
 * Scan status, always as glyph AND text (never colour alone). `clean` renders nothing; `pending`
 * renders nothing as a glyph (the row's progress underline shows it) and "Scanning" as a sentence.
 */
export function StatusDot({ status, reason, variant = "glyph" }: StatusDotProps) {
  const presentation = STATUS_PRESENTATION[status];
  const sentence = statusSentence(status, reason);
  if (!presentation.token || !sentence) return null;
  const color = TOKEN_COLOR[presentation.token];
  const Icon = presentation.icon;
  if (variant === "glyph") {
    if (!Icon) return null;
    return (
      <Box
        component="span"
        role="img"
        aria-label={sentence}
        title={sentence}
        data-status={status}
        data-token={presentation.token}
        sx={{ display: "inline-flex", color, flex: "none" }}
      >
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </Box>
    );
  }
  return (
    <Box
      component="span"
      data-status={status}
      data-token={presentation.token}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        color,
        fontSize: 12,
        lineHeight: "16px",
        minWidth: 0,
      }}
    >
      {Icon ? <Icon size={14} strokeWidth={2} aria-hidden="true" style={{ flex: "none" }} /> : null}
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {sentence}
      </Box>
    </Box>
  );
}
