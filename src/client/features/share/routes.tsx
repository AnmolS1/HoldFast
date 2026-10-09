// PLACEHOLDER — taken over by the sharing task (T24), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  {
    path: "shared",
    element: <PlaceholderPage name={t("nav.sharedWithMe")} note={t("placeholder.shared.note")} />,
    handle: { title: t("nav.sharedWithMe") },
  },
];
