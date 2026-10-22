import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const UsagePage = lazyPage(() => import("./UsagePage"), "UsagePage");

export const routes: RouteObject[] = [
  {
    path: "storage",
    element: <UsagePage />,
    handle: { title: t("nav.storage"), details: false },
  },
];
