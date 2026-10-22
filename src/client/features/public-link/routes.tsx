import type { RouteObject } from "react-router";
import { lazyPage } from "../lazy-page";

// Its own chunk (../lazy-page.tsx).
const PublicLinkPage = lazyPage(() => import("./PublicLinkPage"), "PublicLinkPage");

// The public link page: no auth, outside the app frame and every guard.
export const routes: RouteObject[] = [
  {
    path: "s/:token",
    element: <PublicLinkPage />,
    handle: { public: true },
  },
];
