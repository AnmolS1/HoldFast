// PLACEHOLDER — taken over by the account task (T23), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  { path: "account/*", element: <PlaceholderPage name={t("nav.account")} />, handle: { title: t("nav.account"), details: false } },
];
