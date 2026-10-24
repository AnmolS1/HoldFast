// Section 2: users. Search by address, name or id; the detail with the account's state, its usage
// as the OPERATOR sees it (the stored counter, and what was deleted for good but is kept), its
// public-link egress today, strikes, and every action. Ban, unban, set role and impersonate go to
// Better Auth's admin plugin (the allow-listed paths, ./auth-calls.ts); the rest to routes/admin.ts.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import type { AdminStrikeDto, AdminUserDetailDto, StrikeKind } from "../../../../shared/schemas/admin";
import { refreshSession } from "../../../lib/query";
import {
  addStrike,
  adminKeys,
  cancelDeletion,
  fetchUser,
  fetchUsers,
  liftStrike,
  queryString,
  revokeLinks,
  revokeSessions,
  scheduleDeletion,
  setLegalHold,
  setQuota,
  suspendUser,
  unsuspendUser,
} from "../api";
import { banUser, impersonateUser, setRole, unbanUser, type AuthOutcome } from "../auth-calls";
import { AdminDataGrid, type GridColDef } from "../components/AdminDataGrid";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Facts, Field, Loading, Mono, ReasonDialog, Section, StatusLine } from "../ui";
import { bytes, egressText, label, reasonOf, refusalText, strikeStateText, when } from "../words";

export function UsersPage() {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");
  const query = useAdminQuery(adminKeys.users(search), (signal) => fetchUsers(search, signal));
  const navigate = useNavigate();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(queryString({ q: q.trim(), state }));
  };
  const columns: GridColDef[] = [
    { field: "email", headerName: t("users.email"), flex: 2 },
    { field: "displayName", headerName: t("users.name"), flex: 1 },
    { field: "status", headerName: t("users.state"), flex: 1 },
    { field: "used", headerName: t("users.used"), flex: 1 },
    { field: "strikes", headerName: t("users.strikes"), width: 90 },
  ];
  return (
    <Section id="users" title={t("nav.users")}>
      <Box component="form" onSubmit={submit} sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        <Box sx={{ flex: "1 1 260px" }}>
          <Field
            label={t("users.search")}
            name="q"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </Box>
        <Box sx={{ width: 180 }}>
          <Field
            select
            label={t("users.state")}
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <MenuItem value="">{t("common.any")}</MenuItem>
            {["active", "suspended", "banned", "deletion", "held"].map((value) => (
              <MenuItem key={value} value={value}>
                {label("userState", value)}
              </MenuItem>
            ))}
          </Field>
        </Box>
        <Button type="submit" variant="contained">
          {t("common.search")}
        </Button>
      </Box>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <AdminDataGrid
          rows={query.data.items.map((account) => ({
            id: account.id,
            email: account.email,
            displayName: account.displayName,
            status: userStatus(account),
            used: bytes(account.usedBytes),
            strikes: account.activeStrikes,
          }))}
          columns={columns}
          onRowClick={(params) => void navigate(`/admin/users/${String(params.id)}`)}
        />
      )}
    </Section>
  );
}

function userStatus(user: AdminUserDetailDto["user"]): string {
  const parts: string[] = [];
  if (user.banned) parts.push(t("userState.banned"));
  if (user.suspendedAt) parts.push(t("userState.suspended"));
  if (user.deleteScheduledAt) parts.push(t("userState.deletion"));
  if (user.legalHold) parts.push(t("userState.held"));
  return parts.length ? parts.join(", ") : t("userState.active");
}

type Pending =
  | {
      kind:
        | "suspend"
        | "unsuspend"
        | "ban"
        | "unban"
        | "revokeSessions"
        | "revokeLinks"
        | "delete"
        | "cancelDelete"
        | "hold"
        | "impersonate";
    }
  | { kind: "lift"; strike: AdminStrikeDto }
  | { kind: "role"; role: "user" | "admin" }
  | null;

export function UserDetailPage() {
  const { userId = "" } = useParams();
  const query = useAdminQuery(adminKeys.user(userId), (signal) => fetchUser(userId, signal));
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <UserDetail detail={query.data} />;
}

function UserDetail({ detail }: { detail: AdminUserDetailDto }) {
  const user = detail.user;
  const client = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [quotaGb, setQuotaGb] = useState(String(user.quotaBytes / 1e9));
  const [strikeKind, setStrikeKind] = useState<StrikeKind>("abuse");
  const [strikeNode, setStrikeNode] = useState("");
  const [banDays, setBanDays] = useState("");

  const refresh = (next?: AdminUserDetailDto) => {
    if (next) client.setQueryData(adminKeys.user(user.id), next);
    else void client.invalidateQueries({ queryKey: adminKeys.user(user.id) });
  };
  const close = () => {
    setPending(null);
    setError(null);
  };

  /** A Better Auth plugin call, as the account screens word its failure. */
  const plugin = async (run: () => Promise<AuthOutcome<unknown>>, done: string) => {
    const result = await run();
    if (result.error) throw new Error(result.error.message ?? t("common.failed"));
    setStatus(done);
    refresh();
  };

  const act = async (reason: string) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      switch (pending.kind) {
        case "suspend":
          refresh(await suspendUser(user.id, reason));
          setStatus(t("users.done.suspended"));
          break;
        case "unsuspend":
          refresh(await unsuspendUser(user.id, reason));
          setStatus(t("users.done.unsuspended"));
          break;
        case "ban": {
          const days = Number(banDays);
          await plugin(
            () => banUser(user.id, reason, days > 0 ? days * 86_400 : undefined),
            t("users.done.banned"),
          );
          break;
        }
        case "unban":
          await plugin(() => unbanUser(user.id), t("users.done.unbanned"));
          break;
        case "role":
          await plugin(() => setRole(user.id, pending.role), t("users.done.role"));
          break;
        case "revokeSessions": {
          const { revoked } = await revokeSessions(user.id, reason);
          setStatus(t("users.done.sessions", { count: revoked }));
          refresh();
          break;
        }
        case "revokeLinks": {
          const { revoked } = await revokeLinks(user.id, reason);
          setStatus(t("users.done.links", { count: revoked }));
          refresh();
          break;
        }
        case "delete":
          await scheduleDeletion(user.id, reason);
          setStatus(t("users.done.deletion"));
          refresh();
          break;
        case "cancelDelete":
          await cancelDeletion(user.id, reason);
          setStatus(t("users.done.deletionCancelled"));
          refresh();
          break;
        case "hold":
          refresh(await setLegalHold(user.id, { held: !user.legalHold, note: reason }));
          setStatus(user.legalHold ? t("users.done.holdCleared") : t("users.done.holdSet"));
          break;
        case "lift": {
          const { activeStrikes } = await liftStrike(pending.strike.id, reason);
          setStatus(t("users.done.lifted", { count: activeStrikes }));
          refresh();
          break;
        }
        case "impersonate": {
          const result = await impersonateUser(user.id);
          if (result.error) throw new Error(result.error.message ?? t("common.failed"));
          // The browser is now signed in as the account: the shell adopts it from the session.
          await refreshSession();
          void navigate("/");
          break;
        }
      }
      close();
    } catch (failure) {
      const reasonCode = reasonOf(failure);
      if (reasonCode === "strikes_at_threshold") {
        const count = Number(
          (failure as { details?: { activeStrikes?: unknown } }).details?.activeStrikes ?? 0,
        );
        setError(t("users.strikesAtThreshold", { count }));
      } else {
        setError(
          failure instanceof Error && !("code" in failure)
            ? failure.message
            : refusalText(failure, { hold_not_releasable: t("users.holdNotReleasable") }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const saveQuota = async (event: FormEvent) => {
    event.preventDefault();
    // Read as typed: an empty field is NOT 0 (func-5) — `Number("")` is — and a decimal comma
    // is a decimal point.
    const typed = quotaGb.trim().replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(typed)) {
      setStatus(t("users.quotaInvalid"));
      return;
    }
    const value = Math.round(Number(typed) * 1e9);
    try {
      refresh(await setQuota(user.id, value));
      setStatus(t("users.done.quota"));
    } catch (failure) {
      setStatus(refusalText(failure));
    }
  };

  const strike = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await addStrike(user.id, {
        userId: user.id,
        kind: strikeKind,
        ...(strikeNode.trim() ? { nodeId: strikeNode.trim() } : {}),
      });
      setStatus(result.created ? t("users.done.struck") : t("users.alreadyStruck"));
      refresh();
    } catch (failure) {
      setStatus(refusalText(failure));
    }
  };

  const titles: Record<NonNullable<Pending>["kind"], string> = {
    suspend: t("users.suspend"),
    unsuspend: t("users.unsuspend"),
    ban: t("users.ban"),
    unban: t("users.unban"),
    revokeSessions: t("users.revokeSessions"),
    revokeLinks: t("users.revokeLinks"),
    delete: t("users.delete"),
    cancelDelete: t("users.cancelDelete"),
    hold: user.legalHold ? t("users.holdClear") : t("users.holdSet"),
    lift: t("users.lift"),
    role: t("users.setRole"),
    impersonate: t("users.impersonate"),
  };
  const bodies: Partial<Record<NonNullable<Pending>["kind"], string>> = {
    revokeLinks: t("users.revokeLinksBody", { count: detail.links.live + detail.links.paused }),
    delete: t("users.deleteBody"),
    impersonate: t("users.impersonateBody"),
    hold: t("users.holdBody"),
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }} data-admin-user={user.id}>
      <Section id="user" title={user.displayName || user.email}>
        <Facts
          rows={[
            [t("users.email"), user.email],
            [t("users.id"), <Mono key="id">{user.id}</Mono>],
            [t("users.role"), user.role],
            [t("users.twoFactor"), user.twoFactorEnabled ? t("common.yes") : t("common.no")],
            [t("users.created"), when(user.createdAt)],
            [t("users.lastActive"), when(user.lastActiveAt)],
            [t("users.state"), userStatus(user)],
            [t("users.banReason"), user.banReason ?? "—"],
            [t("users.suspendedReason"), user.suspendedReason ?? "—"],
            [t("users.deletion"), when(user.deleteScheduledAt)],
            [
              t("users.legalHold"),
              user.legalHold
                ? detail.legalHoldByHand
                  ? t("users.heldByHand")
                  : t("common.yes")
                : t("common.no"),
            ],
            [t("users.sessions"), String(detail.sessions)],
            [
              t("users.links"),
              t("users.linksCount", { live: detail.links.live, paused: detail.links.paused }),
            ],
            [t("users.shares"), String(detail.shares)],
          ]}
        />
        <StatusLine tone="ok">{status}</StatusLine>
      </Section>
      <Section id="usage" title={t("users.usage")}>
        <Facts
          rows={[
            [t("users.usedStored"), bytes(detail.usage.usedBytes)],
            [t("users.quota"), bytes(user.quotaBytes)],
            [t("users.files"), bytes(detail.usage.filesBytes)],
            [t("users.trash"), bytes(detail.usage.trashBytes)],
            [t("users.versions"), bytes(detail.usage.versionsBytes)],
            [t("users.reserved"), bytes(detail.usage.reservedBytes)],
            [t("users.kept"), bytes(detail.usage.keptDeletedBytes)],
            [t("users.backstop"), detail.usage.keptBackstopReached ? t("common.yes") : t("common.no")],
            [
              t("users.egress"),
              <span key="egress" data-admin-egress>
                {egressText(detail)}
              </span>,
            ],
          ]}
        />
        <Box component="form" onSubmit={saveQuota} sx={{ display: "flex", gap: 2, alignItems: "center" }}>
          <Box sx={{ width: 200 }}>
            <Field
              label={t("users.quotaGb")}
              name="quota"
              value={quotaGb}
              onChange={(event) => setQuotaGb(event.target.value)}
            />
          </Box>
          <Button type="submit">{t("users.setQuota")}</Button>
        </Box>
      </Section>
      <Section id="actions" title={t("users.actions")}>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          {user.suspendedAt ? (
            <Button onClick={() => setPending({ kind: "unsuspend" })}>{t("users.unsuspend")}</Button>
          ) : (
            <Button onClick={() => setPending({ kind: "suspend" })}>{t("users.suspend")}</Button>
          )}
          {user.banned ? (
            <Button onClick={() => setPending({ kind: "unban" })}>{t("users.unban")}</Button>
          ) : (
            <Button onClick={() => setPending({ kind: "ban" })}>{t("users.ban")}</Button>
          )}
          <Button
            onClick={() => setPending({ kind: "role", role: user.role === "admin" ? "user" : "admin" })}
          >
            {user.role === "admin" ? t("users.makeUser") : t("users.makeAdmin")}
          </Button>
          <Button onClick={() => setPending({ kind: "revokeSessions" })}>{t("users.revokeSessions")}</Button>
          <Button onClick={() => setPending({ kind: "revokeLinks" })}>{t("users.revokeLinks")}</Button>
          <Button onClick={() => setPending({ kind: "hold" })}>
            {user.legalHold ? t("users.holdClear") : t("users.holdSet")}
          </Button>
          <Button onClick={() => setPending({ kind: "impersonate" })}>{t("users.impersonate")}</Button>
          {user.deleteScheduledAt ? (
            <Button onClick={() => setPending({ kind: "cancelDelete" })}>{t("users.cancelDelete")}</Button>
          ) : (
            <Button color="error" onClick={() => setPending({ kind: "delete" })}>
              {t("users.delete")}
            </Button>
          )}
        </Box>
      </Section>
      <Section id="strikes" title={t("users.strikes")}>
        <Box
          component="form"
          onSubmit={strike}
          sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}
        >
          <Box sx={{ width: 160 }}>
            <Field
              select
              label={t("users.strikeKind")}
              value={strikeKind}
              onChange={(event) => setStrikeKind(event.target.value as StrikeKind)}
            >
              {(["abuse", "malware", "dmca"] as const).map((kind) => (
                <MenuItem key={kind} value={kind}>
                  {label("strikeKind", kind)}
                </MenuItem>
              ))}
            </Field>
          </Box>
          <Box sx={{ flex: "1 1 260px" }}>
            <Field
              label={t("users.strikeNode")}
              name="nodeId"
              value={strikeNode}
              onChange={(event) => setStrikeNode(event.target.value)}
            />
          </Box>
          <Button type="submit">{t("users.addStrike")}</Button>
        </Box>
        <Box
          component="ul"
          sx={{ margin: 0, paddingLeft: 2, display: "flex", flexDirection: "column", gap: 1 }}
        >
          {detail.strikes.length === 0 ? <li>{t("users.noStrikes")}</li> : null}
          {detail.strikes.map((entry) => (
            <Box component="li" key={entry.id} data-admin-strike={entry.state}>
              {label("strikeKind", entry.kind)} · {when(entry.at)} · {strikeStateText(entry)}
              {entry.state === "active" ? (
                <Button size="small" onClick={() => setPending({ kind: "lift", strike: entry })}>
                  {t("users.lift")}
                </Button>
              ) : null}
            </Box>
          ))}
        </Box>
      </Section>
      <ReasonDialog
        open={pending !== null}
        title={pending ? titles[pending.kind] : ""}
        body={pending ? bodies[pending.kind] : undefined}
        confirmLabel={pending ? titles[pending.kind] : ""}
        destructive={pending?.kind === "delete" || pending?.kind === "revokeLinks" || pending?.kind === "ban"}
        busy={busy}
        error={error}
        onSubmit={(reason) => void act(reason)}
        onCancel={close}
      >
        {pending?.kind === "ban" ? (
          <Field
            label={t("users.banDays")}
            name="banDays"
            value={banDays}
            onChange={(event) => setBanDays(event.target.value)}
          />
        ) : null}
        {pending?.kind === "role" ? <span>{t("users.roleBody", { role: pending.role })}</span> : null}
      </ReasonDialog>
      <Box>
        <Button component={RouterLink} to="/admin/users">
          {t("common.back")}
        </Button>
      </Box>
    </Box>
  );
}
