// Section 9: invites — create, list, revoke, and a CSV of the codes.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { adminKeys, createInvites, fetchInvites, invitesExportHref, revokeInvite } from "../api";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Field, Loading, Section, StatusLine } from "../ui";
import { refusalText, when } from "../words";

export function InvitesPage() {
  const query = useAdminQuery(adminKeys.invites, fetchInvites);
  const client = useQueryClient();
  const [count, setCount] = useState("1");
  const [uses, setUses] = useState("1");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const at = expires ? new Date(expires) : null;
      const made = await createInvites({
        count: Number(count),
        maxUses: Number(uses),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(at && !Number.isNaN(at.getTime()) ? { expiresAt: at.toISOString() } : {}),
      });
      setStatus({ tone: "ok", text: t("invites.created", { count: made.invites.length }) });
      void client.invalidateQueries({ queryKey: adminKeys.invites });
    } catch (failure) {
      setStatus({ tone: "error", text: refusalText(failure) });
    }
  };
  const revoke = async (code: string) => {
    try {
      await revokeInvite(code);
      void client.invalidateQueries({ queryKey: adminKeys.invites });
    } catch (failure) {
      setStatus({ tone: "error", text: refusalText(failure) });
    }
  };
  const columns: GridColDef[] = [
    { field: "code", headerName: t("invites.code"), flex: 2 },
    { field: "uses", headerName: t("invites.uses"), width: 100 },
    { field: "expiresAt", headerName: t("invites.expires"), flex: 1 },
    { field: "state", headerName: t("invites.state"), flex: 1 },
    { field: "note", headerName: t("invites.note"), flex: 1 },
    {
      field: "revoke",
      headerName: "",
      width: 110,
      renderCell: (params) =>
        params.row.revoked ? null : (
          <Button size="small" onClick={() => void revoke(String(params.row.code))}>
            {t("invites.revoke")}
          </Button>
        ),
    },
  ];
  return (
    <Section
      id="invites"
      title={t("nav.invites")}
      action={
        <Button component="a" href={invitesExportHref} download>
          {t("common.csv")}
        </Button>
      }
    >
      <Box
        component="form"
        onSubmit={create}
        sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}
      >
        <Box sx={{ width: 100 }}>
          <Field
            label={t("invites.count")}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </Box>
        <Box sx={{ width: 100 }}>
          <Field
            label={t("invites.maxUses")}
            value={uses}
            onChange={(event) => setUses(event.target.value)}
          />
        </Box>
        <Box sx={{ width: 220 }}>
          <Field
            label={t("invites.expires")}
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
        </Box>
        <Box sx={{ flex: "1 1 200px" }}>
          <Field label={t("invites.note")} value={note} onChange={(event) => setNote(event.target.value)} />
        </Box>
        <Button type="submit" variant="contained">
          {t("invites.create")}
        </Button>
      </Box>
      {status ? <StatusLine tone={status.tone}>{status.text}</StatusLine> : null}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <AdminDataGrid
          getRowId={(row) => String(row.code)}
          rows={query.data.items.map((invite) => ({
            code: invite.code,
            uses: `${invite.uses} / ${invite.maxUses}`,
            expiresAt: when(invite.expiresAt),
            state: invite.revokedAt ? t("invites.revoked") : t("invites.active"),
            revoked: invite.revokedAt !== null,
            note: invite.note ?? "",
          }))}
          columns={columns}
        />
      )}
    </Section>
  );
}
