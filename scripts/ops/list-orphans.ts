// Lists what reconcile's orphan sweep would delete — READ-ONLY (restore runbook step 5). Rules and
// output: scripts/ops/orphans-core.ts. It deletes nothing and has no option that does.
//
//   npx tsx scripts/ops/list-orphans.ts --bucket holdfast-files-dev
//
// THE OBJECT LISTING needs the R2 S3 API: wrangler has no `r2 object list`. It takes a READ-ONLY
// R2 API token's S3 pair from the environment — R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY —
// and the account from CF_ACCOUNT_ID (a HUMAN step: dashboard → R2 → Manage API tokens →
// "Object Read only", scoped to the one bucket). The database is DATABASE_URL_DIRECT's. None of
// these values is ever printed. (Locally the same listing is proven by
// tests/unit/observability/orphans.test.ts against the local bucket; this S3 path runs only
// against a deployed bucket, and was not run by T27 — no token exists yet.)
//
// Output, tab-separated, one line per unreferenced object: area, key, age in hours, and "sweep"
// when the sweep would take it (≥ 48 h) or "young" when not yet.

import { createHash, createHmac } from "node:crypto";
import { parseArgs } from "node:util";
import pg from "pg";
import { listOrphans, sqlReferences, type Lister } from "./orphans-core";

class Refusal extends Error {}

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Refusal(`${name} is not set in this shell`);
  return value;
};

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** One signed ListObjectsV2 request (AWS Signature V4, region "auto", service "s3"). */
async function listPage(
  bucket: string,
  creds: { account: string; id: string; secret: string },
  prefix: string,
  cursor: string | null,
): Promise<{ objects: Array<{ key: string; uploaded: Date }>; cursor: string | null }> {
  const host = `${creds.account}.r2.cloudflarestorage.com`;
  const params = new URLSearchParams({
    "list-type": "2",
    prefix,
    ...(cursor ? { "continuation-token": cursor } : {}),
  });
  const query = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256("");
  const canonical = [
    "GET",
    `/${bucket}`,
    query,
    `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`,
    "host;x-amz-content-sha256;x-amz-date",
    payload,
  ].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secret}`, day), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const response = await fetch(`https://${host}/${bucket}?${query}`, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${creds.id}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  });
  if (!response.ok) throw new Refusal(`the R2 listing answered ${response.status}`);
  const xml = await response.text();
  const unescape = (text: string) =>
    text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({
    key: unescape(/<Key>([\s\S]*?)<\/Key>/.exec(match[1]!)![1]!),
    uploaded: new Date(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(match[1]!)![1]!),
  }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, cursor: truncated && next ? unescape(next) : null };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { bucket: { type: "string" } }, strict: true });
  if (!values.bucket || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(values.bucket))
    throw new Refusal("--bucket <name> is required");
  const creds = {
    account: need("CF_ACCOUNT_ID"),
    id: need("R2_S3_ACCESS_KEY_ID"),
    secret: need("R2_S3_SECRET_ACCESS_KEY"),
  };
  const client = new pg.Client({ connectionString: need("DATABASE_URL_DIRECT") });
  await client.connect();
  try {
    const lister: Lister = (prefix, cursor) => listPage(values.bucket!, creds, prefix, cursor);
    const refs = sqlReferences({
      query: async (text, params) => ({ rows: (await client.query(text, params)).rows }),
    });
    const orphans = await listOrphans(lister, refs);
    for (const orphan of orphans) {
      process.stdout.write(
        `${orphan.area}\t${orphan.key}\t${orphan.ageHours}\t${orphan.sweepWouldDelete ? "sweep" : "young"}\n`,
      );
    }
    process.stderr.write(`list-orphans: ${orphans.length} unreferenced object(s); nothing was deleted\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`list-orphans: ${error instanceof Refusal ? error.message : "the listing failed"}\n`);
  process.exitCode = 1;
});
