// The details slot of the frame: a persistent panel on desktop (320 px by default; the user may hide
// it or resize it, F02), a bottom sheet on mobile.
import Box from "@mui/material/Box";
import { useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { hf, layout, motion } from "../../theme/tokens";
import { BottomSheet } from "../BottomSheet";
import { EmptyState } from "../EmptyState";
import { detailsApi, getDetails, subscribeDetails } from "./store";

/**
 * Desktop: the persistent panel. Its width is the frame's `--hf-details-w`; hidden, it is
 * `display: none` — out of the accessibility tree, not just zero wide.
 */
export function DetailsPanel({ id, hidden = false }: { id?: string; hidden?: boolean }) {
  const current = useSyncExternalStore(subscribeDetails, getDetails, getDetails);
  return (
    <Box
      component="aside"
      id={id}
      aria-label={t("details.label")}
      data-details-panel
      data-hidden={hidden || undefined}
      sx={{
        width: `var(--hf-details-w, ${layout.details}px)`,
        transition: `width ${motion.folder}ms ease-out`,
        "body[data-panel-drag] &": { transition: "none" },
        flex: "none",
        boxSizing: "border-box",
        borderLeft: `1px solid ${hf.hairline}`,
        backgroundColor: hf.bg,
        padding: 5,
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
        minHeight: 0,
      }}
    >
      {current.content ?? (
        <EmptyState type="cleared" title={t("details.empty.title")} body={t("details.empty.body")} />
      )}
    </Box>
  );
}

/** Mobile: the same content as a bottom sheet. */
export function DetailsSheet() {
  const current = useSyncExternalStore(subscribeDetails, getDetails, getDetails);
  return (
    <BottomSheet
      open={current.open && current.content !== null}
      onClose={detailsApi.close}
      title={current.title ?? t("details.label")}
      hideTitle={current.title === null}
    >
      <Box sx={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
        {current.content}
      </Box>
    </BottomSheet>
  );
}
