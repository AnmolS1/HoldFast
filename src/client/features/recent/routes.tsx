import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { PerAccount } from "../starred/view-kit";
import { RecentPage } from "./RecentPage";

export const routes: RouteObject[] = [
  {
    path: "recent",
    element: (
      <PerAccount>
        <RecentPage />
      </PerAccount>
    ),
    handle: { title: t("nav.recent") },
  },
];
