// Section 8: links. Found by owner or node — tokens exist only hashed and sealed, so there is no
// token search and the console never sees a link's URL. The STORED pause reasons; lock / unlock;
// revoke (irreversible); pause by hand with `anomaly`, and lift it — the only way before T22's
// midnight job does at 00:05 UTC.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import type { AdminLinkDto } from "../../../../shared/schemas/admin";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { adminKeys, fetchLinks, linkAction, linkAnomaly, queryString } from "../api";
import { useAdminQuery } from "../query";
import { t } from "../strings";
import { ErrorState, Field, Loading, Mono, Note, ReasonDialog, Section, StatusLine } from "../ui";
import { bytes, label, refusalText, when } from "../words";

const UID = /^[A-Za-z0-9]{32}$/;

export function LinksPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("owner") ?? params.get("node") ?? "");
  const owner = params.get("owner");
  const node = params.get("node");
  const search = queryString({ ownerId: owner, nodeId: node });
  const query = useAdminQuery(adminKeys.links(search), (signal) => fetchLinks(search, signal));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) setParams({});
    else setParams(UID.test(value) ? { owner: value } : { node: value });
  };
  return (
    <Section
      id="links"
      title={t("nav.links")}
      action={<Button onClick={() => void query.refetch()}>{t("common.refresh")}</Button>}
    >
      <Box component="form" onSubmit={submit} sx={{ display: "flex", gap: 2 }}>
        <Box sx={{ flex: "1 1 320px" }}>
          <Field label={t("links.search")} value={text} onChange={(event) => setText(event.target.value)} />
        </Box>
        <Button type="submit">{t("common.search")}</Button>
      </Box>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {query.data.items.length === 0 ? <Note>{t("links.none")}</Note> : null}
          {query.data.items.map((link) => (
            <LinkRow key={link.id} link={link} search={search} />
          ))}
        </Box>
      )}
    </Section>
  );
}

function LinkRow({ link, search }: { link: AdminLinkDto; search: string }) {
  const client = useQueryClient();
  const [revoke, setRevoke] = useState(false);
  const [anomaly, setAnomaly] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paused = link.pauseReasons.length > 0;
  const update = (next: AdminLinkDto) => {
    client.setQueryData(
      adminKeys.links(search),
      (current: { items: AdminLinkDto[]; nextCursor: string | null } | undefined) =>
        current
          ? { ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }
          : current,
    );
  };
  const run = async (work: () => Promise<AdminLinkDto>) => {
    setBusy(true);
    setError(null);
    try {
      update(await work());
      setAnomaly(null);
      setRevoke(false);
    } catch (failure) {
      setError(refusalText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box data-admin-link={link.id} sx={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 1 }}>
      <Box>
        <strong>{link.node.name}</strong> · <Mono>{link.id}</Mono> · {t("links.owner")}{" "}
        <Mono>{link.ownerId}</Mono>
      </Box>
      <Box data-admin-link-state={link.revokedAt ? "revoked" : paused ? "paused" : "live"}>
        {link.revokedAt
          ? t("links.revoked", { when: when(link.revokedAt) })
          : paused
            ? t("links.paused", {
                reasons: link.pauseReasons.map((reason) => label("pause", reason)).join(", "),
              })
            : t("links.live")}
        {link.pauseReasons.includes("anomaly") ? ` ${t("links.anomalyLifts")}` : ""}
        {link.lockedByAdmin ? ` · ${t("links.locked")}` : ""}
      </Box>
      <Box>
        {t("links.stats", {
          count: link.downloadCount,
          bytes: bytes(link.bytesServed),
          last: when(link.lastAccessAt),
        })}
      </Box>
      {link.revokedAt ? null : (
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button
            size="small"
            disabled={busy}
            onClick={() => void run(() => linkAction(link.id, link.lockedByAdmin ? "unlock" : "lock"))}
          >
            {link.lockedByAdmin ? t("links.unlock") : t("links.lock")}
          </Button>
          {link.pauseReasons.includes("anomaly") ? (
            <Button size="small" onClick={() => setAnomaly(false)}>
              {t("links.unpauseAnomaly")}
            </Button>
          ) : (
            <Button size="small" onClick={() => setAnomaly(true)}>
              {t("links.pauseAnomaly")}
            </Button>
          )}
          <Button size="small" color="error" onClick={() => setRevoke(true)}>
            {t("links.revoke")}
          </Button>
        </Box>
      )}
      {error && anomaly === null ? <StatusLine tone="error">{error}</StatusLine> : null}
      <ReasonDialog
        open={anomaly !== null}
        title={anomaly ? t("links.pauseAnomaly") : t("links.unpauseAnomaly")}
        body={anomaly ? undefined : t("links.unpauseBody")}
        confirmLabel={anomaly ? t("links.pauseAnomaly") : t("links.unpauseAnomaly")}
        busy={busy}
        error={error}
        onSubmit={(reason) => void run(() => linkAnomaly(link.id, anomaly === true, reason))}
        onCancel={() => setAnomaly(null)}
      />
      <ConfirmDialog
        open={revoke}
        title={t("links.revokeTitle")}
        consequence={t("links.revokeBody")}
        confirmLabel={t("links.revoke")}
        destructive
        busy={busy}
        onConfirm={() => void run(() => linkAction(link.id, "revoke"))}
        onCancel={() => setRevoke(false)}
      />
    </Box>
  );
}
