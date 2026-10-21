// Section 1: the dashboard. Postgres counts, and the Analytics Engine tiles — "Unavailable" until
// T27's metrics queries exist (`loadAnalyticsTiles` answers `{ available: false }`).
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import type { AdminDashboardDto } from "../../../../shared/schemas/admin";
import { hf, layout } from "../../../theme/tokens";
import { adminKeys, fetchDashboard } from "../api";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Loading, Section } from "../ui";
import { bytes, label, when } from "../words";

function Tile({ name, value, note }: { name: string; value: string; note?: string }) {
  return (
    <Box
      data-admin-tile={name}
      sx={{
        border: `1px solid ${hf.hairline}`,
        borderRadius: `${layout.radius.card}px`,
        padding: 2,
        minWidth: 160,
      }}
    >
      <Box sx={{ color: hf.textSecondary, fontSize: 12 }}>{name}</Box>
      <Box className="mono" sx={{ fontSize: 18, fontWeight: 600 }}>
        {value}
      </Box>
      {note ? <Box sx={{ color: hf.textSecondary, fontSize: 12 }}>{note}</Box> : null}
    </Box>
  );
}

function Analytics({ tiles }: { tiles: AdminDashboardDto["analytics"] }) {
  if (!tiles.available) {
    return (
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }} data-admin-analytics="unavailable">
        <Tile name={t("dash.requests")} value={t("dash.unavailable")} />
        <Tile name={t("dash.errors")} value={t("dash.unavailable")} />
        <Tile name={t("dash.latency")} value={t("dash.unavailable")} />
      </Box>
    );
  }
  return (
    <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }} data-admin-analytics="available">
      <Tile name={t("dash.requests")} value={String(tiles.requestsPerMinute)} />
      <Tile name={t("dash.errors")} value={`${(tiles.errorRate * 100).toFixed(2)} %`} />
      <Tile name={t("dash.latency")} value={`${tiles.p95LatencyMs} ms`} />
    </Box>
  );
}

export function Dashboard() {
  const query = useAdminQuery(adminKeys.dashboard, fetchDashboard);
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data;
  const paused = Object.entries(d.linksPaused);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-dashboard>
      <Section
        id="dashboard"
        title={t("dash.title")}
        action={<Button onClick={() => void query.refetch()}>{t("common.refresh")}</Button>}
      >
        {d.pauseSwitch !== "off" ? (
          <Box role="status" data-admin-paused>
            {t("dash.paused")}
          </Box>
        ) : null}
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          <Tile
            name={t("dash.users")}
            value={String(d.users.total)}
            note={t("dash.new7d", { count: d.users.new7d })}
          />
          <Tile name={t("dash.storage")} value={bytes(d.storageBytes)} />
          <Tile name={t("dash.uploads")} value={String(d.uploads24h)} />
          <Tile
            name={t("dash.downloads")}
            value={String(d.downloads24h.count)}
            note={bytes(d.downloads24h.bytes)}
          />
          <Tile
            name={t("dash.backlog")}
            value={String(d.scanBacklog.running)}
            note={d.scanBacklog.oldestStartedAt ? when(d.scanBacklog.oldestStartedAt) : undefined}
          />
          <Tile name={t("dash.errorNodes")} value={String(d.nodesInError)} />
          <Tile
            name={t("dash.reports")}
            value={String(d.reports.open)}
            note={
              d.reports.oldestOpenAt ? t("dash.oldest", { when: when(d.reports.oldestOpenAt) }) : undefined
            }
          />
          <Tile name={t("dash.strikes")} value={String(d.strikes7d)} />
        </Box>
        <Box sx={{ fontSize: 13 }}>
          {t("dash.scans")}{" "}
          {Object.entries(d.scans24h)
            .map(([status, count]) => `${label("scan", status)} ${count}`)
            .join(" · ") || "—"}
        </Box>
        <Box sx={{ fontSize: 13 }}>
          {t("dash.linksPaused")}{" "}
          {paused.length
            ? paused.map(([reason, count]) => `${label("pause", reason)} ${count}`).join(" · ")
            : "—"}
        </Box>
      </Section>
      <Section id="analytics" title={t("dash.analytics")}>
        <Analytics tiles={d.analytics} />
      </Section>
    </Box>
  );
}
