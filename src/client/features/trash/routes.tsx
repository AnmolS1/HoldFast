import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { TrashPage } from "./TrashPage";

export const routes: RouteObject[] = [
  { path: "trash", element: <TrashPage />, handle: { title: t("nav.trash") } },
];
