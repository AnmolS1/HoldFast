// PLACEHOLDER — taken over by the sharing task (T24), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  {
    path: "shared-by-me",
    element: <PlaceholderPage name={t("nav.sharedByMe")} />,
    handle: { title: t("nav.sharedByMe") },
  },
];
