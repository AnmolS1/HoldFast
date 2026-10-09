import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import type { ReactNode } from "react";
import { formatBytes } from "../../lib/format";
import { t } from "../../lib/i18n";
import { hf } from "../../theme/tokens";
import type { UsageSummary } from "../slots";

export interface StorageBarProps {
  /** `null` while unknown: the bar shows its skeleton. */
  usage: UsageSummary | null;
  /** e.g. the "Manage storage" link. */
  footer?: ReactNode;
}

export const ALMOST_FULL = 0.9;

/** Storage use as a sentence and a 3 px bar. The bar is graphite; only the warning is coloured. */
export function StorageBar({ usage, footer }: StorageBarProps) {
  if (!usage) {
    return (
      <Box
        role="status"
        aria-busy="true"
        aria-label={t("storage.loading")}
        sx={{ display: "flex", flexDirection: "column", gap: "6px" }}
      >
        <Skeleton variant="text" width="70%" height={16} />
        <Skeleton variant="rectangular" height={3} sx={{ borderRadius: "2px" }} />
      </Box>
    );
  }
  const ratio = usage.quotaBytes > 0 ? Math.min(1, Math.max(0, usage.usedBytes / usage.quotaBytes)) : 0;
  const used = formatBytes(usage.usedBytes);
  const quota = formatBytes(usage.quotaBytes);
  const warning = ratio >= 1 ? t("storage.full") : ratio >= ALMOST_FULL ? t("storage.almostFull") : null;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 2 }}>
        <Box component="span" sx={{ color: hf.textSecondary, fontSize: 12 }}>
          {t("storage.label")}
        </Box>
        <Box component="span" className="mono" sx={{ color: hf.text }}>
          {t("storage.of", { used, quota })}
        </Box>
      </Box>
      <Box
        role="img"
        aria-label={t("storage.aria", { used, quota })}
        sx={{ height: "3px", backgroundColor: hf.hairline, borderRadius: "2px", overflow: "hidden" }}
      >
        <Box
          data-storage-fill
          sx={{ width: `${ratio * 100}%`, height: "100%", backgroundColor: hf.textSecondary }}
        />
      </Box>
      {warning ? (
        <Box component="span" sx={{ color: ratio >= 1 ? hf.danger : hf.attention, fontSize: 12 }}>
          {warning}
        </Box>
      ) : null}
      {footer}
    </Box>
  );
}
