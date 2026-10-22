import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const SharedByMePage = lazyPage(() => import("./SharedByMePage"), "SharedByMePage");

export const routes: RouteObject[] = [
  {
    path: "shared-by-me",
    element: <SharedByMePage />,
    handle: { title: t("nav.sharedByMe") },
  },
];
