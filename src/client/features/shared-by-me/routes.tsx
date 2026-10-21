import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { SharedByMePage } from "./SharedByMePage";

export const routes: RouteObject[] = [
  {
    path: "shared-by-me",
    element: <SharedByMePage />,
    handle: { title: t("nav.sharedByMe") },
  },
];
