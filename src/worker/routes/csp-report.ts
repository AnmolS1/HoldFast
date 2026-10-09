// Placeholder. The security-hardening task replaces this file: for now a CSP violation report is
// accepted and discarded, so the `report-uri` in the policy has somewhere to go.

import { Hono } from "hono";
import type { AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

router.post("/public/csp-report", async (c) => {
  await c.req.raw.body?.cancel();
  return c.body(null, 204);
});
