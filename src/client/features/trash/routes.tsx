import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { PerAccount } from "../starred/view-kit";
import { TrashPage } from "./TrashPage";

export const routes: RouteObject[] = [
  {
    path: "trash",
    element: (
      <PerAccount>
        <TrashPage />
      </PerAccount>
    ),
    handle: { title: t("nav.trash") },
  },
];
