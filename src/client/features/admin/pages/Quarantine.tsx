// Section 4: the quarantine queue. Metadata only — the console never mints or requests a content
// URL, and shows no thumbnail or preview. Actions: rescan, mark false positive (release), confirm
// delete (asks the rollback detector and the pause switch first; a held node is refused with the
// cause shown). Any file or folder can be opened here by id (R1 ruling Q9) and taken down,
// restored (a takedown that is not a copyright notice's) or put on legal hold.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import type { AdminQuarantineDetailDto, QuarantineActionBody } from "../../../../shared/schemas/admin";
import {
  adminKeys,
  fetchQuarantine,
  fetchQuarantineItem,
  liftStrike,
  quarantineAction,
  queryString,
  setNodeLegalHold,
} from "../api";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Facts, Field, Loading, Mono, ReasonDialog, Section, StatusLine } from "../ui";
import { bytes, label, nodeIdOf, reasonOf, refusalText, rescanText, when } from "../words";

function FindItem() {
  const navigate = useNavigate();
  const [reference, setReference] = useState("");
  const [invalid, setInvalid] = useState(false);
  const open = () => {
    const id = nodeIdOf(reference);
    setInvalid(id === null);
    if (id) void navigate(`/admin/quarantine/${id}`);
  };
  return (
    <Box
      component="form"
      sx={{ display: "flex", gap: 1, alignItems: "flex-start", flexWrap: "wrap" }}
      onSubmit={(event) => {
        event.preventDefault();
        open();
      }}
    >
      <Box sx={{ flex: "1 1 280px", maxWidth: 520 }}>
        <Field
          label={t("q.findLabel")}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          error={invalid ? t("q.findInvalid") : null}
        />
      </Box>
      <Button type="submit">{t("q.findOpen")}</Button>
    </Box>
  );
}

export function QuarantinePage() {
  const [status, setStatus] = useState("");
  const search = queryString({ status });
  const query = useAdminQuery(adminKeys.quarantine(search), (signal) => fetchQuarantine(search, signal));
  const navigate = useNavigate();
  const columns: GridColDef[] = [
    { field: "name", headerName: t("q.name"), flex: 2 },
    { field: "status", headerName: t("q.status"), flex: 1 },
    { field: "takedown", headerName: t("q.takedown"), flex: 1 },
    { field: "size", headerName: t("q.size"), width: 110 },
    { field: "scannedAt", headerName: t("q.scannedAt"), flex: 1 },
  ];
  return (
    <Section
      id="quarantine"
      title={t("nav.quarantine")}
      action={<Button onClick={() => void query.refetch()}>{t("common.refresh")}</Button>}
    >
      <Section id="find" title={t("q.find")}>
        <FindItem />
      </Section>
      <Box sx={{ width: 220 }}>
        <Field
          select
          label={t("q.filter")}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <MenuItem value="">{t("common.any")}</MenuItem>
          {["infected", "suspected_csam", "under_review", "error", "skipped", "taken_down"].map((value) => (
            <MenuItem key={value} value={value}>
              {label("scan", value)}
            </MenuItem>
          ))}
        </Field>
      </Box>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <AdminDataGrid
          rows={query.data.items.map((item) => ({
            id: item.node.id,
            name: item.node.name,
            status: label("scan", item.node.scanStatus),
            takedown: item.node.takedown ? label("takedown", item.node.takedown.reason) : "—",
            size: bytes(item.node.size),
            scannedAt: when(item.scannedAt),
          }))}
          columns={columns}
          onRowClick={(params) => void navigate(`/admin/quarantine/${String(params.id)}`)}
        />
      )}
    </Section>
  );
}

export function QuarantineDetailPage() {
  const { nodeId = "" } = useParams();
  const query = useAdminQuery(adminKeys.quarantineItem(nodeId), (signal) =>
    fetchQuarantineItem(nodeId, signal),
  );
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <QuarantineDetail detail={query.data} />;
}

type Pending = QuarantineActionBody["action"] | "lift" | "liftReport" | "takedownCsam" | "hold" | "unhold";

function QuarantineDetail({ detail }: { detail: AdminQuarantineDetailDto }) {
  const node = detail.item.node;
  const client = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [strikeId, setStrikeId] = useState<string | null>(null);
  const [reportStrikes, setReportStrikes] = useState<string[]>([]);
  const held = detail.holds.includes("node_legal_hold");

  const act = async (reason: string) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending === "lift") {
        if (strikeId) await liftStrike(strikeId, reason);
        setStatus(t("q.strikeLifted"));
        setStrikeId(null);
      } else if (pending === "liftReport") {
        const [next, ...rest] = reportStrikes;
        if (next) await liftStrike(next, reason);
        setStatus(t("q.strikeLifted"));
        setReportStrikes(rest);
      } else if (pending === "hold" || pending === "unhold") {
        await setNodeLegalHold(node.id, { held: pending === "hold", note: reason });
        setStatus(pending === "hold" ? t("q.done.holdSet") : t("q.done.holdCleared"));
      } else if (pending === "takedown" || pending === "takedownCsam") {
        await quarantineAction(node.id, {
          action: "takedown",
          note: reason,
          ...(pending === "takedownCsam" ? { csam: true } : {}),
        });
        setStatus(t("q.takenDown"));
      } else if (pending === "restore") {
        const result = await quarantineAction(node.id, { action: "restore", note: reason });
        const strikes = result.reportStrikeIds ?? [];
        setReportStrikes(strikes);
        setStatus(
          [
            result.blocklistRemoved ? t("q.restored.removed") : t("q.restored"),
            strikes.length > 0 ? t("q.reportStrikes", { count: strikes.length }) : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      } else {
        const result = await quarantineAction(node.id, { action: pending, note: reason });
        if (pending === "rescan" && result.rescan)
          setStatus(rescanText(result.rescan, node.scanStatus === "under_review"));
        if (pending === "release") {
          setStatus(result.blocklistRemoved ? t("q.released.removed") : t("q.released"));
          setStrikeId(result.malwareStrikeId ?? null);
        }
        if (pending === "delete") setStatus(t("q.deleted"));
      }
      void client.invalidateQueries({ queryKey: adminKeys.quarantineItem(node.id) });
      setPending(null);
    } catch (failure) {
      if (reasonOf(failure) === "held" && pending === "restore") {
        setError(t("q.restoreHeld"));
      } else if ((failure as { code?: string }).code === "not_quarantined" && pending === "delete") {
        setError(t("q.deleteRefused"));
      } else if (reasonOf(failure) === "held") {
        const holds = ((failure as { details?: { holds?: unknown } }).details?.holds ?? []) as string[];
        setError(t("q.held", { causes: holds.map((cause) => label("hold", cause)).join(", ") || "—" }));
      } else {
        setError(
          refusalText(failure, {
            destroy_paused: t("q.destroyPaused"),
            not_infected: t("q.releaseRefused"),
            use_lock: t("q.useLock"),
            content_listed: t("q.contentListed"),
            hold_not_releasable: t("q.holdNotReleasable"),
          }) || t("common.failed"),
        );
        if ((failure as { status?: number }).status === 409 && pending === "release")
          setError(t("q.releaseRefused"));
      }
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Pending, string> = {
    rescan: t("q.rescan"),
    release: t("q.release"),
    delete: t("q.delete"),
    lift: t("q.liftStrike"),
    liftReport: t("q.liftReportStrike"),
    takedown: t("q.takedownAct"),
    takedownCsam: t("q.takedownCsam"),
    restore: t("q.restoreAct"),
    hold: t("q.holdSet"),
    unhold: t("q.holdClear"),
  };
  const bodies: Partial<Record<Pending, string>> = {
    delete: t("q.deleteBody"),
    release: t("q.releaseBody"),
    takedown: t("q.takedownBody"),
    takedownCsam: t("q.takedownCsamBody"),
    restore: t("q.restoreBody"),
    hold: t("q.holdBody"),
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-quarantine-item={node.id}>
      <Section id="node" title={node.name}>
        <Facts
          rows={[
            [t("q.id"), <Mono key="id">{node.id}</Mono>],
            [t("q.kind"), node.kind],
            [t("q.status"), label("scan", node.scanStatus)],
            [t("q.scanReason"), detail.scanReason ?? "—"],
            [t("q.signatures"), detail.item.signatures.join(", ") || "—"],
            [
              t("q.takedown"),
              node.takedown ? `${label("takedown", node.takedown.reason)} · ${when(node.takedown.at)}` : "—",
            ],
            [t("q.owner"), detail.owner.displayName],
            [t("q.uploader"), detail.item.uploader?.displayName ?? "—"],
            [t("q.size"), bytes(node.size)],
            [t("q.type"), node.mimeSniffed ?? "—"],
            [t("q.sha"), detail.sha256 ? <Mono key="sha">{detail.sha256}</Mono> : "—"],
            [t("q.holds"), detail.holds.map((cause) => label("hold", cause)).join(", ") || "—"],
            [t("q.links"), String(detail.links.length)],
            [t("q.scannedAt"), when(detail.item.scannedAt)],
          ]}
        />
        <Note2 />
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button onClick={() => setPending("rescan")}>{t("q.rescan")}</Button>
          <Button onClick={() => setPending("release")}>{t("q.release")}</Button>
          <Button color="error" onClick={() => setPending("delete")}>
            {t("q.delete")}
          </Button>
          {strikeId ? <Button onClick={() => setPending("lift")}>{t("q.liftStrike")}</Button> : null}
        </Box>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          {node.takedown ? (
            <Button onClick={() => setPending("restore")}>{t("q.restoreAct")}</Button>
          ) : (
            <>
              <Button color="error" onClick={() => setPending("takedown")}>
                {t("q.takedownAct")}
              </Button>
              {node.kind === "folder" ? (
                <Button color="error" onClick={() => setPending("takedownCsam")}>
                  {t("q.takedownCsam")}
                </Button>
              ) : null}
            </>
          )}
          <Button onClick={() => setPending(held ? "unhold" : "hold")}>
            {held ? t("q.holdClear") : t("q.holdSet")}
          </Button>
          {reportStrikes.length > 0 ? (
            <Button onClick={() => setPending("liftReport")}>{t("q.liftReportStrike")}</Button>
          ) : null}
        </Box>
        <StatusLine tone="ok">{status}</StatusLine>
      </Section>
      <ReasonDialog
        open={pending !== null}
        title={pending ? titles[pending] : ""}
        body={pending ? bodies[pending] : undefined}
        confirmLabel={pending ? titles[pending] : ""}
        destructive={pending === "delete" || pending === "takedown" || pending === "takedownCsam"}
        busy={busy}
        error={error}
        onSubmit={(reason) => void act(reason)}
        onCancel={() => {
          setPending(null);
          setError(null);
        }}
      />
      <Box>
        <Button component={RouterLink} to="/admin/quarantine">
          {t("common.back")}
        </Button>
      </Box>
    </Box>
  );
}

function Note2() {
  return <Box sx={{ fontSize: 13 }}>{t("q.noContent")}</Box>;
}
