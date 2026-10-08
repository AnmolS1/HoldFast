// Setup for the jsdom project: unmount whatever a test rendered, so tests in one file do not see
// each other's DOM. (Testing Library only does this by itself when the test globals are enabled.)
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
