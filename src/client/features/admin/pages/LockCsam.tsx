// "Find, then lock as suspected CSAM" — a lock from an outside notice (Cloudflare's match mail,
// NCMEC, law enforcement). The reference is a node id, an R2 object key or a files-host URL/path
// (the token in it is neither checked nor kept). Two steps: the match (metadata only — never a
// preview, thumbnail or URL), then the lock, which lands on the case's report.
import Box from "@mui/material/Box";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { LockCsamResponse } from "../../../../shared/schemas/admin";
import { lockCsam } from "../api";
import { t } from "../strings";
import { Facts, Field, Mono, Note, ReasonDialog, Section } from "../ui";
import Button from "@mui/material/Button";
import { bytes, refusalText } from "../words";

export function LockCsamPage() {
  const navigate = useNavigate();
  const [reference, setReference] = useState("");
  const [open, setOpen] = useState(false);
  const [match, setMatch] = useState<LockCsamResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await lockCsam({
        reference: reference.trim(),
        reason,
        ...(match ? { confirm: true as const } : {}),
      });
      if (!answer.confirmed) {
        setMatch(answer);
        return;
      }
      setOpen(false);
      if (answer.reportId) void navigate(`/admin/reports/${answer.reportId}`);
    } catch (failure) {
      setMatch(null);
      setError(refusalText(failure, { folder: t("r.folder") }) || t("lockCsam.noMatch"));
      if ((failure as { status?: number }).status === 404) setError(t("lockCsam.noMatch"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="lock-csam" title={t("nav.lockCsam")}>
      <Note>{t("lockCsam.intro")}</Note>
      <Box sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
        <Box sx={{ flex: "1 1 360px" }}>
          <Field
            label={t("lockCsam.reference")}
            name="reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Box>
        <Button
          variant="contained"
          disabled={!reference.trim()}
          onClick={() => {
            setMatch(null);
            setError(null);
            setOpen(true);
          }}
        >
          {t("lockCsam.find")}
        </Button>
      </Box>
      <ReasonDialog
        open={open}
        title={t("nav.lockCsam")}
        body={match ? t("lockCsam.confirmBody") : t("lockCsam.findBody")}
        confirmLabel={match ? t("lockCsam.lock") : t("lockCsam.find")}
        destructive={Boolean(match)}
        busy={busy}
        error={error}
        onSubmit={(reason) => void submit(reason)}
        onCancel={() => setOpen(false)}
      >
        {match ? (
          <Box data-admin-lock-match>
            <Facts
              rows={[
                [t("q.id"), <Mono key="id">{match.match.nodeId}</Mono>],
                [t("q.name"), match.match.name],
                [t("q.type"), match.match.mimeSniffed ?? "—"],
                [t("q.size"), bytes(match.match.size)],
                [t("q.owner"), match.match.owner.displayName],
                [t("q.sha"), match.match.sha256 ?? "—"],
                [
                  t("lockCsam.uploaders"),
                  match.match.uploaders
                    .map((u) => `${u.versionId}: ${u.uploader?.displayName ?? "—"}`)
                    .join(", "),
                ],
              ]}
            />
          </Box>
        ) : null}
      </ReasonDialog>
    </Section>
  );
}
