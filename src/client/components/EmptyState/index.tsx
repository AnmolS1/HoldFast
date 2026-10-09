import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { t } from "../../lib/i18n";
import { hf } from "../../theme/tokens";

export type EmptyStateType = "first-use" | "cleared" | "no-results" | "unavailable";

export interface EmptyStateProps {
  type: EmptyStateType;
  title: string;
  body?: ReactNode;
  /** Buttons. The one call-to-action uses `<Button variant="cta">`. */
  actions?: ReactNode;
  /** Shown in mono after the body of an "unavailable" state. */
  requestId?: string;
  /** Heading level of the title; pages that have no other heading pass "h1". */
  headingLevel?: "h1" | "h2" | "h3";
}

// Drawn from the UI's own shapes — rows, a folder, the search lens — in one colour.
function Drawing({ type }: { type: EmptyStateType }) {
  const common = {
    width: 160,
    height: 96,
    viewBox: "0 0 160 96",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
    "aria-hidden": true,
  } as const;
  if (type === "first-use") {
    return (
      <svg {...common}>
        <rect x="8" y="8" width="144" height="18" rx="4" strokeDasharray="4 3" />
        <rect x="8" y="39" width="144" height="18" rx="4" strokeDasharray="4 3" />
        <rect x="8" y="70" width="144" height="18" rx="4" strokeDasharray="4 3" />
        <path d="M80 92V62" strokeWidth="2" strokeLinecap="round" />
        <path d="M72 70l8-8 8 8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === "cleared") {
    return (
      <svg {...common}>
        <path
          d="M20 30h32l8 8h80a6 6 0 0 1 6 6v36a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6V36a6 6 0 0 1 6-6Z"
          strokeDasharray="4 3"
        />
      </svg>
    );
  }
  if (type === "no-results") {
    return (
      <svg {...common}>
        <circle cx="70" cy="44" r="26" strokeDasharray="4 3" />
        <path d="M89 63l24 24" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="8" y="8" width="144" height="18" rx="4" />
      <rect x="8" y="39" width="144" height="18" rx="4" />
      <rect x="8" y="70" width="90" height="18" rx="4" />
      <path d="M118 70l16 16M134 70l-16 16" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The four empty states: first use, cleared, no results, unavailable. */
export function EmptyState({ type, title, body, actions, requestId, headingLevel = "h2" }: EmptyStateProps) {
  return (
    <Box
      data-empty-state={type}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: 8,
        textAlign: "center",
        minHeight: 320,
        flex: "1 1 auto",
      }}
    >
      <Box sx={{ color: hf.illustration, display: "inline-flex" }}>
        <Drawing type={type} />
      </Box>
      <Typography
        component={headingLevel}
        sx={{ margin: 0, fontSize: 16, lineHeight: "22px", fontWeight: 600 }}
      >
        {title}
      </Typography>
      {body || requestId ? (
        <Typography component="p" sx={{ margin: 0, color: hf.textSecondary, maxWidth: 320 }}>
          {body}
          {requestId ? (
            <>
              {" "}
              <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
                {t("app.requestId", { id: requestId })}
              </Box>
            </>
          ) : null}
        </Typography>
      ) : null}
      {actions ? (
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 2 }}>{actions}</Box>
      ) : null}
    </Box>
  );
}
