// The explorer's routes: the caller's top level and any folder they have a role on.
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const ExplorerPage = lazyPage(() => import("./ExplorerPage"), "ExplorerPage");

export const routes: RouteObject[] = [
  { index: true, element: <ExplorerPage />, handle: { title: t("nav.files") } },
  { path: "folder/:id", element: <ExplorerPage />, handle: { title: t("nav.files") } },
];
