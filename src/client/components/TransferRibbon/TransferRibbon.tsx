import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { hf, hfAccent, motion } from "../../theme/tokens";
import { useTransferRibbon } from "./store";

/** A sentence change is announced at most this often; the latest one wins. */
export const ANNOUNCE_INTERVAL_MS = 5000;

function useThrottledAnnouncement(sentence: string | null): string {
  const [announced, setAnnounced] = useState("");
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    const next = sentence ?? "";
    const wait = Math.max(0, last.current + ANNOUNCE_INTERVAL_MS - Date.now());
    timer.current = setTimeout(() => {
      last.current = Date.now();
      setAnnounced(next);
    }, wait);
    return () => clearTimeout(timer.current);
  }, [sentence]);
  return announced;
}

/**
 * The one place activity lives: a 2 px line along the top edge of the content pane that fills
 * left to right, one sentence, and an expandable panel. Idle, it is a 2 px hairline.
 * It takes no props — features feed it through the store.
 */
export function TransferRibbon() {
  const { current, panels, openCount } = useTransferRibbon();
  const [wantsExpanded, setExpanded] = useState(false);
  const panelId = useId();
  const announcement = useThrottledAnnouncement(current ? current.sentence : null);
  const idle = current === null;

  // Collapse by itself once nothing is open (adjusted while rendering — no effect needed).
  if (openCount === 0 && wantsExpanded) setExpanded(false);
  const expanded = wantsExpanded && openCount > 0;

  const percent = current ? Math.round(current.progress * 100) : 0;
  const tone =
    current?.status === "error" ? hf.danger : current?.status === "paused" ? hf.textSecondary : hfAccent.main;
  const hasPanel = panels.length > 0;

  return (
    <Box data-transfer-ribbon={idle ? "idle" : current.status}>
      <Box
        aria-live="polite"
        role="status"
        data-ribbon-live
        sx={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {announcement}
      </Box>
      {idle ? (
        <Box aria-hidden="true" sx={{ height: "2px", backgroundColor: hf.hairline }} />
      ) : (
        <>
          <Box
            role="progressbar"
            aria-label={current.sentence}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            sx={{ height: "2px", backgroundColor: hfAccent.track }}
          >
            <Box
              data-ribbon-fill
              sx={{
                width: `${current.progress * 100}%`,
                height: "100%",
                backgroundColor: tone,
                transition: `width ${motion.fast}ms ease-out`,
              }}
            />
          </Box>
          <ButtonBase
            aria-expanded={hasPanel ? expanded : undefined}
            aria-controls={hasPanel && expanded ? panelId : undefined}
            disabled={!hasPanel}
            onClick={() => setExpanded((value) => !value)}
            sx={{
              display: "flex",
              width: "100%",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: 3,
              padding: "6px 20px",
              minHeight: 32,
              textAlign: "left",
              font: "inherit",
              color: hf.text,
              borderBottom: `1px solid ${hf.hairline}`,
              backgroundColor: hfAccent.wash,
              "&.Mui-disabled": { color: hf.text },
            }}
          >
            <Box
              component="span"
              aria-hidden="true"
              sx={{ width: 8, height: 8, borderRadius: "4px", backgroundColor: tone, flex: "none" }}
            />
            <Box
              component="span"
              data-ribbon-sentence
              sx={{
                fontWeight: 500,
                flex: "1 1 auto",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {current.sentence}
            </Box>
            {hasPanel ? (
              <Box component="span" sx={{ color: hf.textSecondary, fontSize: 12, flex: "none" }}>
                {expanded ? t("ribbon.hide") : t("ribbon.show")}
              </Box>
            ) : null}
          </ButtonBase>
          {hasPanel && expanded ? (
            <Box
              id={panelId}
              role="region"
              aria-label={t("ribbon.label")}
              data-ribbon-panel
              sx={{
                maxHeight: "40dvh",
                overflowY: "auto",
                borderBottom: `1px solid ${hf.hairline}`,
                backgroundColor: hf.surface,
              }}
            >
              {panels.map((panel) => (
                <Box key={panel.sourceId} data-ribbon-source={panel.sourceId}>
                  {panel.node}
                </Box>
              ))}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}
