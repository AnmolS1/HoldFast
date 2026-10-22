import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const StarredPage = lazyPage(() => import("./StarredPage"), "StarredPage");

export const routes: RouteObject[] = [
  {
    path: "starred",
    element: <StarredPage />,
    handle: { title: t("nav.starred") },
  },
];
