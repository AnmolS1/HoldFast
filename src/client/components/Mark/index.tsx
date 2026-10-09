import Box from "@mui/material/Box";
import { t } from "../../lib/i18n";

/** The mark: one stem and three strands reaching down. Monochrome always (`currentColor`). */
export function Mark({ size = 20, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d="M10 2.5v8" />
      <path d="M10 10.5c0 3-2.6 5-5.5 6.5" />
      <path d="M10 10.5c0 3 2.6 5 5.5 6.5" />
      <path d="M10 10.5v7" />
      <circle cx="10" cy="2.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** Mark + "Holdfast" in Instrument Sans 600 with tight tracking. */
export function Wordmark({ size = 16 }: { size?: number }) {
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
      <Mark size={Math.round(size * 1.25)} />
      <Box component="span" sx={{ fontWeight: 600, fontSize: size, letterSpacing: "-0.02em", lineHeight: 1.25 }}>
        {t("app.name")}
      </Box>
    </Box>
  );
}
