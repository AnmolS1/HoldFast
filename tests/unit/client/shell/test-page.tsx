// A page of the tests' own inside the app frame, for tests that need "some signed-in page" and
// nothing of any feature: it sits behind the same guards as every feature route, renders no
// feature code and asks the API for nothing. A test that is ABOUT a destination names that
// destination instead.
import type { RouteObject } from "react-router";
import { buildRoutes } from "../../../../src/client/router";

export const TEST_PAGE = "/test-page";

/** The app's real route tree with the test page added as one more child of the frame. */
export function buildRoutesWithTestPage(): RouteObject[] {
  const routes = buildRoutes();
  const frame = routes[0]?.children?.find((route) => route.id === "frame");
  if (!frame?.children) throw new Error("the route tree no longer has a frame route with children");
  frame.children.push({ path: TEST_PAGE.slice(1), element: <div data-test-page="" /> });
  return routes;
}

export const testPage = (): Element | null => document.querySelector("[data-test-page]");
