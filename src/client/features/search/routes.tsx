// PLACEHOLDER — taken over by the views task (T19), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  { path: "search", element: <PlaceholderPage name={t("nav.search")} />, handle: { title: t("nav.search") } },
];
