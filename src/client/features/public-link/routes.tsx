import type { RouteObject } from "react-router";
import { PublicLinkPage } from "./PublicLinkPage";

// The public link page: no auth, outside the app frame and every guard.
export const routes: RouteObject[] = [
  {
    path: "s/:token",
    element: <PublicLinkPage />,
    handle: { public: true },
  },
];
