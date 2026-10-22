// The account feature: `/account/*`. Loading this module also starts the preferences sync for
// whichever account signs in (./prefs-sync.ts).
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { lazyPage } from "../lazy-page";
import { startPrefsSync } from "./prefs-sync";

// Its own chunk (../lazy-page.tsx).
const AccountPage = lazyPage(() => import("./AccountPage"), "AccountPage");

startPrefsSync();

export const routes: RouteObject[] = [
  {
    path: "account/*",
    element: <AccountPage />,
    handle: { title: t("nav.account"), details: false },
  },
];
