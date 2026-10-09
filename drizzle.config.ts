// drizzle-kit: `npm run db:generate` (schema → SQL) and `npm run db:migrate` (apply).
//
// Migrations run from a developer machine or CI against the DIRECT database URL, never from the
// Worker. The URL comes from `process.env.DATABASE_URL_DIRECT` only (never from .dev.vars); in a
// worktree it is exported by `eval "$(scripts/dev-worktree.sh <task>)"` and names that
// worktree's own local database.
//
// Rule: a contract (destructive) migration ships one deploy after its expand migration, never in
// the same push.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/worker/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: {
    // `generate` needs no database; `migrate` fails with a connection error when this is unset.
    url: process.env.DATABASE_URL_DIRECT ?? "",
  },
});
