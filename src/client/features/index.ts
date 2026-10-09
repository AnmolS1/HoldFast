// The route registry (seam: orchestrator-only after the shell task). Every v1 feature has a
// module at a fixed path that exports `routes`; an owner replaces its module, never this file.
// A route marked `handle: { public: true }` is rendered outside the app frame and every guard.
import type { RouteObject } from "react-router";
import type { RouteHandle } from "../components/slots";
import { routes as accountRoutes } from "./account/routes";
import { routes as adminRoutes } from "./admin/routes";
import { routes as dmcaRoutes } from "./dmca/routes";
import { routes as explorerRoutes } from "./explorer/routes";
import { routes as interstitialRoutes } from "./interstitial/routes";
import { routes as previewRoutes } from "./preview/routes";
import { routes as publicLinkRoutes } from "./public-link/routes";
import { routes as recentRoutes } from "./recent/routes";
import { routes as reportRoutes } from "./report/routes";
import { routes as searchRoutes } from "./search/routes";
import { routes as shareRoutes } from "./share/routes";
import { routes as sharedByMeRoutes } from "./shared-by-me/routes";
import { routes as starredRoutes } from "./starred/routes";
import { routes as trashRoutes } from "./trash/routes";
import { routes as uploadRoutes } from "./upload/routes";
import { routes as usageRoutes } from "./usage/routes";

const all: RouteObject[] = [
  ...explorerRoutes,
  ...uploadRoutes,
  ...previewRoutes,
  ...trashRoutes,
  ...recentRoutes,
  ...starredRoutes,
  ...searchRoutes,
  ...usageRoutes,
  ...accountRoutes,
  ...shareRoutes,
  ...sharedByMeRoutes,
  ...publicLinkRoutes,
  ...reportRoutes,
  ...interstitialRoutes,
  ...adminRoutes,
  ...dmcaRoutes,
];

export function routeHandle(route: RouteObject): RouteHandle {
  return (route.handle ?? {}) as RouteHandle;
}

const isPublic = (route: RouteObject) => routeHandle(route).public === true;

/** Rendered inside the app frame, behind the session, verification and terms guards. */
export const featureRoutes: RouteObject[] = all.filter((route) => !isPublic(route));

/** Rendered outside the frame and outside every auth guard. */
export const publicRoutes: RouteObject[] = all.filter(isPublic);
