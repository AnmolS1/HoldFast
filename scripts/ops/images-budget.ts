// The Images budget, by hand: this month's image transformations from our own ledger (the
// `transform_user` units T13 records per transform performed) against the alarm line and the Free
// plan's limit. The backup job's tail runs the same reading every night and mails the operators at
// the line (jobs/backup.ts `imagesAlarm`; spike S15: no Cloudflare alert can be set at 4,000).
//
//   npx tsx scripts/ops/images-budget.ts                  this UTC month
//   npx tsx scripts/ops/images-budget.ts --month 2026-10
//
// Reads DATABASE_URL_DIRECT (never printed). Writes nothing.

import { parseArgs } from "node:util";
import pg from "pg";

/** jobs/backup.ts IMAGES_ALARM_UNITS — kept equal by hand; this script imports nothing from the Worker. */
const ALARM_UNITS = 4_000;
/** Cloudflare Images Free: unique transformations per month before error 9422. */
const FREE_UNITS = 5_000;

/** Our own words, safe to print; anything else came from the driver and is not. */
class Refusal extends Error {}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { month: { type: "string" } }, strict: true });
  const month = values.month ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Refusal("--month must be YYYY-MM");
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Refusal("DATABASE_URL_DIRECT is not set in this shell");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ units: string }>(
      `SELECT COALESCE(SUM(count), 0)::bigint AS units FROM download_ledger
       WHERE subject_type = 'transform_user' AND day >= $1::date AND day < ($1::date + interval '1 month')`,
      [`${month}-01`],
    );
    const units = Number(rows[0]?.units ?? 0);
    const state =
      units >= FREE_UNITS
        ? "EXHAUSTED (new thumbnails fall back to icons)"
        : units >= ALARM_UNITS
          ? "ALARM"
          : "ok";
    process.stdout.write(
      `${month}\t${units} transformations\tline ${ALARM_UNITS}\tfree ${FREE_UNITS}\t${state}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`images-budget: ${error instanceof Refusal ? error.message : "the reading failed"}\n`);
  process.exitCode = 1;
});
