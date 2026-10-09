import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Wordmark } from "../../components/Mark";
import { api, ApiError, completeTermsGate } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { EXTERNAL_LINKS } from "../../lib/contracts";
import { t } from "../../lib/i18n";
import { getKnownUserId, purgeUserState, refreshSession, usePublicConfig } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { safeNext } from "../auth/validation";

/**
 * Terms re-acceptance: a blocking screen outside the app frame, shown when the account's
 * accepted version is older than the current one, or when a request answered `terms_required`.
 * The screen replaces the app — nothing is readable until the terms are accepted. The only other
 * action is to sign out.
 */
export function AcceptTermsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const config = usePublicConfig().data;
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!checked || !config) return;
    setError(null);
    setBusy(true);
    const before = getKnownUserId();
    let after: string | null;
    try {
      await api("/api/account/accept-terms", { method: "POST", body: { version: config.termsVersion } });
      // The refreshed session passes the identity guard: if another account is signed in by now,
      // the previous account's state is purged and its waiting requests are discarded, not replayed.
      after = (await refreshSession())?.user.id ?? null;
    } catch (cause) {
      setBusy(false);
      setError(t("terms.failed"));
      setRequestId(cause instanceof ApiError ? cause.requestId : undefined);
      return;
    }
    setBusy(false);
    // Requests that were refused with `terms_required` replay now (none are left if the identity changed).
    completeTermsGate();
    // `next` belongs to whoever was sent here. A different account starts at the root instead.
    navigate(before !== null && after === before ? next : "/", { replace: true });
  };

  const onSignOut = async () => {
    setBusy(true);
    await callAuth(() => authClient.signOut());
    // Discards the requests waiting behind the gate and everything cached for this account.
    await purgeUserState();
    navigate("/login", { replace: true });
  };

  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        backgroundColor: hf.bg,
        padding: { xs: "24px 16px", md: "64px 16px 24px" },
      }}
    >
      <Box component="header" sx={{ width: "100%", maxWidth: 480, marginBottom: 4, color: hf.text }}>
        <Wordmark />
      </Box>
      <Box component="main" id="main" sx={{ width: "100%", maxWidth: 480 }}>
        <Box
          sx={{
            backgroundColor: hf.surface,
            border: `1px solid ${hf.hairline}`,
            borderRadius: `${layout.radius.card}px`,
            padding: { xs: 5, md: 7 },
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <Typography component="h1" sx={{ margin: 0, fontSize: 18, lineHeight: "24px", fontWeight: 600 }}>
            {t("terms.title")}
          </Typography>
          <Typography sx={{ color: hf.textSecondary }}>{t("terms.body")}</Typography>
          <Box
            component="ul"
            className="prose"
            sx={{ margin: 0, paddingLeft: 5, display: "flex", flexDirection: "column", gap: 1 }}
          >
            <li>
              <a href={EXTERNAL_LINKS.terms} target="_blank" rel="noopener">
                {t("terms.readTerms")}
              </a>
            </li>
            <li>
              <a href={EXTERNAL_LINKS.privacy} target="_blank" rel="noopener">
                {t("terms.readPrivacy")}
              </a>
            </li>
          </Box>
          <Box
            component="form"
            noValidate
            onSubmit={onSubmit}
            sx={{ display: "flex", flexDirection: "column", gap: 3 }}
          >
            <Box
              component="label"
              sx={{ display: "flex", alignItems: "center", gap: 2, minHeight: 44, cursor: "pointer" }}
            >
              <Box
                component="input"
                type="checkbox"
                name="accept"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                sx={{ width: 16, height: 16, margin: 0, flex: "none" }}
              />
              {t("terms.checkbox")}
            </Box>
            {error ? (
              <Box role="alert" sx={{ color: hf.danger, fontSize: 12 }}>
                {error}
                {requestId ? (
                  <>
                    {" "}
                    <span className="mono">{t("app.requestId", { id: requestId })}</span>
                  </>
                ) : null}
              </Box>
            ) : null}
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
              <Button type="submit" variant="contained" size="large" disabled={!checked || busy || !config}>
                {t("terms.accept")}
              </Button>
              <Button size="large" onClick={onSignOut} disabled={busy}>
                {t("terms.signOut")}
              </Button>
            </Box>
          </Box>
          {config ? (
            <Box className="mono" sx={{ color: hf.textSecondary }}>
              {t("terms.version", { version: config.termsVersion })}
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
