// The preview route as its own chunk (../lazy-page.tsx), with the opener read before it loads.
import { useEffect, useState } from "react";
import { lazyPage } from "../lazy-page";

const PreviewRoute = lazyPage(() => import("./PreviewRoute"), "PreviewRoute");

/**
 * Focus goes back to whatever opened the preview. PreviewRoute reads the opener on its first
 * render; while its chunk is still loading that render comes after the frame has made the page
 * underneath inert, which takes focus off the opener. So the opener is read here too, in the
 * render that opens the route, before anything is inert.
 */
export function LazyPreviewRoute() {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus();
    },
    [opener],
  );
  return <PreviewRoute />;
}

LazyPreviewRoute.preload = PreviewRoute.preload;
