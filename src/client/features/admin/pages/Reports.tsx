// Section 5 and 6: reports and the NCMEC procedure. The detail shows NO content — metadata, the
// reporter's text, scan detail, the uploader's account age and strikes, a link summary — and the
// fixed notice that the adjudication rule is pending counsel. A csam case runs here: start the
// procedure, open the evidence (on screen only), record the filing, release holds, clear a lock
// made in error.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import type {
  NcmecEvidenceResponse,
  ReleaseHoldsResponse,
  ReportActionBody,
  ReportDetailDto,
} from "../../../../shared/schemas/admin";
import {
  adminKeys,
  assignReport,
  clearLock,
  fetchReport,
  fetchReports,
  ncmecEvidence,
  ncmecFiled,
  ncmecStart,
  queryString,
  releaseHolds,
  reportAction,
} from "../api";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Facts, Field, Loading, Mono, Note, ReasonDialog, Section, StatusLine } from "../ui";
import { bytes, clearSentences, label, overdue, reasonOf, refusalText, when } from "../words";

export function ReportsPage() {
  const [filters, setFilters] = useState({ status: "", category: "", source: "", olderThanHours: "" });
  const search = queryString(filters);
  const query = useAdminQuery(adminKeys.reports(search), (signal) => fetchReports(search, signal));
  const navigate = useNavigate();
  const set = (name: keyof typeof filters) => (event: { target: { value: string } }) =>
    setFilters((current) => ({ ...current, [name]: event.target.value }));
  const columns: GridColDef[] = [
    { field: "category", headerName: t("r.category"), flex: 1 },
    { field: "status", headerName: t("r.status"), flex: 1 },
    { field: "source", headerName: t("r.source"), flex: 1 },
    { field: "createdAt", headerName: t("r.created"), flex: 1 },
    { field: "badge", headerName: "", width: 90 },
  ];
  const choice = (name: keyof typeof filters, values: string[], prefix: string) => (
    <Box sx={{ width: 170 }}>
      <Field select label={t(`r.filter.${name}`)} value={filters[name]} onChange={set(name)}>
        <MenuItem value="">{t("common.any")}</MenuItem>
        {values.map((value) => (
          <MenuItem key={value} value={value}>
            {label(prefix, value)}
          </MenuItem>
        ))}
      </Field>
    </Box>
  );
  return (
    <Section
      id="reports"
      title={t("nav.reports")}
      action={<Button onClick={() => void query.refetch()}>{t("common.refresh")}</Button>}
    >
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        {choice("status", ["open", "reviewing", "actioned", "dismissed"], "reportStatus")}
        {choice("category", ["malware", "csam", "copyright", "phishing", "spam", "other"], "category")}
        {choice("source", ["user", "system", "admin", "photodna"], "source")}
        <Box sx={{ width: 170 }}>
          <Field
            label={t("r.filter.olderThanHours")}
            value={filters.olderThanHours}
            onChange={set("olderThanHours")}
          />
        </Box>
      </Box>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <AdminDataGrid
          rows={query.data.items.map((report) => ({
            id: report.id,
            category: label("category", report.category),
            status: label("reportStatus", report.status),
            source: label("source", report.source),
            createdAt: when(report.createdAt),
            badge: overdue(report) ? t("r.badge24") : "",
          }))}
          columns={columns}
          onRowClick={(params) => void navigate(`/admin/reports/${String(params.id)}`)}
        />
      )}
    </Section>
  );
}

export function ReportDetailPage() {
  const { reportId = "" } = useParams();
  const query = useAdminQuery(adminKeys.report(reportId), (signal) => fetchReport(reportId, signal));
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-report-page>
      {/* On every report detail, whatever happens below (task §5). */}
      <Box
        role="note"
        data-admin-counsel-notice
        sx={{ padding: 2, border: "1px solid", borderRadius: 1, fontSize: 13 }}
      >
        {t("r.counselNotice")}
      </Box>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <ReportDetail key={query.data.report.id} detail={query.data} />
      )}
    </Box>
  );
}

type Step =
  | { kind: "dismiss" | "takedown" | "strike" | "escalate_csam" }
  | { kind: "release"; preview: ReleaseHoldsResponse | null }
  | { kind: "clear"; previewed: boolean }
  | null;

function ReportDetail({ detail }: { detail: ReportDetailDto }) {
  const report = detail.report;
  const node = report.node;
  const isCsam = report.category === "csam";
  const locked = node?.scanStatus === "suspected_csam";
  const client = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<NcmecEvidenceResponse | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [filedId, setFiledId] = useState("");
  const [filedAt, setFiledAt] = useState("");

  const refresh = () => void client.invalidateQueries({ queryKey: adminKeys.report(report.id) });
  const close = () => {
    setStep(null);
    setError(null);
  };

  const act = async (reason: string) => {
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      if (step.kind === "release") {
        const answer = await releaseHolds(report.id, {
          reason,
          ...(step.preview ? { confirm: true as const } : {}),
        });
        if (!answer.confirmed) {
          setStep({ kind: "release", preview: answer });
          return;
        }
        setStatus([answer.nothingToRelease ? t("release.nothing") : t("release.done")]);
      } else if (step.kind === "clear") {
        const answer = await clearLock(report.id, {
          reason,
          ...(step.previewed ? { confirm: true as const } : {}),
        });
        if (!answer.confirmed) {
          setStep({ kind: "clear", previewed: true });
          return;
        }
        setStatus(answer.result ? clearSentences(answer.result) : []);
      } else {
        const answer = await reportAction(report.id, {
          action: step.kind as ReportActionBody["action"],
          resolution: reason,
        });
        if (step.kind === "escalate_csam" && answer.csamReportId && answer.csamReportId !== report.id) {
          close();
          void navigate(`/admin/reports/${answer.csamReportId}`);
          return;
        }
        setStatus([t(`r.done.${step.kind}`)]);
      }
      close();
      refresh();
    } catch (failure) {
      const code = reasonOf(failure);
      if (code === "not_locked" || code === "reported")
        setError(t(code === "reported" ? "clear.reported" : "clear.notLocked"));
      else if (code === "hold_not_releasable") {
        const at = (failure as { details?: { releasableAt?: unknown } }).details?.releasableAt;
        setError(typeof at === "string" ? t("release.notYet", { when: when(at) }) : t("release.never"));
      } else
        setError(
          refusalText(failure, {
            csam_locked: t("r.csamLocked"),
            folder: t("r.folder"),
            csam_report: t("r.csamReport"),
          }),
        );
    } finally {
      setBusy(false);
    }
  };

  const simple = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      setStatus([done]);
      refresh();
    } catch (failure) {
      setStatus([refusalText(failure)]);
    }
  };

  const openEvidence = async () => {
    setEvidenceError(null);
    try {
      setEvidence(await ncmecEvidence(report.id));
    } catch (failure) {
      setEvidenceError(refusalText(failure, { reauth_required: t("ncmec.reauth") }));
    }
  };

  const recordFiling = (event: FormEvent) => {
    event.preventDefault();
    const at = new Date(filedAt);
    if (!filedId.trim() || Number.isNaN(at.getTime())) return;
    void simple(
      () => ncmecFiled(report.id, { reportId: filedId.trim(), filedAt: at.toISOString() }),
      t("ncmec.filedDone"),
    );
  };

  const titles: Record<NonNullable<Step>["kind"], string> = {
    dismiss: t("r.dismiss"),
    takedown: t("r.takedown"),
    strike: t("r.strike"),
    escalate_csam: t("r.escalate"),
    release: t("release.title"),
    clear: t("clear.title"),
  };

  return (
    <>
      <Section id="report" title={t("r.title", { category: label("category", report.category) })}>
        <Facts
          rows={[
            [t("r.id"), <Mono key="id">{report.id}</Mono>],
            [t("r.status"), label("reportStatus", report.status)],
            [t("r.source"), label("source", report.source)],
            [t("r.created"), when(report.createdAt)],
            [t("r.details"), report.details ?? "—"],
            [t("r.reporter"), report.reporterEmail ?? "—"],
            [t("r.assigned"), report.assignedTo ?? "—"],
            [t("r.resolution"), report.resolution ?? "—"],
            [
              t("r.openOnNode"),
              t("r.openOnNodeValue", { count: detail.openOnNode, reporters: detail.distinctReporters }),
            ],
            [t("ncmec.started"), when(report.ncmecStartedAt)],
            [
              t("ncmec.filed"),
              report.ncmecFiledAt ? `${when(report.ncmecFiledAt)} · ${report.ncmecReportId ?? ""}` : "—",
            ],
            [t("release.date"), when(detail.releasableAt)],
          ]}
        />
      </Section>
      <Section id="file" title={t("r.file")}>
        {node ? (
          <Facts
            rows={[
              [t("q.name"), node.name],
              [t("q.kind"), node.kind],
              [t("q.type"), node.mimeSniffed ?? "—"],
              [t("q.size"), bytes(node.size)],
              [t("q.sha"), node.sha256 ? <Mono key="sha">{node.sha256}</Mono> : "—"],
              [t("q.status"), label("scan", node.scanStatus)],
              [t("q.scanReason"), node.scanReason ?? "—"],
              [t("q.legalHold"), node.legalHold ? t("common.yes") : t("common.no")],
              [
                t("r.links"),
                t("r.linksValue", {
                  count: detail.links.count,
                  downloads: detail.links.downloads,
                  bytes: bytes(detail.links.bytesServed),
                }),
              ],
            ]}
          />
        ) : (
          <Note>{t("r.nodeGone")}</Note>
        )}
        <Note>{t("q.noContent")}</Note>
      </Section>
      <Section id="uploader" title={t("r.uploader")}>
        {detail.uploader ? (
          <Facts
            rows={[
              [t("users.name"), detail.uploader.displayName],
              [t("users.created"), when(detail.uploader.createdAt)],
              [
                t("users.strikes"),
                String(detail.uploader.strikes.filter((strike) => strike.state === "active").length),
              ],
            ]}
          />
        ) : (
          <Note>{t("r.noUploader")}</Note>
        )}
      </Section>
      {detail.locked ? (
        <Section id="lock" title={t("lock.record")}>
          <Note>
            {t("lock.lockedAt", { when: when(detail.locked.at), source: detail.locked.source ?? "—" })}
          </Note>
          {detail.alerts.length === 0 ? (
            <Box role="status" data-admin-not-reached>
              {t("lock.notReached")}
            </Box>
          ) : (
            detail.alerts.map((alert) => (
              <Note key={alert.at}>
                {t("lock.alerted", { when: when(alert.at), via: alert.via ?? "—", count: alert.recipients })}
              </Note>
            ))
          )}
        </Section>
      ) : null}
      <Section id="actions" title={t("r.actions")}>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button onClick={() => void simple(() => assignReport(report.id, true), t("r.done.assign"))}>
            {t("r.assign")}
          </Button>
          <Button onClick={() => setStep({ kind: "dismiss" })}>{t("r.dismiss")}</Button>
          {isCsam ? null : (
            <>
              <Button onClick={() => setStep({ kind: "takedown" })}>{t("r.takedown")}</Button>
              <Button onClick={() => setStep({ kind: "strike" })}>{t("r.strike")}</Button>
            </>
          )}
          <Button
            color="error"
            disabled={detail.nodeIsFolder}
            onClick={() => setStep({ kind: "escalate_csam" })}
          >
            {t("r.escalate")}
          </Button>
        </Box>
        {detail.nodeIsFolder ? <Note>{t("r.folder")}</Note> : null}
        {status.map((line) => (
          <StatusLine key={line} tone="ok">
            {line}
          </StatusLine>
        ))}
      </Section>
      {isCsam ? (
        <Section id="ncmec" title={t("ncmec.title")}>
          <Note>{t("ncmec.intro")}</Note>
          {report.status === "open" ? (
            <Box>
              <Button
                variant="contained"
                onClick={() => void simple(() => ncmecStart(report.id), t("ncmec.startedDone"))}
              >
                {t("ncmec.start")}
              </Button>
            </Box>
          ) : null}
          {report.ncmecStartedAt ? (
            <Box component="ol" data-admin-checklist sx={{ margin: 0, paddingLeft: 3, fontSize: 13 }}>
              {(["1", "2", "3", "4", "5", "6", "7"] as const).map((n) => (
                <li key={n}>{t(`ncmec.check.${n}`)}</li>
              ))}
            </Box>
          ) : null}
          <Box>
            <Button onClick={() => void openEvidence()}>{t("ncmec.evidence")}</Button>
          </Box>
          {evidenceError ? <StatusLine tone="error">{evidenceError}</StatusLine> : null}
          {evidence ? <Evidence evidence={evidence} /> : null}
          {report.ncmecFiledAt ? null : (
            <Box
              component="form"
              onSubmit={recordFiling}
              sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}
            >
              <Box sx={{ width: 220 }}>
                <Field
                  label={t("ncmec.filedId")}
                  name="ncmecReportId"
                  value={filedId}
                  onChange={(event) => setFiledId(event.target.value)}
                />
              </Box>
              <Box sx={{ width: 220 }}>
                <Field
                  label={t("ncmec.filedAt")}
                  name="filedAt"
                  type="datetime-local"
                  value={filedAt}
                  onChange={(event) => setFiledAt(event.target.value)}
                />
              </Box>
              <Button type="submit">{t("ncmec.recordFiling")}</Button>
            </Box>
          )}
          {report.ncmecFiledAt ? <Note>{t("ncmec.horizon")}</Note> : null}
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button onClick={() => setStep({ kind: "release", preview: null })}>{t("release.title")}</Button>
            {locked ? (
              <Button onClick={() => setStep({ kind: "clear", previewed: false })}>{t("clear.title")}</Button>
            ) : null}
          </Box>
          {locked ? <Note>{t("clear.q22")}</Note> : null}
        </Section>
      ) : null}
      <ReasonDialog
        open={step !== null}
        title={step ? titles[step.kind] : ""}
        body={
          step?.kind === "clear"
            ? t("clear.body")
            : step?.kind === "release"
              ? t("release.body")
              : step?.kind === "escalate_csam"
                ? t("r.escalateBody")
                : undefined
        }
        confirmLabel={
          (step?.kind === "release" && !step.preview) || (step?.kind === "clear" && !step.previewed)
            ? t("common.preview")
            : step
              ? titles[step.kind]
              : ""
        }
        destructive={step?.kind === "escalate_csam"}
        busy={busy}
        error={error}
        onSubmit={(reason) => void act(reason)}
        onCancel={close}
      >
        {step?.kind === "release" && step.preview ? <ReleasePreview preview={step.preview} /> : null}
        {step?.kind === "clear" && step.previewed ? <Note>{t("clear.previewed")}</Note> : null}
      </ReasonDialog>
      <Box>
        <Button component={RouterLink} to="/admin/reports">
          {t("common.back")}
        </Button>
      </Box>
    </>
  );
}

function ReleasePreview({ preview }: { preview: ReleaseHoldsResponse }) {
  return (
    <Box data-admin-release-preview sx={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 1 }}>
      <span>
        {preview.node.released
          ? t("release.node")
          : t("release.nodeKept", {
              why: preview.node.keptBecause ? label("keptBecause", preview.node.keptBecause) : "—",
            })}
      </span>
      <span>{t("release.users", { ids: preview.releasedUserIds.join(", ") || "—" })}</span>
      {preview.kept.map((entry) => (
        <span key={entry.userId}>
          {t("release.kept", { id: entry.userId, why: label("keptBecause", entry.because) })}
        </span>
      ))}
      {preview.nothingToRelease ? <span>{t("release.nothing")}</span> : null}
    </Box>
  );
}

/** The evidence, on screen only: never stored, never copied into anything else by this page. */
function Evidence({ evidence }: { evidence: NcmecEvidenceResponse }) {
  return (
    <Box data-admin-evidence sx={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
      <Facts
        rows={[
          [t("q.name"), evidence.node.name],
          [t("q.type"), evidence.node.mimeSniffed ?? "—"],
          [t("q.size"), bytes(evidence.node.size)],
          [t("q.sha"), evidence.node.sha256 ?? "—"],
          [t("ncmec.uploadedAt"), when(evidence.node.uploadedAt)],
          [
            t("ncmec.versions"),
            evidence.node.versions
              .map((v) => `${v.versionId} (${when(v.at)})${v.current ? " *" : ""}`)
              .join(", "),
          ],
          [
            t("r.links"),
            t("r.linksValue", {
              count: evidence.links.count,
              downloads: evidence.links.downloads,
              bytes: bytes(evidence.links.bytesServed),
            }),
          ],
          [t("ncmec.public"), evidence.links.everPublic ? t("common.yes") : t("common.no")],
        ]}
      />
      {evidence.currentVersionUploader === "deleted" ? <Note>{t("ncmec.uploaderDeleted")}</Note> : null}
      {evidence.subjects.map((subject) => (
        <Box key={subject.userId} data-admin-subject={subject.userId}>
          <Facts
            rows={[
              [t("ncmec.subject"), `${subject.account.name} <${subject.account.email}>`],
              [
                t("ncmec.role"),
                [
                  subject.isOwner ? t("ncmec.owner") : null,
                  subject.isCurrentVersionUploader ? t("ncmec.currentUploader") : null,
                ]
                  .filter(Boolean)
                  .join(", ") || t("ncmec.uploader"),
              ],
              [t("ncmec.held"), subject.held ? t("common.yes") : t("common.no")],
              [t("users.created"), when(subject.account.createdAt)],
              [t("ncmec.countries"), subject.account.signInCountries.join(", ") || "—"],
              [
                t("ncmec.addresses"),
                subject.addresses
                  .map((a) => `${a.ip ?? t("ncmec.undecryptable")} (${a.versionId}, ${when(a.at)})`)
                  .join("; ") || "—",
              ],
            ]}
          />
        </Box>
      ))}
      {evidence.orphanAddresses.length ? (
        <Facts
          rows={[
            [
              t("ncmec.orphans"),
              evidence.orphanAddresses
                .map((a) => `${a.ip ?? t("ncmec.undecryptable")} (${a.uploaderId})`)
                .join("; "),
            ],
          ]}
        />
      ) : null}
    </Box>
  );
}
