import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const UploadsPage = lazyPage(() => import("./UploadsPage"), "UploadsPage");

export const routes: RouteObject[] = [
  {
    path: "uploads",
    element: <UploadsPage />,
    handle: { title: t("nav.uploads"), details: false },
  },
];
