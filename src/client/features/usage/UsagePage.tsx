import Box from "@mui/material/Box";
import { Link as RouterLink } from "react-router";
import { Bytes } from "../../components/Bytes";
import { StorageBar } from "../../components/StorageBar";
import { formatBytes } from "../../lib/format";
import { hf, layout } from "../../theme/tokens";
import { ViewError, ViewPage } from "../starred/view-kit";
import { EmptyTrashAction } from "../trash/EmptyTrashAction";
import { usageBreakdown, useUsage, type UsagePart } from "./queries";
import { t } from "./strings";

const PART_LABEL = {
  files: "usage.files",
  trash: "usage.trash",
  versions: "usage.versions",
  reserved: "usage.reserved",
} as const satisfies Record<UsagePart, string>;

export function UsagePage() {
  const usage = useUsage();
  if (usage.isError && !usage.data) {
    return (
      <ViewPage view="usage">
        <ViewError
          view="usage"
          title={t("usage.error.title")}
          error={usage.error}
          onRetry={() => void usage.refetch()}
        />
      </ViewPage>
    );
  }
  const breakdown = usage.data ? usageBreakdown(usage.data) : null;
  return (
    <ViewPage view="usage">
      <Box sx={{ display: "flex", flexDirection: "column", gap: 5, padding: 5, maxWidth: 560 }}>
        <Box data-usage-level={breakdown?.level}>
          <StorageBar
            usage={usage.data ? { usedBytes: usage.data.usedBytes, quotaBytes: usage.data.quotaBytes } : null}
          />
        </Box>
        {breakdown ? (
          <>
            <Box component="p" className="mono" data-usage-free sx={{ margin: 0, color: hf.textSecondary }}>
              {breakdown.overBytes > 0
                ? t("usage.over", { over: formatBytes(breakdown.overBytes) })
                : t("usage.free", { free: formatBytes(breakdown.freeBytes) })}
            </Box>
            <Box component="section" aria-label={t("usage.breakdown")}>
              <Box
                component="h2"
                sx={{ margin: 0, paddingBottom: 2, fontSize: 15, lineHeight: "22px", fontWeight: 600 }}
              >
                {t("usage.breakdown")}
              </Box>
              <Box component="dl" sx={{ margin: 0 }}>
                {breakdown.parts.map(({ part, bytes }) => (
                  <Box
                    key={part}
                    data-usage-part={part}
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 3,
                      minHeight: layout.rowHeight,
                      borderBottom: `1px solid ${hf.hairline}`,
                    }}
                  >
                    <Box component="dt">{t(PART_LABEL[part])}</Box>
                    <Box component="dd" sx={{ margin: 0, color: hf.textSecondary }}>
                      <Bytes value={bytes} />
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </>
        ) : null}
        <Box component="p" sx={{ margin: 0, color: hf.textSecondary }}>
          {t("usage.note")}
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
          <EmptyTrashAction />
          <Box
            component={RouterLink}
            to="/trash"
            sx={{
              color: hf.textSecondary,
              textDecoration: "underline",
              textUnderlineOffset: "2px",
              "&:hover": { color: hf.text },
            }}
          >
            {t("usage.openTrash")}
          </Box>
        </Box>
      </Box>
    </ViewPage>
  );
}
