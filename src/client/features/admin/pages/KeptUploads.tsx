// "Resolve kept upload" (Addendum 0, 14:50 — the owner's "keep and alert" ruling): an upload the
// SERVER proved csam whose hash is no longer listed stays `completing`, its object kept, and
// blocks its account's purge until an operator decides. Two-step, typed reason, audited:
//   relist          the hash becomes a CONFIRMED csam listing — permanent — and the repair sweep
//                   locks the upload;
//   false positive  the session is ended and its object deleted (refused while held or paused).
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  KeptUploadDto,
  ResolveKeptUploadBody,
  ResolveKeptUploadResponse,
} from "../../../../shared/schemas/admin";
import { adminKeys, fetchKeptUploads, resolveKeptUpload } from "../api";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Facts, Loading, Mono, Note, ReasonDialog, Section, StatusLine } from "../ui";
import { bytes, refusalText, when } from "../words";

type Pick = { upload: KeptUploadDto; resolution: ResolveKeptUploadBody["resolution"] };

export function KeptUploadsPage() {
  const query = useAdminQuery(adminKeys.kept, fetchKeptUploads);
  const client = useQueryClient();
  const [pick, setPick] = useState<Pick | null>(null);
  const [preview, setPreview] = useState<ResolveKeptUploadResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const close = () => {
    setPick(null);
    setPreview(null);
    setError(null);
  };
  const submit = async (reason: string) => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await resolveKeptUpload(pick.upload.uploadId, {
        resolution: pick.resolution,
        reason,
        ...(preview ? { confirm: true as const } : {}),
      });
      if (!answer.confirmed) {
        setPreview(answer);
        return;
      }
      setStatus(pick.resolution === "relist" ? t("kept.relisted") : t("kept.ended"));
      close();
      void client.invalidateQueries({ queryKey: adminKeys.kept });
    } catch (failure) {
      setError(refusalText(failure, { held: t("kept.held"), destroy_paused: t("q.destroyPaused") }));
    } finally {
      setBusy(false);
    }
  };

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <Section id="kept" title={t("nav.kept")}>
      <Note>{t("kept.intro")}</Note>
      {query.data.items.length === 0 ? <Note>{t("kept.none")}</Note> : null}
      {query.data.items.map((upload) => (
        <Box
          key={upload.uploadId}
          data-admin-kept={upload.uploadId}
          sx={{ display: "flex", flexDirection: "column", gap: 1 }}
        >
          <Facts
            rows={[
              [t("kept.upload"), <Mono key="id">{upload.uploadId}</Mono>],
              [t("q.name"), upload.name],
              [t("q.size"), bytes(upload.size)],
              [t("q.sha"), upload.sha256 ? <Mono key="sha">{upload.sha256}</Mono> : "—"],
              [t("kept.listedAs"), upload.listedAs ?? t("kept.notListed")],
              [t("kept.owedAt"), when(upload.owedAt)],
            ]}
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button onClick={() => setPick({ upload, resolution: "relist" })}>{t("kept.relist")}</Button>
            <Button color="error" onClick={() => setPick({ upload, resolution: "false_positive" })}>
              {t("kept.falsePositive")}
            </Button>
          </Box>
        </Box>
      ))}
      <StatusLine tone="ok">{status}</StatusLine>
      <ReasonDialog
        open={pick !== null}
        title={pick?.resolution === "relist" ? t("kept.relist") : t("kept.falsePositive")}
        body={pick?.resolution === "relist" ? t("kept.relistBody") : t("kept.falsePositiveBody")}
        confirmLabel={preview ? t("common.confirm") : t("common.preview")}
        destructive={pick?.resolution === "false_positive"}
        busy={busy}
        error={error}
        onSubmit={(reason) => void submit(reason)}
        onCancel={close}
      >
        {preview ? <StatusLine tone="ok">{t("kept.previewed")}</StatusLine> : null}
      </ReasonDialog>
    </Section>
  );
}
