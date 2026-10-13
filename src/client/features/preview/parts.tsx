// Small pieces every state of the preview shares.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { t } from "./strings";
import type { PreviewFailure } from "./usePreviewUrl";

/** Fills the content area while something is on its way. */
export function PreviewSkeleton() {
  return (
    <Box
      role="status"
      aria-label={t("preview.loading")}
      data-preview-state="loading"
      sx={{ flex: "1 1 auto", minHeight: 240, display: "flex", padding: 5 }}
    >
      <Skeleton variant="rounded" animation="wave" sx={{ flex: "1 1 auto", height: "auto" }} />
    </Box>
  );
}

export interface ErrorStateProps {
  failure: PreviewFailure;
  onRetry?(): void;
}

/** What went wrong and what to do; the request id when the app API gave one. */
export function ErrorState({ failure, onRetry }: ErrorStateProps) {
  return (
    <Box data-preview-state="error" role="alert" sx={{ flex: "1 1 auto", display: "flex" }}>
      <EmptyState
        type="unavailable"
        headingLevel="h3"
        title={failure.notFound ? t("error.notFound.title") : t("error.title")}
        body={failure.notFound ? t("error.notFound.body") : t("error.body")}
        requestId={failure.requestId}
        actions={onRetry ? <Button onClick={onRetry}>{t("error.retry")}</Button> : undefined}
      />
    </Box>
  );
}
