import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const TrashPage = lazyPage(() => import("./TrashPage"), "TrashPage");

export const routes: RouteObject[] = [
  {
    path: "trash",
    element: <TrashPage />,
    handle: { title: t("nav.trash") },
  },
];
