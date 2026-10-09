import CircularProgress from "@mui/material/CircularProgress";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../lib/api";
import { InviteStatusShape } from "../../lib/contracts";
import { t } from "../../lib/i18n";
import { AuthCard } from "./parts";

/** `/invite/:code`: check the code (valid or not — never why) and hand it to the sign-up form. */
export function InvitePage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    const go = (valid: boolean | null) => {
      if (cancelled) return;
      const query = new URLSearchParams({ invite: code });
      if (valid !== null) query.set("valid", valid ? "1" : "0");
      navigate(`/signup?${query.toString()}`, { replace: true });
    };
    api(`/api/invites/${encodeURIComponent(code)}`, { schema: InviteStatusShape }).then(
      (result) => go(result.valid),
      // The check failing is not the code failing: prefill and let sign-up decide.
      () => go(null),
    );
    return () => {
      cancelled = true;
    };
  }, [code, navigate]);
  return (
    <AuthCard title={t("invite.checking")}>
      <CircularProgress aria-label={t("app.loading")} />
    </AuthCard>
  );
}
