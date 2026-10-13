import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { PerAccount } from "../starred/view-kit";
import { SearchPage } from "./SearchPage";

export const routes: RouteObject[] = [
  {
    path: "search",
    element: (
      <PerAccount>
        <SearchPage />
      </PerAccount>
    ),
    handle: { title: t("nav.search") },
  },
];
