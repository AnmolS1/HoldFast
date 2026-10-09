// PLACEHOLDER — taken over by the sharing task (T24), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

// The public link page: no auth, outside the app frame and every guard.
export const routes: RouteObject[] = [
  { path: "s/:token", element: <PlaceholderPage name={t("nav.publicLink")} headingLevel="h1" />, handle: { public: true } },
];
