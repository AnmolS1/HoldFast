// Placeholder. The auth task replaces this file with the real Better Auth instance, built per
// request by the request context (`auth(c)`), never cached on the isolate.
// Until then nobody is ever signed in, and the handler answers 501.

import type { Db } from "../db/client";
import type { Auth } from "./types";

export function createAuth(env: Env, db: Db, ctx: ExecutionContext): Auth {
  void env;
  void db;
  void ctx;
  return {
    handler: async () =>
      new Response("Not implemented\n", {
        status: 501,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    api: { getSession: async () => null },
  };
}
