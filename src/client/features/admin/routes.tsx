// The admin console: `/admin/*`, behind the router's admin guard (a non-admin gets not-found).
// The console itself is a LAZY chunk, imported when its element renders — which happens only once
// the guard's loader has passed, so a non-admin who opens /admin/x never downloads it. (A route
// `lazy` would not do: react-router runs it as soon as the path MATCHES, before the guard.)
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";

const AdminConsole = lazyPage(() => import("./AdminConsole"), "AdminConsole");

export const routes: RouteObject[] = [
  {
    path: "admin/*",
    element: <AdminConsole />,
    handle: { title: t("nav.admin"), details: false },
  },
];
