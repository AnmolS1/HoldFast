import Box from "@mui/material/Box";
import type { ReactNode } from "react";
import { hf } from "../../theme/tokens";

export interface FrameBannerProps {
  children: ReactNode;
  /** One button, right-aligned. */
  action?: ReactNode;
  /** Colours the left rule and the icon; the text stays graphite. Never the activity colour. */
  tone?: "neutral" | "attention" | "danger";
  icon?: ReactNode;
  /** `data-banner` value, for tests and for stacking order. */
  name?: string;
}

const TONE = { neutral: hf.textSecondary, attention: hf.attention, danger: hf.danger } as const;

/** A full-width notice stacked under the header. */
export function FrameBanner({ children, action, tone = "neutral", icon, name }: FrameBannerProps) {
  return (
    <Box
      role="status"
      data-banner={name}
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 3,
        padding: "8px 20px",
        borderBottom: `1px solid ${hf.hairline}`,
        backgroundColor: hf.surface2,
        boxShadow: `inset 2px 0 0 ${TONE[tone]}`,
        color: hf.text,
      }}
    >
      {icon ? (
        <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: TONE[tone], flex: "none" }}>
          {icon}
        </Box>
      ) : null}
      <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>{children}</Box>
      {action}
    </Box>
  );
}
