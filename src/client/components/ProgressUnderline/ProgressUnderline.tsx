import Box from "@mui/material/Box";
import { keyframes } from "@emotion/react";
import { useState } from "react";
import { hfAccent, motion } from "../../theme/tokens";
import { clampForward } from "./clamp";

const slide = keyframes({ from: { transform: "translateX(-100%)" }, to: { transform: "translateX(350%)" } });

export interface ProgressUnderlineProps {
  /** 0..1; `null` = indeterminate. */
  value: number | null;
  /** Accessible name, e.g. "Scanning notes.md". */
  label: string;
}

/**
 * The 1 px line under a row or tile. The fill only ever grows: a late or out-of-order sample
 * cannot pull it back. Static under reduced motion (the global rule switches transitions off).
 */
export function ProgressUnderline({ value, label }: ProgressUnderlineProps) {
  // The highest value seen so far; adjusted while rendering, so the first paint is already right.
  const [highest, setHighest] = useState(0);
  const shown = value === null ? null : clampForward(highest, value);
  if (shown !== null && shown !== highest) setHighest(shown);
  const percent = shown === null ? undefined : Math.round(shown * 100);
  return (
    <Box
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-progress={shown === null ? "indeterminate" : shown}
      sx={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "1px", backgroundColor: hfAccent.track, overflow: "hidden", pointerEvents: "none" }}
    >
      <Box
        sx={{
          height: "100%",
          backgroundColor: hfAccent.main,
          ...(shown === null
            ? {
                width: "30%",
                animation: `${slide} 1.2s linear infinite`,
                "@media (prefers-reduced-motion: reduce)": { animation: "none", width: "100%", opacity: 0.6 },
              }
            : { width: `${shown * 100}%`, transition: `width ${motion.fast}ms ease-out` }),
        }}
      />
    </Box>
  );
}
