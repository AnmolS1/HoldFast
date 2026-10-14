// `/uploads` — where uploading starts when no listing is on screen. It shows a way to choose
// files and how much room is left; progress is the transfer ribbon's, on every page.
// `?parent=<folderId>` names the folder the files go to.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { NodeId } from "../../../shared/schemas/common";
import { EmptyState } from "../../components/EmptyState";
import { ApiError } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { t as shellT } from "../../lib/i18n";
import { usePublicConfig } from "../../lib/query";
import { hf } from "../../theme/tokens";
import { restoreUploads } from "./manager";
import { openPicker } from "./picker";
import { getUsage } from "./protocol";
import { t } from "./strings";

export function UploadsPage() {
  const [search] = useSearchParams();
  // The same rule as everywhere: only a well-formed id is a folder; anything else is the top level.
  const asked = search.get("parent");
  const parentId = asked !== null && NodeId.safeParse(asked).success ? asked : null;
  const config = usePublicConfig().data;
  const usage = useQuery({ queryKey: ["upload", "usage"], queryFn: ({ signal }) => getUsage(signal) });
  const off = config ? !config.uploadsEnabled || config.readOnly : false;

  useEffect(() => {
    // Here the open sessions are asked for too: this is the page a resume starts from.
    void restoreUploads({ server: true });
  }, []);

  if (usage.isError) {
    return (
      <EmptyState
        type="unavailable"
        title={t("page.error.title")}
        body={t("page.error.body")}
        requestId={usage.error instanceof ApiError ? usage.error.requestId : undefined}
        actions={<Button onClick={() => void usage.refetch()}>{shellT("app.retry")}</Button>}
      />
    );
  }

  return (
    <Box
      data-uploads-page
      sx={{
        maxWidth: 640,
        padding: 5,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        alignItems: "flex-start",
      }}
    >
      <Typography sx={{ color: hf.textSecondary }}>{t("page.intro")}</Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
        <Button variant="contained" disabled={off} onClick={() => openPicker("files", parentId)}>
          {t("page.chooseFiles")}
        </Button>
        <Button disabled={off} onClick={() => openPicker("folder", parentId)}>
          {t("page.chooseFolder")}
        </Button>
      </Box>
      {off ? <Typography sx={{ color: hf.textSecondary }}>{t("page.paused")}</Typography> : null}
      {usage.data ? (
        <Typography data-uploads-free className="num" sx={{ color: hf.textSecondary }}>
          {t("page.free", {
            free: formatBytes(Math.max(0, usage.data.quotaBytes - usage.data.usedBytes)),
            quota: formatBytes(usage.data.quotaBytes),
          })}
        </Typography>
      ) : null}
    </Box>
  );
}
