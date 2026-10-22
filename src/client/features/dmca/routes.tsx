import type { RouteObject } from "react-router";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const DmcaPage = lazyPage(() => import("./DmcaPage"), "DmcaPage");

// Public: reachable signed out, outside the app frame and every guard.
export const routes: RouteObject[] = [
  {
    path: "dmca",
    element: <DmcaPage />,
    handle: { public: true },
  },
];
