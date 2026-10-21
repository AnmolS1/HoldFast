// Devices: where the account is signed in (revoke one, or every other) and the recent sign-in
// activity. Both are read when the section is opened, never polled. A place is the country only,
// marked approximate; never an address.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ActivityDto, SessionDto } from "../../../shared/schemas/account";
import { toast } from "../../components/Toaster";
import { ApiError, toastApiError } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { accountEpoch, sameAccount, useSession } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { activityQuery, revokeOtherSessions, revokeSession, sessionsQuery } from "./api";
import { SectionError } from "./ProfileSection";
import { t, type AccountMessage } from "./strings";
import { Note, Section } from "./ui";

/** "Germany (approximate)": the region name of the country code, in the UI's language. */
function placeOf(country: string | null): string {
  if (!country) return t("account.unknownPlace");
  let name = country;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
  } catch {
    // An unknown code: shown as it is.
  }
  return t("account.approximate", { country: name });
}

const deviceOf = (label: string | null) =>
  label && label.trim() !== "" ? label : t("account.unknownDevice");

function SessionRow({
  row,
  zone,
  onRevoke,
  busy,
}: {
  row: SessionDto;
  zone: string | null | undefined;
  onRevoke(): void;
  busy: boolean;
}) {
  const device = deviceOf(row.uaLabel);
  return (
    <Box
      component="li"
      data-session={row.current ? "current" : "other"}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        minHeight: layout.rowHeight,
        padding: "6px 0",
        borderBottom: `1px solid ${hf.hairline}`,
        flexWrap: "wrap",
      }}
    >
      <Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
        <Box>
          {device}
          {row.current ? (
            <Box component="span" sx={{ marginLeft: 2, fontSize: 12, color: hf.textSecondary }}>
              {t("devices.current")}
            </Box>
          ) : null}
        </Box>
        <Box sx={{ fontSize: 12, color: hf.textSecondary }}>
          {placeOf(row.country)} ·{" "}
          {t("devices.lastActive", { when: formatRelative(row.lastActiveAt, { timeZone: zone }) })}
        </Box>
      </Box>
      {row.current ? null : (
        <Button
          size="small"
          onClick={onRevoke}
          disabled={busy}
          aria-label={t("devices.signOut.label", { device })}
        >
          {t("devices.signOut")}
        </Button>
      )}
    </Box>
  );
}

function Sessions() {
  const queryClient = useQueryClient();
  const zone = useSession().data?.user.timezone;
  const sessions = useQuery(sessionsQuery);
  const [busy, setBusy] = useState(false);
  if (sessions.isError) return <SectionError onRetry={() => void sessions.refetch()} />;
  const others = sessions.data?.filter((row) => !row.current).length ?? 0;

  const act = async (work: () => Promise<string>) => {
    const then = accountEpoch();
    setBusy(true);
    try {
      const message = await work();
      if (!sameAccount(then)) return;
      toast({ message, key: "sessions" });
    } catch (cause) {
      if (!sameAccount(then)) return;
      // Already gone (signed out elsewhere): the list is read again below either way.
      if (!(cause instanceof ApiError && cause.status === 404)) toastApiError(cause);
    } finally {
      if (sameAccount(then)) {
        setBusy(false);
        await queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey });
      }
    }
  };

  return (
    <Section
      id="sessions"
      title={t("devices.sessions")}
      action={
        others > 0 ? (
          <Button
            variant="outlined"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const { revoked } = await revokeOtherSessions();
                return revoked === 0
                  ? t("devices.signedOutOthers.none")
                  : revoked === 1
                    ? t("devices.signedOutOthers.one")
                    : t("devices.signedOutOthers.many", { count: revoked });
              })
            }
          >
            {t("devices.signOutOthers")}
          </Button>
        ) : null
      }
    >
      {sessions.data ? (
        <Box component="ul" data-sessions sx={{ margin: 0, padding: 0, listStyle: "none" }}>
          {sessions.data.map((row) => (
            <SessionRow
              key={row.id}
              row={row}
              zone={zone}
              busy={busy}
              onRevoke={() =>
                void act(async () => {
                  await revokeSession(row.id);
                  return t("devices.signedOutOne");
                })
              }
            />
          ))}
        </Box>
      ) : (
        <Box aria-busy="true" data-account-loading />
      )}
      {sessions.data && others === 0 ? <Note>{t("devices.empty")}</Note> : null}
      <Note>{t("devices.ipNote")}</Note>
    </Section>
  );
}

const ACTIVITY_TEXT: Record<string, AccountMessage> = {
  "auth.sign_in": "activity.auth.sign_in",
  "auth.failed": "activity.auth.failed",
  "auth.sign_out": "activity.auth.sign_out",
  "auth.password_changed": "activity.auth.password_changed",
  "auth.2fa_enabled": "activity.auth.2fa_enabled",
  "auth.2fa_disabled": "activity.auth.2fa_disabled",
  "auth.totp_secret_viewed": "activity.auth.totp_secret_viewed",
  "auth.backup_codes_regenerated": "activity.auth.backup_codes_regenerated",
  "auth.second_factor_refused": "activity.auth.second_factor_refused",
  "auth.passkey_added": "activity.auth.passkey_added",
  "auth.passkey_removed": "activity.auth.passkey_removed",
  "auth.email_changed": "activity.auth.email_changed",
};

function ActivityRow({ row, zone }: { row: ActivityDto; zone: string | null | undefined }) {
  return (
    <Box
      component="li"
      data-activity={row.action}
      sx={{ padding: "6px 0", borderBottom: `1px solid ${hf.hairline}` }}
    >
      <Box sx={{ display: "flex", gap: 2, alignItems: "baseline", flexWrap: "wrap" }}>
        <Box sx={{ color: row.outcome === "failed" ? hf.danger : hf.text }}>
          {t(ACTIVITY_TEXT[row.action] ?? "activity.other")}
        </Box>
        <Box sx={{ fontSize: 12, color: hf.textSecondary }}>{formatRelative(row.at, { timeZone: zone })}</Box>
      </Box>
      <Box sx={{ fontSize: 12, color: hf.textSecondary }}>
        {deviceOf(row.uaLabel)} · {placeOf(row.country)}
      </Box>
    </Box>
  );
}

function Activity() {
  const zone = useSession().data?.user.timezone;
  const activity = useQuery(activityQuery);
  if (activity.isError) return <SectionError onRetry={() => void activity.refetch()} />;
  return (
    <Section id="activity" title={t("devices.activity")}>
      {activity.data && activity.data.length === 0 ? <Note>{t("devices.activity.empty")}</Note> : null}
      {activity.data && activity.data.length > 0 ? (
        <Box component="ul" data-activity-list sx={{ margin: 0, padding: 0, listStyle: "none" }}>
          {activity.data.map((row) => (
            <ActivityRow key={row.id} row={row} zone={zone} />
          ))}
        </Box>
      ) : null}
    </Section>
  );
}

export function DevicesSection() {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <Sessions />
      <Activity />
    </Box>
  );
}
