// PLACEHOLDER — taken over by the admin task (T25), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  { path: "admin/*", element: <PlaceholderPage name={t("nav.admin")} />, handle: { title: t("nav.admin"), details: false } },
];
