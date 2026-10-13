import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { SearchPage } from "./SearchPage";

export const routes: RouteObject[] = [
  { path: "search", element: <SearchPage />, handle: { title: t("nav.search") } },
];
