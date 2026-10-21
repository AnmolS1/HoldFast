// Section 4: the quarantine queue. Metadata only — the console never mints or requests a content
// URL, and shows no thumbnail or preview. Actions: rescan, mark false positive (release), confirm
// delete (asks the rollback detector and the pause switch first; a held node is refused with the
// cause shown).
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
} from "../api";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Facts, Field, Loading, Mono, ReasonDialog, Section, StatusLine } from "../ui";
import { bytes, label, reasonOf, refusalText, rescanText, when } from "../words";

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

function QuarantineDetail({ detail }: { detail: AdminQuarantineDetailDto }) {
  const node = detail.item.node;
  const client = useQueryClient();
  const [pending, setPending] = useState<QuarantineActionBody["action"] | "lift" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [strikeId, setStrikeId] = useState<string | null>(null);

  const act = async (reason: string) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      if (pending === "lift") {
        if (strikeId) await liftStrike(strikeId, reason);
        setStatus(t("q.strikeLifted"));
        setStrikeId(null);
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
      if (reasonOf(failure) === "held") {
        const holds = ((failure as { details?: { holds?: unknown } }).details?.holds ?? []) as string[];
        setError(t("q.held", { causes: holds.map((cause) => label("hold", cause)).join(", ") || "—" }));
      } else {
        setError(
          refusalText(failure, {
            destroy_paused: t("q.destroyPaused"),
            not_infected: t("q.releaseRefused"),
          }) || t("common.failed"),
        );
        if ((failure as { status?: number }).status === 409 && pending === "release")
          setError(t("q.releaseRefused"));
      }
    } finally {
      setBusy(false);
    }
  };

  const titles = {
    rescan: t("q.rescan"),
    release: t("q.release"),
    delete: t("q.delete"),
    lift: t("q.liftStrike"),
  } as const;

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
        <StatusLine tone="ok">{status}</StatusLine>
      </Section>
      <ReasonDialog
        open={pending !== null}
        title={pending ? titles[pending] : ""}
        body={
          pending === "delete" ? t("q.deleteBody") : pending === "release" ? t("q.releaseBody") : undefined
        }
        confirmLabel={pending ? titles[pending] : ""}
        destructive={pending === "delete"}
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
