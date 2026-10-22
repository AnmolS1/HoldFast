// `/preview/:nodeId` — a modal route. The frame renders it above the page named by `state.from`,
// which stays mounted underneath; siblings open it with
//   navigate("/preview/" + id, { state: stamped({ siblingIds, from }) })   (lib/history-state.ts)
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { LazyPreviewRoute } from "./LazyPreviewRoute";

export const routes: RouteObject[] = [
  {
    path: "preview/:nodeId",
    element: <LazyPreviewRoute />,
    handle: { overlay: true, title: t("nav.preview") },
  },
];
