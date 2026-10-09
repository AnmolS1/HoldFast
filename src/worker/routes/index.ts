// The API route registry. `app.ts` mounts every router below under /api, IN ARRAY ORDER. Each
// router declares its own full paths relative to /api — which is what lets three files serve
// /api/nodes/* and four serve /api/account/*.
//
// A task adds routes by replacing its placeholder file at the fixed path imported here; this
// file and app.ts do not change. `routeTable` says which file may declare which path, and
// tests/unit/worker-core/registry.test.ts enforces it:
//   - no method + path declared by two files;
//   - no route outside its file's row (a router-wide `use("*")` is outside every row: it would
//     also run for every router mounted after it);
//   - every id parameter carries a pattern from src/shared/ids.ts — `:id` → UUID_PARAM, `:token`
//     → TOKEN_PARAM, `:userId` and `:id` under /account/sessions/ → BA_ID_PARAM — so a static
//     segment (/nodes/root) can never be captured as an id, whichever file registers first;
//   - within a file, static paths before parameterised ones.

import type { Hono } from "hono";
import type { AppEnv } from "../services/request-context";
import { router as account } from "./account";
import { router as accountLifecycle } from "./account-lifecycle";
import { router as admin } from "./admin";
import { router as auth } from "./auth";
import { router as cspReport } from "./csp-report";
import { router as health } from "./health";
import { router as invites } from "./invites";
import { router as links } from "./links";
import { router as nodes } from "./nodes";
import { router as pendingEmail } from "./pending-email";
import { router as publicConfig } from "./public";
import { router as publicLinks } from "./public-links";
import { router as recent } from "./recent";
import { router as reports } from "./reports";
import { router as search } from "./search";
import { router as shares } from "./shares";
import { router as signupIntent } from "./signup-intent";
import { router as testOutbox } from "./test-outbox";
import { router as trash } from "./trash";
import { router as uploads } from "./uploads";

export type RouteRow = {
  /** The file: src/worker/routes/<name>.ts. */
  name: string;
  /** The task that owns the file (`a → b`: created by a, taken over by b). */
  task: string;
  /**
   * Paths this file owns outright, relative to /api. `:id` stands for any parameter, a trailing
   * `/*` for one or more further segments, and a leading `METHOD ` restricts the claim to that
   * method. A claim beats another file's `fallback`.
   */
  claims: readonly string[];
  /** Paths this file may declare only where no other file claims them. */
  fallback?: readonly string[];
};

export const routeTable: readonly RouteRow[] = [
  { name: "health", task: "T07", claims: ["/health"] },
  { name: "public", task: "T07", claims: ["/public/config"] },
  { name: "csp-report", task: "T07 → T26", claims: ["/public/csp-report"] },
  { name: "test-outbox", task: "T07", claims: ["/_test/outbox"] },
  { name: "auth", task: "T06", claims: ["/auth/*"] },
  { name: "signup-intent", task: "T06", claims: ["/auth-intent"] },
  { name: "invites", task: "T06", claims: ["/invites/*"] },
  { name: "pending-email", task: "T06", claims: ["/account/pending-email"] },
  {
    name: "account-lifecycle",
    task: "T06",
    claims: ["/account/accept-terms", "/account/deletion-status", "/account/deletion", "/account/deletion/*"],
  },
  { name: "account", task: "T23", claims: [], fallback: ["/account/*"] },
  {
    name: "nodes",
    task: "T11",
    claims: [
      "/nodes",
      "/nodes/root",
      "/nodes/folder",
      "/nodes/zip-manifest",
      "/nodes/download-urls",
      "/account/usage",
    ],
    fallback: ["/nodes/:id", "/nodes/:id/*"],
  },
  {
    name: "trash",
    task: "T14",
    claims: ["/nodes/:id/trash", "/nodes/:id/restore", "DELETE /nodes/:id", "/trash"],
  },
  {
    name: "shares",
    task: "T24",
    claims: ["/nodes/:id/sharing", "/nodes/:id/shares", "/shares/*", "/shared-with-me"],
  },
  { name: "links", task: "T24", claims: ["/nodes/:id/links", "/links/*"] },
  { name: "uploads", task: "T12", claims: ["/uploads", "/uploads/*"] },
  { name: "search", task: "T15", claims: ["/search"] },
  { name: "recent", task: "T15", claims: ["/recent", "/starred"] },
  { name: "reports", task: "T22", claims: ["/public/report", "/reports", "/reports/*"] },
  { name: "public-links", task: "T24", claims: ["/public/links/*"] },
  { name: "admin", task: "T25", claims: ["/admin/*"] },
];

/** Mounted in this order. The names and their order are `routeTable`'s. */
export const apiRouters: Array<{ name: string; router: Hono<AppEnv> }> = [
  { name: "health", router: health },
  { name: "public", router: publicConfig },
  { name: "csp-report", router: cspReport },
  { name: "test-outbox", router: testOutbox },
  { name: "auth", router: auth },
  { name: "signup-intent", router: signupIntent },
  { name: "invites", router: invites },
  { name: "pending-email", router: pendingEmail },
  { name: "account-lifecycle", router: accountLifecycle },
  { name: "account", router: account },
  { name: "nodes", router: nodes },
  { name: "trash", router: trash },
  { name: "shares", router: shares },
  { name: "links", router: links },
  { name: "uploads", router: uploads },
  { name: "search", router: search },
  { name: "recent", router: recent },
  { name: "reports", router: reports },
  { name: "public-links", router: publicLinks },
  { name: "admin", router: admin },
];
