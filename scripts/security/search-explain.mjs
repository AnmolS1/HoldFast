// EXPLAIN (ANALYZE, BUFFERS) of what `searchNames` (src/worker/db/queries/search.ts) sends, for
// T26 items 10 and 18 — the statements are the code's own, not a copy: `searchNames` runs for
// real against the database, and every ranked read it sends through `execute` is explained first
// (then run, so the code's own control flow — strict pass, then the word pass only when the strict
// matches are short — is what is measured).
//
//   DATABASE_URL_DIRECT=… npx tsx scripts/security/search-explain.mjs --user <grantee id> \
//       --term <rare> --term <common> --term <folder name> [--scope shared|all|mine] [--offset 1000] \
//       [--non-prod-host <db host>]
//
// Read-only: everything runs inside one transaction that is rolled back. Never production. Prints
// the plans and each statement's Execution Time; never a connection string or a row.

import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDb } from "../../src/worker/db/client.ts";
import { encodeCursor } from "../../src/worker/db/cursor.ts";
import { OWNER_VISIBLE_STATUSES, SHARED_VISIBLE_STATUSES } from "../../src/worker/db/queries/nodes.ts";
import { searchNames } from "../../src/worker/db/queries/search.ts";
import { classifyTarget } from "../lib/session-target.ts";

const { values } = parseArgs({
  options: {
    user: { type: "string" },
    term: { type: "string", multiple: true },
    scope: { type: "string", default: "shared" },
    offset: { type: "string", default: "0" },
    limit: { type: "string", default: "20" },
    "non-prod-host": { type: "string" },
  },
});
if (!values.user || !values.term?.length || !["shared", "all", "mine"].includes(values.scope)) {
  console.error(
    "usage: search-explain.mjs --user <id> --term <q> [--term <q> …] [--scope shared|all|mine] [--offset n]",
  );
  process.exit(2);
}
const target = classifyTarget(process.env.DATABASE_URL_DIRECT, { nonProdHost: values["non-prod-host"] });
if (target.target === "prod") {
  console.error("search-explain: never against production");
  process.exit(2);
}

const dialect = new PgDialect();
const visibleStatuses = (scope) =>
  scope === "mine"
    ? OWNER_VISIBLE_STATUSES
    : scope === "shared"
      ? SHARED_VISIBLE_STATUSES
      : { mine: OWNER_VISIBLE_STATUSES, shared: SHARED_VISIBLE_STATUSES };

/** An executor over `ex` whose `execute` explains the statement, then runs it. */
function explaining(ex, label, log) {
  return new Proxy(ex, {
    get(inner, property, receiver) {
      if (property === "execute") {
        return async (query) => {
          const { sql: text } = dialect.sqlToQuery(query);
          if (!/set_config|SET TRANSACTION/i.test(text)) {
            // On the same executor: inside the transaction, after its settings.
            const plan = await inner.execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
            log.push({
              label: `${label} #${log.length + 1}`,
              plan: plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
            });
          }
          return inner.execute(query);
        };
      }
      if (property === "transaction") {
        return (fn) => inner.transaction((tx) => fn(explaining(tx, `${label} (word pass)`, log)));
      }
      const value = Reflect.get(inner, property, receiver);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

const { db, close } = createDb({ HYPERDRIVE: { connectionString: target.url } });
try {
  const offset = Number(values.offset);
  console.log(
    `search-explain (${target.target}): scope ${values.scope}, offset ${offset}, limit ${values.limit}`,
  );
  for (const term of values.term) {
    const log = [];
    const started = performance.now();
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const cursor =
          offset > 0
            ? encodeCursor(`search:${values.user}:${values.scope}:${term.trim().toLowerCase()}`, { offset })
            : null;
        const found = await searchNames(explaining(tx, "ranked read", log), values.user, term, {
          scope: values.scope,
          visibleStatuses: visibleStatuses(values.scope),
          cursor,
          limit: Number(values.limit),
        });
        log.push({ label: "result", plan: `${found.items.length} item(s) on this page` });
        throw Object.assign(new Error("rollback"), { rollback: true });
      })
      .catch((error) => {
        if (!error.rollback) throw error;
      });
    const total = (performance.now() - started).toFixed(1);
    console.log(`\n=== term "${term}" — searchNames end to end (explains included) ${total} ms`);
    for (const entry of log) {
      console.log(`--- ${entry.label}`);
      console.log(entry.plan);
    }
  }
} finally {
  await close();
}
