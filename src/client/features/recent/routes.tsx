import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const RecentPage = lazyPage(() => import("./RecentPage"), "RecentPage");

export const routes: RouteObject[] = [
  {
    path: "recent",
    element: <RecentPage />,
    handle: { title: t("nav.recent") },
  },
];
