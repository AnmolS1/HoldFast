// The named Analytics Engine queries behind the admin dashboard's tiles. Each is ONE request to the
// Workers Analytics Engine SQL API (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/,
// read 2026-10-21): a POST to /accounts/<CF_ACCOUNT_ID>/analytics_engine/sql whose body is the SQL
// text, `Authorization: Bearer <CF_ANALYTICS_TOKEN>` (a read-only "Account Analytics" token).
//
// NOTHING OBSERVED IS NEVER "ZERO". Without the account id or the token — the token is a HUMAN
// step, and the test vars set it to "" — every query answers `{ available: false }` and sends no
// request. So does a query whose request failed, answered non-2xx, or answered a body that is not
// the documented `FORMAT JSON` shape. A tile shows "unavailable" for all of these; a check that
// observed nothing must not read as healthy.
//
// COUNTING REQUESTS. One SQL request per call and nothing else: no retry, no timer, no cache. The
// callers are a dashboard view (T25's `loadAnalyticsTiles`, after the orchestrator's swap) and a
// person; neither runs on a schedule.
//
// THE COLUMNS are services/metrics.ts's fixed layout:
//   index1 = name; blob1 name, blob2 outcome, blob3 kind, blob4 reason, blob5 route,
//   blob6 environment (SENTRY_ENVIRONMENT); double1 value, double2 ms.
// The data is SAMPLED: a count is SUM(_sample_interval), a total SUM(_sample_interval * double1).
// Analytics Engine is for dashboards; a ceiling, a bill or an alarm that must be exact reads the
// database ledgers (the backup job's two alarms do).
//
// Every SQL text here is built from constants: no value a caller passes reaches a query.

type MetricsQueryEnv = {
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  SENTRY_ENVIRONMENT?: string;
};

export type Unavailable = {
  available: false;
  /** `not_configured`: no account id or no token — no request was made. */
  reason: "not_configured" | "request_failed" | "bad_response";
};
export type Available<Row> = { available: true; rows: Row[] };
export type QueryResult<Row> = Available<Row> | Unavailable;

/** The dataset of each deployed environment (wrangler.jsonc `analytics_engine_datasets`). */
export const METRICS_DATASETS = { dev: "holdfast_metrics_dev", production: "holdfast_metrics" } as const;

export const SQL_API_URL = (accountId: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;

/** The environment's own dataset and its own rows (blob6): dev and production never mix. */
function scopeOf(env: MetricsQueryEnv): { table: string; environment: string } {
  const environment = env.SENTRY_ENVIRONMENT === "production" ? "production" : "dev";
  return { table: METRICS_DATASETS[environment], environment };
}

/** A string literal for the SQL text, from a constant only. */
function literal(value: string): string {
  if (!/^[A-Za-z0-9_:.-]*$/.test(value)) throw new Error("not a constant");
  return `'${value}'`;
}

/** Runs one SQL text: exactly one request, or none when not configured. Never throws. */
export async function runSql<Row extends Record<string, unknown>>(
  env: MetricsQueryEnv,
  sqlText: string,
  fetcher: typeof fetch = fetch,
): Promise<QueryResult<Row>> {
  const account = env.CF_ACCOUNT_ID?.trim() ?? "";
  const token = env.CF_ANALYTICS_TOKEN?.trim() ?? "";
  if (account === "" || token === "") return { available: false, reason: "not_configured" };
  // Each environment reads its own dataset and rows: an environment that is neither is a
  // misconfiguration, never "dev" by default (it would show one environment's numbers as another's).
  if (env.SENTRY_ENVIRONMENT !== "dev" && env.SENTRY_ENVIRONMENT !== "production") {
    return { available: false, reason: "not_configured" };
  }
  let response: Response;
  try {
    response = await fetcher(SQL_API_URL(account), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: `${sqlText}\nFORMAT JSON`,
    });
  } catch {
    return { available: false, reason: "request_failed" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { available: false, reason: "request_failed" };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { available: false, reason: "bad_response" };
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || !data.every((row) => row !== null && typeof row === "object")) {
    return { available: false, reason: "bad_response" };
  }
  return { available: true, rows: data as Row[] };
}

/** A count or a total as a number: ClickHouse may quote 64-bit integers in JSON. */
class NotANumber extends Error {}

/** A count or a total as a number (ClickHouse may quote 64-bit integers); anything else is a bad row. */
const num = (value: unknown): number => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) throw new NotANumber();
  return n;
};

/** Maps an available result's rows; an unavailable one passes through unchanged. */
function mapRows<In, Out>(
  result: QueryResult<In & Record<string, unknown>>,
  map: (row: In) => Out,
): QueryResult<Out> {
  if (!result.available) return result;
  try {
    return { available: true, rows: result.rows.map(map) };
  } catch (error) {
    // A row that is not what was asked for is not a zero: the whole answer is unreadable.
    if (error instanceof NotANumber) return { available: false, reason: "bad_response" };
    throw error;
  }
}

type Window = "1 HOUR" | "1 DAY" | "7 DAY" | "35 DAY";
const since = (window: Window) =>
  `timestamp > NOW() - INTERVAL '${window.split(" ")[0]}' ${window.split(" ")[1]}`;

/** `SUM(_sample_interval)` of one metric name in a window, grouped by the given columns. */
function countsSql(
  env: MetricsQueryEnv,
  name: string,
  window: Window,
  groups: Array<"blob2" | "blob3" | "blob4" | "blob5">,
  extra: string[] = [],
  aggregate = "SUM(_sample_interval)",
): string {
  const { table, environment } = scopeOf(env);
  const aliases: Record<string, string> = {
    blob2: "outcome",
    blob3: "kind",
    blob4: "reason",
    blob5: "route",
  };
  const select = groups.map((group) => `${group} AS ${aliases[group]}`);
  const where = [`index1 = ${literal(name)}`, `blob6 = ${literal(environment)}`, since(window), ...extra];
  return [
    `SELECT ${[...select, `${aggregate} AS n`].join(", ")}`,
    `FROM ${table}`,
    `WHERE ${where.join(" AND ")}`,
    groups.length ? `GROUP BY ${groups.join(", ")}` : "",
    groups.length ? `ORDER BY n DESC LIMIT 100` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type OutcomeCount = { outcome: string; count: number };
export type KindOutcomeCount = { kind: string; outcome: string; count: number };
export type ReasonCount = { reason: string; count: number };

const outcomeRow = (row: { outcome?: unknown; n?: unknown }): OutcomeCount => ({
  outcome: String(row.outcome ?? ""),
  count: num(row.n),
});
const kindOutcomeRow = (row: { kind?: unknown; outcome?: unknown; n?: unknown }): KindOutcomeCount => ({
  kind: String(row.kind ?? ""),
  outcome: String(row.outcome ?? ""),
  count: num(row.n),
});
const reasonRow = (row: { reason?: unknown; n?: unknown }): ReasonCount => ({
  reason: String(row.reason ?? ""),
  count: num(row.n),
});

// ── the named queries ─────────────────────────────────────────────────────────────────────────

/** Scan verdicts in the last 24 h: `scan{outcome}` by outcome and kind. */
export async function verdictCounts24h(env: MetricsQueryEnv, fetcher?: typeof fetch) {
  return mapRows(
    await runSql(env, countsSql(env, "scan", "1 DAY", ["blob2", "blob3"]), fetcher),
    kindOutcomeRow,
  );
}

/**
 * Bytes in (uploads completed, `upload{outcome:"ok"}`) and out (file-host answers,
 * `download{outcome:"2xx"}`) in the last 24 h: the SUM of the value. CAVEAT (report item, T27):
 * today both emission points write the default value 1 (routes/uploads.ts, files-host.ts), so
 * until they pass the byte count this figure is a COUNT of uploads and downloads, not bytes.
 */
export async function bytesInOut24h(
  env: MetricsQueryEnv,
  fetcher?: typeof fetch,
): Promise<QueryResult<{ direction: "in" | "out"; bytes: number }>> {
  const { table, environment } = scopeOf(env);
  const sqlText = [
    `SELECT index1 AS name, SUM(_sample_interval * double1) AS n`,
    `FROM ${table}`,
    `WHERE ((index1 = 'upload' AND blob2 = 'ok') OR (index1 = 'download' AND blob2 = '2xx')) AND blob6 = ${literal(environment)} AND ${since("1 DAY")}`,
    `GROUP BY index1`,
  ].join("\n");
  return mapRows(await runSql<{ name?: unknown; n?: unknown }>(env, sqlText, fetcher), (row) => ({
    direction: row.name === "upload" ? ("in" as const) : ("out" as const),
    bytes: num(row.n),
  }));
}

/** Requests by outcome class (`2xx`, `4xx`, `5xx`, …) in the last hour: the error rate's parts. */
export async function errorRate1h(env: MetricsQueryEnv, fetcher?: typeof fetch) {
  return mapRows(await runSql(env, countsSql(env, "request", "1 HOUR", ["blob2"]), fetcher), outcomeRow);
}

/** The last time a nightly export completed and was verified (`job{kind:backup,outcome:ok}`), within 35 days. */
export async function backupLastOk(
  env: MetricsQueryEnv,
  fetcher?: typeof fetch,
): Promise<QueryResult<{ at: string | null }>> {
  const { table, environment } = scopeOf(env);
  const sqlText = [
    `SELECT MAX(timestamp) AS at`,
    `FROM ${table}`,
    `WHERE index1 = 'job' AND blob3 = 'backup' AND blob2 = 'ok' AND blob6 = ${literal(environment)} AND ${since("35 DAY")}`,
  ].join("\n");
  return mapRows(await runSql<{ at?: unknown }>(env, sqlText, fetcher), (row) => ({
    at: typeof row.at === "string" && row.at !== "" && !row.at.startsWith("1970-") ? row.at : null,
  }));
}

/**
 * The "no operator recipient" alarm (review ruling B2; brief R-12): a critical operator mail — the
 * suspected-CSAM alert first — that had nobody to go to. Metric `error{kind:"csam_alert",
 * reason:"no_recipient"}` (services/scanning.ts). Any non-zero count is an incident.
 */
export async function noOperatorRecipient24h(env: MetricsQueryEnv, fetcher?: typeof fetch) {
  return mapRows(
    await runSql(env, countsSql(env, "error", "1 DAY", ["blob4"], ["blob3 = 'csam_alert'"]), fetcher),
    reasonRow,
  );
}

/** Critical operator mails that failed or were lost (`email{outcome: critical_failed | critical_lost}`), by kind. */
export async function criticalMailFailures24h(env: MetricsQueryEnv, fetcher?: typeof fetch) {
  return mapRows(
    await runSql(
      env,
      countsSql(env, "email", "1 DAY", ["blob2", "blob3"], ["blob2 IN ('critical_failed', 'critical_lost')"]),
      fetcher,
    ),
    kindOutcomeRow,
  );
}

/**
 * DLQ messages acked because their key has no node (`scan{outcome:"dlq", reason}`), by reason,
 * per day over 7 days is what the alert reads; this is the 24 h total. `no_node` is abandoned
 * uploads (a trickle is normal); `timeout` / `engine` are real failures.
 */
export async function scanDlq24h(env: MetricsQueryEnv, fetcher?: typeof fetch) {
  return mapRows(
    await runSql(env, countsSql(env, "scan", "1 DAY", ["blob4"], ["blob2 = 'dlq'"]), fetcher),
    reasonRow,
  );
}

/** Uploads refused at the kept-bytes backstop in the last 24 h (`upload{outcome:"hold_backstop"}`). */
export async function holdBackstop24h(
  env: MetricsQueryEnv,
  fetcher?: typeof fetch,
): Promise<QueryResult<{ count: number }>> {
  return mapRows(
    await runSql<{ n?: unknown }>(
      env,
      countsSql(env, "upload", "1 DAY", [], ["blob2 = 'hold_backstop'"]),
      fetcher,
    ),
    (row) => ({ count: num(row.n) }),
  );
}

/** Job outcomes in the last 24 h, by job (`job{kind,outcome}`). */
export async function jobOutcomes24h(env: MetricsQueryEnv, fetcher?: typeof fetch) {
  return mapRows(
    await runSql(env, countsSql(env, "job", "1 DAY", ["blob3", "blob2"]), fetcher),
    kindOutcomeRow,
  );
}

/** Deferred work abandoned at the drain deadline (`error{kind:"deferred_abandoned"}`, value = tasks) in 24 h. */
export async function deferredAbandoned24h(
  env: MetricsQueryEnv,
  fetcher?: typeof fetch,
): Promise<QueryResult<{ count: number }>> {
  return mapRows(
    await runSql<{ n?: unknown }>(
      env,
      countsSql(
        env,
        "error",
        "1 DAY",
        [],
        ["blob3 = 'deferred_abandoned'"],
        "SUM(_sample_interval * double1)",
      ),
      fetcher,
    ),
    (row) => ({ count: num(row.n) }),
  );
}

/** Every named query, for the catalogue and the tests. */
export const NAMED_QUERIES = {
  verdictCounts24h,
  bytesInOut24h,
  errorRate1h,
  backupLastOk,
  noOperatorRecipient24h,
  criticalMailFailures24h,
  scanDlq24h,
  holdBackstop24h,
  jobOutcomes24h,
  deferredAbandoned24h,
} as const;
