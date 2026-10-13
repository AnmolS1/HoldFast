import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { UsagePage } from "./UsagePage";

export const routes: RouteObject[] = [
  { path: "storage", element: <UsagePage />, handle: { title: t("nav.storage"), details: false } },
];
