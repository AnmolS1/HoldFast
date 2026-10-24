// Your data: the export (a JSON file of the account's records, no file contents), "Download
// everything" (the explorer's zip engine over `{ allOwned: true }`), and the account's deletion —
// requested through Better Auth (a mailed link), its state read from T06's deletion-status, and
// cancelled through T06's route. The app-wide banner is the shell's; this section shows the same
// state in place and never depends on the `?deletion=scheduled` cue (the shell consumes it).
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ZIP_MAX_ENTRIES } from "../../../shared/constants";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toaster";
import { ApiError, toastApiError } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { accountEpoch, deletionStatusQuery, refreshSession, sameAccount, useSession } from "../../lib/query";
import { startZip } from "../explorer";
import { cancelDeletion, fetchExport } from "./api";
import { requestDeletion } from "./auth-calls";
import { notIncludedText } from "./not-included";
import { saveBlob } from "./download";
import { t } from "./strings";
import { failureText } from "./failures";
import { Note, Section, StatusLine } from "./ui";

function ExportPart() {
  const [busy, setBusy] = useState(false);
  const onExport = async () => {
    const then = accountEpoch();
    setBusy(true);
    try {
      const manifest = await fetchExport();
      // Another account by now: this account's data is not handed over.
      if (!sameAccount(then)) return;
      const day = manifest.exportedAt.slice(0, 10);
      saveBlob(
        new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
        `holdfast-export-${day}.json`,
      );
      toast({ message: t("data.export.done"), key: "export" });
    } catch (cause) {
      if (sameAccount(then)) toastApiError(cause);
    } finally {
      if (sameAccount(then)) setBusy(false);
    }
  };
  return (
    <Section id="export" title={t("data.export.title")}>
      <Note>{t("data.export.body")}</Note>
      <Box>
        <Button variant="outlined" onClick={() => void onExport()} disabled={busy}>
          {busy ? t("data.export.busy") : t("data.export.action")}
        </Button>
      </Box>
    </Section>
  );
}

function ZipPart() {
  const [busy, setBusy] = useState(false);
  const count = ZIP_MAX_ENTRIES.toLocaleString("en");
  const onZip = async () => {
    setBusy(true);
    // The engine says how it ended (the toast, the ribbon); the truncation is said there and here.
    await startZip({ allOwned: true }, "holdfast-everything", { notIncluded: notIncludedText });
    setBusy(false);
  };
  return (
    <Section id="zip" title={t("data.zip.title")}>
      <Note>{t("data.zip.body")}</Note>
      <Note>{t("data.zip.limit", { count })}</Note>
      <Box>
        <Button variant="outlined" onClick={() => void onZip()} disabled={busy}>
          {t("data.zip.action")}
        </Button>
      </Box>
    </Section>
  );
}

function DeletePart() {
  const queryClient = useQueryClient();
  const session = useSession().data;
  const status = useQuery({ ...deletionStatusQuery, enabled: Boolean(session) });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // Why Cancel can no longer work here (a 409): the deletion has started, or an administrator
  // scheduled it (`deletion_admin_scheduled`, which only an administrator can cancel).
  const [stopped, setStopped] = useState<"started" | "adminScheduled" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const scheduledFor = status.data?.scheduledFor ?? null;

  const onRequest = async () => {
    const then = accountEpoch();
    setBusy(true);
    setFailure(null);
    const result = await requestDeletion();
    if (!sameAccount(then)) return;
    setBusy(false);
    setConfirming(false);
    if (result.error) {
      setFailure(failureText(result.error));
      return;
    }
    setSent(true);
  };

  const onCancel = async () => {
    const then = accountEpoch();
    setBusy(true);
    setFailure(null);
    try {
      await cancelDeletion();
      if (!sameAccount(then)) return;
      setSent(false);
      queryClient.setQueryData(deletionStatusQuery.queryKey, { scheduledFor: null });
      toast({ message: t("data.delete.cancelled"), key: "deletion" });
      await queryClient.invalidateQueries({ queryKey: deletionStatusQuery.queryKey });
      void refreshSession().catch(() => {});
    } catch (cause) {
      if (!sameAccount(then)) return;
      if (cause instanceof ApiError && cause.status === 409)
        setStopped(cause.code === "deletion_admin_scheduled" ? "adminScheduled" : "started");
      else toastApiError(cause);
    } finally {
      if (sameAccount(then)) setBusy(false);
    }
  };

  return (
    <Section id="delete" title={t("data.delete.title")}>
      {status.isError ? <StatusLine tone="error">{t("data.delete.statusError")}</StatusLine> : null}
      {scheduledFor ? (
        <Box data-deletion-scheduled={scheduledFor} sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <StatusLine tone="error">
            {stopped
              ? t(stopped === "adminScheduled" ? "data.delete.adminScheduled" : "data.delete.started")
              : t("data.delete.scheduled", {
                  date: formatDate(scheduledFor, { timeZone: session?.user.timezone, style: "long" }),
                })}
          </StatusLine>
          {stopped ? null : (
            <>
              <Note>{t("data.delete.scheduled.body")}</Note>
              <Box>
                <Button variant="contained" onClick={() => void onCancel()} disabled={busy}>
                  {t("data.delete.cancel")}
                </Button>
              </Box>
            </>
          )}
        </Box>
      ) : (
        <>
          <Note>{t("data.delete.body")}</Note>
          {sent ? <StatusLine tone="ok">{t("data.delete.sent")}</StatusLine> : null}
          <StatusLine tone="error">{failure}</StatusLine>
          <Box>
            <Button
              variant="outlined"
              color="error"
              onClick={() => setConfirming(true)}
              disabled={busy || !status.data}
            >
              {t("data.delete.action")}
            </Button>
          </Box>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        title={t("data.delete.confirm.title")}
        consequence={t("data.delete.confirm.body")}
        confirmLabel={t("data.delete.confirm.action")}
        destructive
        busy={busy}
        onConfirm={() => void onRequest()}
        onCancel={() => setConfirming(false)}
      />
    </Section>
  );
}

export function DataSection() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <ExportPart />
      <ZipPart />
      <DeletePart />
    </Box>
  );
}
