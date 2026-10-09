// The details slot of the frame: a persistent 320 px panel on desktop, a bottom sheet on mobile.
import Box from "@mui/material/Box";
import { useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { hf, layout } from "../../theme/tokens";
import { BottomSheet } from "../BottomSheet";
import { EmptyState } from "../EmptyState";
import { detailsApi, getDetails, subscribeDetails } from "./store";

/** Desktop: the persistent panel. */
export function DetailsPanel() {
  const current = useSyncExternalStore(subscribeDetails, getDetails, getDetails);
  return (
    <Box
      component="aside"
      aria-label={t("details.label")}
      data-details-panel
      sx={{ width: layout.details, flex: "none", boxSizing: "border-box", borderLeft: `1px solid ${hf.hairline}`, backgroundColor: hf.bg, padding: 5, display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", minHeight: 0 }}
    >
      {current.content ?? <EmptyState type="cleared" title={t("details.empty.title")} body={t("details.empty.body")} />}
    </Box>
  );
}

/** Mobile: the same content as a bottom sheet. */
export function DetailsSheet() {
  const current = useSyncExternalStore(subscribeDetails, getDetails, getDetails);
  return (
    <BottomSheet open={current.open && current.content !== null} onClose={detailsApi.close} title={current.title ?? t("details.label")} hideTitle={current.title === null}>
      <Box sx={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 4 }}>{current.content}</Box>
    </BottomSheet>
  );
}
