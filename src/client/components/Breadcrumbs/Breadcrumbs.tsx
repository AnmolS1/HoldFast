// The header's breadcrumb trail. The frame renders it; without a trail set by a feature, it shows
// the route's `handle.title`.
import Box from "@mui/material/Box";
import { ViewTransition } from "react";
import { Link as RouterLink } from "react-router";
import { t } from "../../lib/i18n";
import { hf } from "../../theme/tokens";
import { useTrail } from "./store";

export interface BreadcrumbsProps {
  /** Shown as the page title when no feature has set a trail. */
  fallbackTitle: string;
  /** Mobile: only the parent and the current page, the title larger. */
  compact?: boolean;
}

/** Parents as links in a nav; the current page as the document's `h1`. */
export function Breadcrumbs({ fallbackTitle, compact = false }: BreadcrumbsProps) {
  const crumbs = useTrail() ?? [{ label: fallbackTitle }];
  const current = crumbs[crumbs.length - 1] ?? { label: fallbackTitle };
  const parents = compact ? crumbs.slice(-2, -1) : crumbs.slice(0, -1);
  const title = (
    <Box component="h1" data-page-title sx={{ margin: 0, fontSize: compact ? 20 : 15, lineHeight: compact ? "26px" : "22px", fontWeight: compact ? 600 : 500, letterSpacing: compact ? "-0.01em" : 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
      {current.label}
    </Box>
  );
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0 }}>
      {parents.length > 0 ? (
        <Box component="nav" aria-label={t("nav.breadcrumb")} sx={{ flex: "0 1 auto", minWidth: 0 }}>
          <Box component="ol" sx={{ display: "flex", alignItems: "baseline", gap: "6px", listStyle: "none", margin: 0, padding: 0, minWidth: 0 }}>
            {parents.map((crumb, index) => (
              <Box component="li" key={`${crumb.to ?? ""}:${index}`} sx={{ display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0, fontSize: compact ? 14 : 15 }}>
                {crumb.to ? (
                  <Box component={RouterLink} to={crumb.to} sx={{ color: hf.textSecondary, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", "&:hover": { color: hf.text, textDecoration: "underline" } }}>
                    {crumb.label}
                  </Box>
                ) : (
                  <Box component="span" sx={{ color: hf.textSecondary }}>
                    {crumb.label}
                  </Box>
                )}
                <Box component="span" aria-hidden="true" sx={{ color: hf.textSecondary }}>
                  /
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}
      {current.id ? <ViewTransition name={`hf-node-${current.id}`}>{title}</ViewTransition> : title}
    </Box>
  );
}
