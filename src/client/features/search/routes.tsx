import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const SearchPage = lazyPage(() => import("./SearchPage"), "SearchPage");

export const routes: RouteObject[] = [
  {
    path: "search",
    element: <SearchPage />,
    handle: { title: t("nav.search") },
  },
];
