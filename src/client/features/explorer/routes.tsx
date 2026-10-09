// PLACEHOLDER — taken over by the explorer task (T16), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  { index: true, element: <PlaceholderPage name={t("nav.files")} />, handle: { title: t("nav.files") } },
  { path: "folder/:id", element: <PlaceholderPage name={t("nav.files")} />, handle: { title: t("nav.files") } },
];
