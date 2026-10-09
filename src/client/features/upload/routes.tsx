// PLACEHOLDER — taken over by the uploader task (T17), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  {
    path: "uploads",
    element: <PlaceholderPage name={t("nav.uploads")} />,
    handle: { title: t("nav.uploads"), details: false },
  },
];
