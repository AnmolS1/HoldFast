import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { isRouteErrorResponse, Link as RouterLink, useRouteError } from "react-router";
import { EmptyState } from "../../components/EmptyState";
import { Mark } from "../../components/Mark";
import { ApiError } from "../../lib/api";
import { t } from "../../lib/i18n";
import { reportError } from "../../lib/sentry";
import { hf } from "../../theme/tokens";

function Page({ children }: { children: React.ReactNode }) {
  return (
    <Box component="main" id="main" sx={{ minHeight: "100dvh", display: "flex", backgroundColor: hf.bg }}>
      {children}
    </Box>
  );
}

/** The first paint, while the session and the public config load. */
export function StartingPage() {
  return (
    <Box role="status" aria-busy="true" aria-label={t("app.loading")} sx={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: hf.bg, color: hf.textSecondary }}>
      <Mark size={28} />
    </Box>
  );
}

/** No route matches this address. */
export function NotFoundPage() {
  return (
    <Page>
      <EmptyState
        type="no-results"
        headingLevel="h1"
        title={t("notFound.title")}
        body={t("notFound.body")}
        actions={
          <Button variant="contained" component={RouterLink} to="/">
            {t("app.backToFiles")}
          </Button>
        }
      />
    </Page>
  );
}

/**
 * The router's error element. A 404 thrown by a guard renders as not-found (an admin page asked
 * for by a non-admin looks exactly like a page that does not exist); a failed session or config
 * load renders the "couldn't start" state with the request id; anything else is a broken page.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  const startFailure = error instanceof ApiError;
  if (!startFailure) reportError(error);
  return (
    <Page>
      <EmptyState
        type="unavailable"
        headingLevel="h1"
        title={t(startFailure ? "app.unavailable.title" : "error.title")}
        body={t(startFailure ? "app.unavailable.body" : "error.body")}
        requestId={startFailure ? error.requestId : undefined}
        actions={
          <Button variant="contained" onClick={() => window.location.reload()}>
            {t(startFailure ? "app.retry" : "error.reload")}
          </Button>
        }
      />
    </Page>
  );
}
