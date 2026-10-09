// Placeholder hook, called by app.ts on every text/html response. The security-hardening task
// replaces this file (a per-response CSP nonce written into the HTML); app.ts does not change.

import type { Context } from "hono";
import type { AppEnv } from "../services/request-context";

export const htmlNonce = (res: Response, c: Context<AppEnv>): Response | Promise<Response> => {
  void c;
  return res;
};
