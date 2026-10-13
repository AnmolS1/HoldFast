import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { StarredPage } from "./StarredPage";

export const routes: RouteObject[] = [
  {
    path: "starred",
    element: <StarredPage />,
    handle: { title: t("nav.starred") },
  },
];
