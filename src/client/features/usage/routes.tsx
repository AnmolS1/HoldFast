import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { PerAccount } from "../starred/view-kit";
import { UsagePage } from "./UsagePage";

export const routes: RouteObject[] = [
  {
    path: "storage",
    element: (
      <PerAccount>
        <UsagePage />
      </PerAccount>
    ),
    handle: { title: t("nav.storage"), details: false },
  },
];
