// The one registry of every wait the API named (`Retry-After`) now lives in the shell
// (lib/query.ts): the QueryClient's defaults consult it for every query, and `purgeUserState`
// clears it. This path is kept for the views that import it.
export { clearWaits, holdUntil, useWaitUntil, waitKey, waitUntil } from "../../lib/query";
