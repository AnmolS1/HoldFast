import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { SharedWithMePage } from "./SharedWithMePage";

export const routes: RouteObject[] = [
  {
    path: "shared",
    element: <SharedWithMePage />,
    handle: { title: t("nav.sharedWithMe") },
  },
];
