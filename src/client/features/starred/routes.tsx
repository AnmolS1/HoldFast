import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { StarredPage } from "./StarredPage";
import { PerAccount } from "./view-kit";

export const routes: RouteObject[] = [
  {
    path: "starred",
    element: (
      <PerAccount>
        <StarredPage />
      </PerAccount>
    ),
    handle: { title: t("nav.starred") },
  },
];
