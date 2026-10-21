// Section 10: the audit log. Filters by actor, action, target and date; a CSV export (streamed by
// the Worker). An actor id with no account any more reads "deleted account" — the row is shown,
// never dropped; a null actor is "system".
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useState, type FormEvent } from "react";
import { adminKeys, auditExportHref, fetchAudit, queryString } from "../api";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Field, Loading, Section } from "../ui";
import { actorName, when } from "../words";

const toIso = (value: string) => {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined;
};

export function AuditPage() {
  const [form, setForm] = useState({
    actorUserId: "",
    action: "",
    targetType: "",
    targetId: "",
    from: "",
    to: "",
  });
  const [search, setSearch] = useState("");
  const query = useAdminQuery(adminKeys.audit(search), (signal) => fetchAudit(search, signal));
  const set = (name: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [name]: event.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(queryString({ ...form, from: toIso(form.from), to: toIso(form.to) }));
  };
  const columns: GridColDef[] = [
    { field: "at", headerName: t("audit.at"), flex: 1 },
    { field: "actor", headerName: t("audit.actor"), flex: 1 },
    { field: "action", headerName: t("audit.action"), flex: 1 },
    { field: "target", headerName: t("audit.target"), flex: 2 },
    { field: "meta", headerName: t("audit.meta"), flex: 2 },
  ];
  return (
    <Section
      id="audit"
      title={t("nav.audit")}
      action={
        <Button component="a" href={auditExportHref(search)} download>
          {t("common.csv")}
        </Button>
      }
    >
      <Box component="form" onSubmit={submit} sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        {(["actorUserId", "action", "targetType", "targetId"] as const).map((name) => (
          <Box key={name} sx={{ width: 200 }}>
            <Field label={t(`audit.filter.${name}`)} value={form[name]} onChange={set(name)} />
          </Box>
        ))}
        <Box sx={{ width: 220 }}>
          <Field
            label={t("audit.filter.from")}
            type="datetime-local"
            value={form.from}
            onChange={set("from")}
          />
        </Box>
        <Box sx={{ width: 220 }}>
          <Field label={t("audit.filter.to")} type="datetime-local" value={form.to} onChange={set("to")} />
        </Box>
        <Button type="submit">{t("common.search")}</Button>
      </Box>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <AdminDataGrid
          rows={query.data.items.map((entry) => ({
            id: entry.id,
            at: when(entry.at),
            actor: actorName(entry, query.data.actors),
            action: entry.action,
            target: entry.targetType ? `${entry.targetType} ${entry.targetId ?? ""}` : "—",
            meta: entry.meta ? JSON.stringify(entry.meta) : "",
          }))}
          columns={columns}
        />
      )}
    </Section>
  );
}
