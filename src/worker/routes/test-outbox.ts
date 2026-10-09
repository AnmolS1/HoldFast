// GET /api/_test/outbox?to=&clear=1 — the in-memory mail outbox, for tests.
// Exists only in test mode (services/clock.ts: memory transport, not production, and a
// plain-http APP_ORIGIN — so never on a deploy); anywhere else the path
// is a plain 404. `env` is only known per request, so the gate is inside the router.

import { Hono } from "hono";
import { isTestMode } from "../services/clock";
import { AppError } from "../services/errors";
import * as outbox from "../services/outbox";
import type { AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

router.get("/_test/outbox", (c) => {
  if (!isTestMode(c.env)) throw new AppError("not_found");
  const to = c.req.query("to") || undefined;
  const messages = outbox.list({ to });
  if (c.req.query("clear") === "1") outbox.clear();
  return c.json({ messages });
});
