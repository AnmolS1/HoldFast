// Placeholder. T06 replaces this file at the same path; the registry (routes/index.ts) already
// imports and orders it, so mounting never edits a seam. Paths are relative to /api.

import { Hono } from "hono";
import type { AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();
