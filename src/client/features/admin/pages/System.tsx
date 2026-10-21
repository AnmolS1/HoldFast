// Section 11: the system. Build stamp, database and object-store health, the display flags; the
// scanner check (on demand only — it wakes the container); "Run now" per scheduled job; the
// rollback detector's panel with the one audited way to level the two numbers; and the operator's
// PAUSE SWITCH, which stops every job and request path that destroys (an object beside the
// generation: a database restore cannot undo it).
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  AcceptGenerationResponse,
  AdminSystemDto,
  DetectorDto,
  ScannerCheckResponse,
} from "../../../../shared/schemas/admin";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { acceptGeneration, adminKeys, checkScanner, fetchSystem, setDestroyPause } from "../api";
import { useAdminQuery } from "../query";
import { runUntilDone, type LoopOutcome } from "../run-now";
import { t } from "../strings";
import { ErrorState, Facts, Loading, Note, ReasonDialog, Section, StatusLine } from "../ui";
import { label, refusalText } from "../words";

export function SystemPage() {
  const query = useAdminQuery(adminKeys.system, fetchSystem);
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <System system={query.data} />;
}

function System({ system }: { system: AdminSystemDto }) {
  const client = useQueryClient();
  const [showDetector, setShowDetector] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: adminKeys.system });
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-system>
      <Section
        id="health"
        title={t("sys.health")}
        action={<Button onClick={refresh}>{t("common.refresh")}</Button>}
      >
        <Facts
          rows={[
            [t("sys.build"), `${system.build.sha ?? "—"} · ${system.build.builtAt ?? "—"}`],
            [t("sys.database"), system.database.ok ? t("sys.ok") : t("sys.down")],
            [t("sys.storage"), system.storage.ok ? t("sys.ok") : t("sys.down")],
            [t("sys.photodna"), system.flags.photodnaEnabled ? t("common.on") : t("common.off")],
            [t("sys.scanStub"), system.flags.scanStub ? t("common.on") : t("common.off")],
          ]}
        />
      </Section>
      <Scanner available={system.scannerAvailable} />
      <Section id="jobs" title={t("sys.jobs")}>
        {system.jobs.map((job) => (
          <JobRow
            key={job.name}
            job={job}
            onStopped={() => {
              setShowDetector(true);
              refresh();
            }}
          />
        ))}
      </Section>
      <DetectorPanel detector={system.detector} highlight={showDetector} onChanged={refresh} />
      <PauseSwitch detector={system.detector} onChanged={refresh} />
    </Box>
  );
}

function Scanner({ available }: { available: boolean }) {
  const [result, setResult] = useState<ScannerCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await checkScanner());
    } catch (failure) {
      setError(refusalText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="scanner" title={t("sys.scanner")}>
      {!available ? (
        <Note>{t("sys.scannerNone")}</Note>
      ) : (
        <>
          <Note>{t("sys.scannerWakes")}</Note>
          <Box>
            <Button onClick={() => void check()} disabled={busy}>
              {t("sys.checkScanner")}
            </Button>
          </Box>
        </>
      )}
      {result && !result.available ? <Note>{t("sys.scannerNone")}</Note> : null}
      {result?.instances.map((instance) => (
        <Box key={instance.name} data-admin-scanner={instance.name} sx={{ fontSize: 13 }}>
          {instance.name}:{" "}
          {instance.ok
            ? t("sys.scannerState", {
                ready: instance.ready ? t("common.yes") : t("common.no"),
                db: instance.dbVersion ?? "—",
                age: String(instance.dbAgeHours ?? "—"),
                freshclam: instance.freshclam ?? "—",
              })
            : (instance.error ?? t("common.failed"))}
        </Box>
      ))}
      {error ? <StatusLine tone="error">{error}</StatusLine> : null}
    </Section>
  );
}

function JobRow({ job, onStopped }: { job: AdminSystemDto["jobs"][number]; onStopped(): void }) {
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [passes, setPasses] = useState(0);
  const [outcome, setOutcome] = useState<LoopOutcome | null>(null);
  const start = async () => {
    setConfirm(false);
    setRunning(true);
    setOutcome(null);
    setPasses(0);
    const result = await runUntilDone(job.name, setPasses);
    if (result.kind === "aborted") return;
    setPasses(result.passes);
    setOutcome(result);
    setRunning(false);
    if (result.kind === "stopped") onStopped();
  };
  return (
    <Box
      data-admin-job={job.name}
      sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}
    >
      <Box sx={{ minWidth: 180 }}>
        <strong>{job.name}</strong> <span>{job.cron}</span> {job.guarded ? `· ${t("sys.guarded")}` : ""}
      </Box>
      <Button size="small" disabled={running} onClick={() => setConfirm(true)}>
        {t("sys.runNow")}
      </Button>
      {running ? <span role="status">{t("sys.running", { passes })}</span> : null}
      {outcome ? (
        <span role="status" data-admin-job-outcome={outcome.kind}>
          {outcome.kind === "done"
            ? t("sys.done", { passes: outcome.passes })
            : outcome.kind === "stopped"
              ? t(outcome.reason === "destroy_paused" ? "sys.stoppedPaused" : "sys.stoppedRollback")
              : outcome.kind === "error"
                ? refusalText(outcome.error)
                : ""}
        </span>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={t("sys.runConfirm", { name: job.name })}
        consequence={t("sys.runConfirmBody")}
        confirmLabel={t("sys.runNow")}
        onConfirm={() => void start()}
        onCancel={() => setConfirm(false)}
      />
    </Box>
  );
}

function DetectorPanel({
  detector,
  highlight,
  onChanged,
}: {
  detector: DetectorDto;
  highlight: boolean;
  onChanged(): void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AcceptGenerationResponse | null>(null);
  const [ticks, setTicks] = useState([false, false, false]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const level = detector.reading === "level" || detector.reading === "first";
  const close = () => {
    setOpen(false);
    setPreview(null);
    setTicks([false, false, false]);
    setError(null);
  };
  const submit = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await acceptGeneration(
        preview
          ? {
              reason,
              confirm: true,
              checklist: { pausedAndOrphansOff: true, reapplied: true, reconciled: true },
            }
          : { reason },
      );
      if (!answer.confirmed) {
        setPreview(answer);
        return;
      }
      setStatus(t("gen.done"));
      close();
      onChanged();
    } catch (failure) {
      setError(
        refusalText(failure, {
          unreadable: t("gen.unreadable"),
          lock_held: t("gen.lockHeld"),
          changed_meanwhile: t("gen.changed"),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="detector" title={t("sys.detector")}>
      <Box
        data-admin-detector={detector.reading}
        data-admin-detector-highlight={highlight ? "true" : undefined}
      >
        <Facts
          rows={[
            [t("gen.object"), detector.object.raw ?? t("gen.none")],
            [t("gen.database"), detector.database.raw ?? t("gen.none")],
            [t("gen.reading"), label("reading", detector.reading)],
            [t("gen.pause"), label("switch", detector.pauseSwitch)],
            [t("gen.orphans"), detector.orphanDeleteEnabled ? t("common.on") : t("common.off")],
          ]}
        />
      </Box>
      {level ? null : (
        <Box>
          <Button onClick={() => setOpen(true)} disabled={detector.reading === "unreadable"}>
            {t("gen.accept")}
          </Button>
        </Box>
      )}
      <Note>{t("gen.remind")}</Note>
      <StatusLine tone="ok">{status}</StatusLine>
      <ReasonDialog
        open={open}
        title={t("gen.accept")}
        body={preview ? t(`gen.action.${preview.action}`) : t("gen.body")}
        confirmLabel={preview ? t("gen.level") : t("common.preview")}
        destructive={Boolean(preview)}
        busy={busy}
        error={error}
        canSubmit={!preview || ticks.every(Boolean)}
        onSubmit={(reason) => void submit(reason)}
        onCancel={close}
      >
        {preview ? (
          <Box data-admin-checklist-s11 sx={{ display: "flex", flexDirection: "column" }}>
            {(["gen.check.1", "gen.check.2", "gen.check.3"] as const).map((key, index) => (
              <FormControlLabel
                key={key}
                control={
                  <Checkbox
                    checked={ticks[index]}
                    // In this order: a later item is ticked only after the one before it.
                    disabled={index > 0 && !ticks[index - 1]}
                    onChange={(event) =>
                      setTicks((current) =>
                        current.map((value, i) =>
                          i === index ? event.target.checked : i > index ? false : value,
                        ),
                      )
                    }
                  />
                }
                label={t(key)}
              />
            ))}
          </Box>
        ) : null}
      </ReasonDialog>
    </Section>
  );
}

function PauseSwitch({ detector, onChanged }: { detector: DetectorDto; onChanged(): void }) {
  const on = detector.pauseSwitch !== "off";
  const [open, setOpen] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setPreviewed(false);
    setError(null);
  };
  const submit = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await setDestroyPause({
        on: !on,
        reason,
        ...(previewed ? { confirm: true as const } : {}),
      });
      if (!answer.confirmed) {
        setPreviewed(true);
        return;
      }
      close();
      onChanged();
    } catch (failure) {
      setError(refusalText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="pause" title={t("pause.title")}>
      <Box role="status" data-admin-pause={detector.pauseSwitch}>
        {label("switch", detector.pauseSwitch)}
      </Box>
      <Note>{t("pause.explain")}</Note>
      <Box>
        <Button color={on ? "primary" : "error"} onClick={() => setOpen(true)}>
          {on ? t("pause.turnOff") : t("pause.turnOn")}
        </Button>
      </Box>
      <ReasonDialog
        open={open}
        title={on ? t("pause.turnOff") : t("pause.turnOn")}
        body={previewed ? (on ? t("pause.confirmOff") : t("pause.confirmOn")) : t("pause.previewBody")}
        confirmLabel={previewed ? t("common.confirm") : t("common.preview")}
        busy={busy}
        error={error}
        onSubmit={(reason) => void submit(reason)}
        onCancel={close}
      />
    </Section>
  );
}
