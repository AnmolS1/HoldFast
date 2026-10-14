// `/preview/:nodeId` — a modal route. The frame renders it above the page named by `state.from`,
// which stays mounted underneath; siblings open it with
//   navigate("/preview/" + id, { state: { siblingIds, from } })
import type { RouteObject } from "react-router";
import { t } from "../../lib/i18n";
import { PreviewRoute } from "./PreviewRoute";

export const routes: RouteObject[] = [
  {
    path: "preview/:nodeId",
    element: <PreviewRoute />,
    handle: { overlay: true, title: t("nav.preview") },
  },
];
