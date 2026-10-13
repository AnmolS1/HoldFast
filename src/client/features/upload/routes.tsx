import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { UploadsPage } from "./UploadsPage";

export const routes: RouteObject[] = [
  {
    path: "uploads",
    element: <UploadsPage />,
    handle: { title: t("nav.uploads"), details: false },
  },
];
