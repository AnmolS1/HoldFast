// Must stay the first import: see lib/zod-config.ts.
import "./lib/zod-config";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installStaleChunkReload } from "./lib/stale-chunk";
import "./theme/fonts";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// A chunk the deploy no longer has (a tab left open across a deploy): reload once (lib/stale-chunk.ts).
installStaleChunkReload();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
