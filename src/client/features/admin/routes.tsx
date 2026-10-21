// The admin console: `/admin/*`, behind the router's admin guard (a non-admin gets not-found).
// The console itself is a LAZY chunk — loaded only when an admin opens it.
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";

export const routes: RouteObject[] = [
  {
    path: "admin/*",
    lazy: async () => {
      const { AdminConsole } = await import("./AdminConsole");
      return { Component: AdminConsole };
    },
    handle: { title: t("nav.admin"), details: false },
  },
];
