// Must stay the first import: see lib/zod-config.ts.
import "./lib/zod-config";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { publicConfigQuery, queryClient } from "./lib/query";
import { initSentry } from "./lib/sentry";
import { installStaleChunkReload } from "./lib/stale-chunk";
import "./theme/fonts";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// A chunk the deploy no longer has (a tab left open across a deploy): reload once (lib/stale-chunk.ts).
installStaleChunkReload();

// Browser error reporting starts HERE, once, on every entry page — the public ones (/s/<token>,
// /dmca) have no loader and read no session, so the router never would — as soon as the public
// config is known (the same cached query the router's loaders read: one request). Only with a
// DSN; CSP and redaction are lib/sentry.ts's, unchanged. A config that cannot be loaded leaves
// it off (the app says so itself); the next page load tries again.
void queryClient.fetchQuery(publicConfigQuery).then(
  (config) => initSentry(config),
  () => false,
);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
