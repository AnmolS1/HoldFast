import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { RecentPage } from "./RecentPage";

export const routes: RouteObject[] = [
  {
    path: "recent",
    element: <RecentPage />,
    handle: { title: t("nav.recent") },
  },
];
