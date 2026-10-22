import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const SharedWithMePage = lazyPage(() => import("./SharedWithMePage"), "SharedWithMePage");

export const routes: RouteObject[] = [
  {
    path: "shared",
    element: <SharedWithMePage />,
    handle: { title: t("nav.sharedWithMe") },
  },
];
