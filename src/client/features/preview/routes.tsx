// PLACEHOLDER — taken over by the preview task (T18), which replaces this module and keeps the `routes` export.
import type { RouteObject } from "react-router";
import { PlaceholderPage } from "../../components/PlaceholderPage";
import { t } from "../../lib/i18n";

// An overlay route: the frame renders it above the content pane and keeps the page named by
// `location.state.from` mounted underneath.
export const routes: RouteObject[] = [
  { path: "preview/:nodeId", element: <PlaceholderPage name={t("nav.preview")} />, handle: { overlay: true, title: t("nav.preview") } },
];
