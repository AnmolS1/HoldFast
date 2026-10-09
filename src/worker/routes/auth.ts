// Placeholder. T06 replaces this file at the same path; the registry (routes/index.ts) already
// imports and orders it, so mounting never edits a seam. Paths are relative to /api.
//
// Until then nobody can be signed in (auth/create-auth.ts: `getSession → null`), and the one
// endpoint answered here is the session read, with Better Auth's own signed-out body: JSON
// `null`. The SPA reads it in every route guard; as a 404 it is a failure, and every page —
// /login included — shows the "couldn't start" screen instead of the sign-in form.
// Everything else under /auth/* still falls through to the registry's 404.

import { Hono } from "hono";
import type { AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

router.get("/auth/get-session", (c) => c.json(null));
