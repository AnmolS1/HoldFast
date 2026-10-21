// `/shared-by-me` — everything the caller shares, in two tabs.
//
//   People  shares grouped by item: change a role, remove a person.
//   Links   every link with its state, why it is paused (one line per reason the API gives),
//           "Limit reached today — comes back on its own" when the day's limit is used up (no
//           Resume: there is nothing to resume), counts, last access, Copy, Pause / Resume where
//           the owner may, Revoke — and Revoke for every selected link in one action. Filter by
//           state.
//
// No polling: the lists are read when the page opens and after a change; a `429` waits as the
// shell's registry says. ACCOUNT CHANGE: the selection and an open confirmation are dropped with
// the account (a purger), and a change in flight is dropped by `forThisAccount`.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { LinkDto, LinkState } from "../../../shared/schemas/link";
import type { ShareDto, ShareRole, SharesMineDto } from "../../../shared/schemas/share";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { toast } from "../../components/Toaster";
import { ApiError, toastApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { hf } from "../../theme/tokens";
import {
  forThisAccount,
  LinkRow,
  patchShare,
  refreshSharing,
  removeShare,
  revokeLink,
  stateWords,
  useLinksMine,
  useSharesMine,
} from "../share";
import { t } from "./strings";

type Filter = "all" | "limited" | LinkState;
const STATES: LinkState[] = ["active", "paused", "limit_reached", "locked", "expired", "revoked"];

function ErrorState({ error, onRetry }: { error: unknown; onRetry(): void }) {
  return (
    <EmptyState
      type="unavailable"
      title={t("byMe.error.title")}
      requestId={error instanceof ApiError ? error.requestId : undefined}
      actions={<Button onClick={onRetry}>{t("byMe.retry")}</Button>}
    />
  );
}

// ── people ──────────────────────────────────────────────────────────────────────────────────

function PersonLine({ share }: { share: ShareDto }) {
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const result = await forThisAccount(request);
      if (result.dropped) return;
      if (done) toast({ message: done });
      refreshSharing();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box
      component="li"
      data-by-me-share={share.id}
      sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}
    >
      <Typography sx={{ flex: "1 1 auto", overflowWrap: "anywhere" }}>{share.email}</Typography>
      <TextField
        select
        size="small"
        value={share.role}
        disabled={busy}
        onChange={(event) => void run(() => patchShare(share.id, { role: event.target.value as ShareRole }))}
        slotProps={{ htmlInput: { "aria-label": t("byMe.people.role", { email: share.email }) } }}
      >
        <MenuItem value="viewer">{roleLabel("viewer")}</MenuItem>
        <MenuItem value="editor">{roleLabel("editor")}</MenuItem>
      </TextField>
      <IconButton
        aria-label={t("byMe.people.remove", { email: share.email })}
        disabled={busy}
        onClick={() =>
          void run(() => removeShare(share.id), t("byMe.people.removed", { email: share.email }))
        }
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

const roleLabel = (role: ShareRole): string => t(role === "viewer" ? "byMe.role.viewer" : "byMe.role.editor");

function PeopleTab() {
  const shares = useSharesMine();
  if (shares.isError) return <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />;
  const groups: SharesMineDto[] = shares.data ?? [];
  if (!shares.isPending && groups.length === 0) {
    return (
      <EmptyState type="first-use" title={t("byMe.people.empty.title")} body={t("byMe.people.empty.body")} />
    );
  }
  return (
    <Box component="ul" aria-label={t("byMe.people.list")} sx={{ listStyle: "none", p: 0, m: 0 }}>
      {groups.map((group) => (
        <Box
          component="li"
          key={group.node.id}
          data-by-me-node={group.node.id}
          sx={{ py: 1, borderBottom: `1px solid ${hf.hairline}` }}
        >
          <Typography component="h3" variant="subtitle2">
            {group.node.name}
          </Typography>
          <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
            {group.shares.map((share) => (
              <PersonLine key={share.id} share={share} />
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// ── links ───────────────────────────────────────────────────────────────────────────────────

function matches(link: LinkDto, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "limited") return link.limitedToday === true;
  return link.state === filter;
}

function LinksTab() {
  const links = useLinksMine();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // What was picked belongs to this account.
  useEffect(
    () =>
      registerUserStatePurger(() => {
        setSelected(new Set());
        setConfirming(false);
      }),
    [],
  );
  const shown = useMemo(
    () => (links.data ?? []).filter((link) => matches(link, filter)),
    [links.data, filter],
  );
  const revocable = shown.filter((link) => link.state !== "revoked");
  const picked = revocable.filter((link) => selected.has(link.id));

  if (links.isError) return <ErrorState error={links.error} onRetry={() => void links.refetch()} />;
  if (!links.isPending && (links.data ?? []).length === 0) {
    return (
      <EmptyState type="first-use" title={t("byMe.links.empty.title")} body={t("byMe.links.empty.body")} />
    );
  }

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const revokePicked = async () => {
    setBusy(true);
    let done = 0;
    let left = 0;
    try {
      // One after the other: a dozen links are a dozen small requests, not a burst.
      for (const link of picked) {
        try {
          const result = await forThisAccount(() => revokeLink(link.id));
          if (result.dropped) return;
          done += 1;
        } catch {
          left += 1;
        }
      }
      setSelected(new Set());
      setConfirming(false);
      toast({
        message:
          left > 0
            ? t("byMe.links.revokeAll.partial", { done, left })
            : done === 1
              ? t("byMe.links.revokeAll.done.one")
              : t("byMe.links.revokeAll.done", { count: done }),
      });
      refreshSharing();
    } catch (error) {
      toastApiError(error);
    } finally {
      setBusy(false);
    }
  };

  const now = links.dataUpdatedAt;
  return (
    <Box data-by-me-links>
      <Box sx={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap", py: 1 }}>
        <TextField
          select
          size="small"
          label={t("byMe.links.filter")}
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          sx={{ minWidth: 200 }}
          slotProps={{ select: { inputProps: { "data-by-me-filter": "" } } }}
        >
          <MenuItem value="all">{t("byMe.links.filter.all")}</MenuItem>
          {STATES.map((state) => (
            <MenuItem key={state} value={state}>
              {stateWords(state)}
            </MenuItem>
          ))}
          <MenuItem value="limited">{t("byMe.links.filter.limited")}</MenuItem>
        </TextField>
        <Checkbox
          checked={revocable.length > 0 && picked.length === revocable.length}
          indeterminate={picked.length > 0 && picked.length < revocable.length}
          disabled={revocable.length === 0}
          onChange={(event) =>
            setSelected(event.target.checked ? new Set(revocable.map((link) => link.id)) : new Set())
          }
          slotProps={{ input: { "aria-label": t("byMe.links.selectAll") } }}
        />
        <Button
          color="error"
          variant="outlined"
          disabled={picked.length === 0 || busy}
          onClick={() => setConfirming(true)}
          data-by-me-revoke-selected
        >
          {picked.length === 1
            ? t("byMe.links.revokeSelected.one")
            : t("byMe.links.revokeSelected", { count: picked.length })}
        </Button>
      </Box>
      <Box component="ul" aria-label={t("byMe.links.list")} sx={{ listStyle: "none", p: 0, m: 0 }}>
        {shown.map((link) => (
          <Box
            component="li"
            key={link.id}
            data-by-me-link={link.id}
            sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}
          >
            <Checkbox
              checked={selected.has(link.id)}
              disabled={link.state === "revoked"}
              onChange={(event) => toggle(link.id, event.target.checked)}
              slotProps={{ input: { "aria-label": t("byMe.links.select", { name: link.node.name }) } }}
            />
            <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
              <Typography component="h3" variant="subtitle2" sx={{ pt: 1 }}>
                {link.node.name}
              </Typography>
              <Box component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
                <LinkRow link={link} now={now} />
              </Box>
            </Box>
          </Box>
        ))}
      </Box>
      <ConfirmDialog
        open={confirming}
        title={
          picked.length === 1
            ? t("byMe.links.revokeAll.title.one")
            : t("byMe.links.revokeAll.title", { count: picked.length })
        }
        consequence={t("byMe.links.revokeAll.consequence")}
        confirmLabel={
          picked.length === 1
            ? t("byMe.links.revokeSelected.one")
            : t("byMe.links.revokeSelected", { count: picked.length })
        }
        destructive
        busy={busy}
        onConfirm={() => void revokePicked()}
        onCancel={() => setConfirming(false)}
      />
    </Box>
  );
}

export function SharedByMePage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "links" ? "links" : "people";
  return (
    <Box
      data-shared-page="by-me"
      sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, px: 2 }}
    >
      <Tabs
        value={tab}
        onChange={(_event, next: string) =>
          setParams(next === "links" ? { tab: "links" } : {}, { replace: true })
        }
        aria-label={t("byMe.tabs")}
      >
        <Tab value="people" label={t("byMe.tab.people")} id="by-me-tab-people" aria-controls="by-me-panel" />
        <Tab value="links" label={t("byMe.tab.links")} id="by-me-tab-links" aria-controls="by-me-panel" />
      </Tabs>
      <Box
        id="by-me-panel"
        role="tabpanel"
        aria-labelledby={`by-me-tab-${tab}`}
        sx={{ flex: "1 1 auto", overflow: "auto" }}
      >
        {tab === "people" ? <PeopleTab /> : <LinksTab />}
      </Box>
    </Box>
  );
}
