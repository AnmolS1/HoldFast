// Frame banners, stacked under the header: deletion scheduled, impersonation, read-only.
import Button from "@mui/material/Button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Eye, Wrench } from "lucide-react";
import { useState } from "react";
import { FrameBanner } from "../../components/FrameBanner";
import { toast } from "../../components/Toaster/store";
import { api, ApiError } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { isImpersonating } from "../../lib/contracts";
import { formatDate } from "../../lib/format";
import { t } from "../../lib/i18n";
import { deletionStatusQuery, refreshSession, usePublicConfig, useSession } from "../../lib/query";

/**
 * "This account is scheduled for deletion on <date>." with the only way to cancel. Signing in
 * never cancels a deletion. The copy does not promise that links work again after cancelling:
 * another pause reason may remain.
 */
export function DeletionBanner() {
  const session = useSession().data;
  const queryClient = useQueryClient();
  // The session cookie is cached for up to a minute, so the status route is asked as well.
  const status = useQuery({ ...deletionStatusQuery, enabled: Boolean(session), retry: false });
  // The scheduled date whose cancellation just succeeded: the banner hides at once, and shows
  // again only if a different (new) deletion is scheduled later.
  const [cancelled, setCancelled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const scheduledFor = status.data ? status.data.scheduledFor : (session?.user.deleteScheduledAt ?? null);

  if (!session || !scheduledFor || cancelled === scheduledFor) return null;

  const onCancel = async () => {
    setBusy(true);
    try {
      await api("/api/account/deletion/cancel", { method: "POST" });
    } catch (cause) {
      setBusy(false);
      if (cause instanceof ApiError && cause.status === 409) setStarted(true);
      else toast({ message: t("banner.deletion.failed"), requestId: cause instanceof ApiError ? cause.requestId : undefined });
      return;
    }
    setBusy(false);
    setCancelled(scheduledFor);
    queryClient.setQueryData(deletionStatusQuery.queryKey, { scheduledFor: null });
    toast({ message: t("banner.deletion.cancelled"), key: "deletion" });
    void refreshSession().catch(() => {});
  };

  return (
    <FrameBanner
      name="deletion"
      tone="danger"
      icon={<CalendarClock size={16} />}
      action={
        started ? null : (
          <Button onClick={onCancel} disabled={busy}>
            {t("banner.deletion.cancel")}
          </Button>
        )
      }
    >
      {started ? t("banner.deletion.started") : t("banner.deletion", { date: formatDate(scheduledFor, { timeZone: session.user.timezone, style: "long" }) })}
    </FrameBanner>
  );
}

export function ImpersonationBanner() {
  const session = useSession().data;
  const [busy, setBusy] = useState(false);
  if (!session || !isImpersonating(session)) return null;
  const onStop = async () => {
    setBusy(true);
    const result = await callAuth(() => authClient.admin.stopImpersonating());
    setBusy(false);
    if (result.error) {
      toast({ message: t("toast.generic") });
      return;
    }
    // Back to the admin's own session: start clean.
    window.location.assign("/admin");
  };
  return (
    <FrameBanner
      name="impersonation"
      tone="attention"
      icon={<Eye size={16} />}
      action={
        <Button onClick={onStop} disabled={busy}>
          {t("banner.impersonation.stop")}
        </Button>
      }
    >
      {t("banner.impersonation", { name: session.user.name || session.user.email })}
    </FrameBanner>
  );
}

export function ReadOnlyBanner() {
  const config = usePublicConfig().data;
  if (!config?.readOnly) return null;
  return (
    <FrameBanner name="read-only" icon={<Wrench size={16} />}>
      {t("banner.readOnly")}
    </FrameBanner>
  );
}

export function FrameBanners() {
  return (
    <>
      <ReadOnlyBanner />
      <ImpersonationBanner />
      <DeletionBanner />
    </>
  );
}
