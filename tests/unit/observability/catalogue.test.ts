// T27 Part B — the catalogue re-audit as a test: every literal a named Analytics Engine query
// filters on (`metrics-queries.ts`) is one the code really emits. A query that reads a name or a
// tag value nothing writes answers zeros forever and looks healthy; this file goes red instead.
//
// Two directions:
//  - each PIN below is checked against the SQL its query sends (a mocked fetch — no request leaves),
//    and every `blobN = '…'` / `IN (…)` literal any query sends is covered by a pin;
//  - each pin has an emitter: a `metric` / `writeMetric` / `countFor` / `bg.metric` call in
//    `src/worker` (comment lines left out) with that name and every one of the pin's tags.
import { describe, expect, it, vi } from "vitest";
import { NAMED_QUERIES } from "../../../src/worker/services/metrics-queries";

const sources = import.meta.glob("/src/worker/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The code without its comment LINES, so a sentence that names a metric is not an emitter. */
const code = (text: string) => text.replace(/^\s*(\/\/|\/\*|\*).*$/gm, "");

const BLOB = { outcome: "blob2", kind: "blob3", reason: "blob4" } as const;
type Tag = keyof typeof BLOB;
type Pin = { name: string; tags: Partial<Record<Tag, string>>; via?: RegExp };

const PINS: Record<keyof typeof NAMED_QUERIES, Pin[]> = {
  verdictCounts24h: [{ name: "scan", tags: {} }],
  bytesInOut24h: [
    { name: "upload", tags: { outcome: "ok" } },
    // files-host's `outcomeOf(status)` computes "2xx" (its definition is checked below).
    {
      name: "download",
      tags: { outcome: "2xx" },
      via: /metric\(\s*"download",\s*\{[^}]*outcome:\s*outcomeOf\(/,
    },
  ],
  errorRate1h: [{ name: "request", tags: {} }],
  backupLastOk: [{ name: "job", tags: { kind: "backup", outcome: "ok" } }],
  noOperatorRecipient24h: [{ name: "error", tags: { kind: "csam_alert", reason: "no_recipient" } }],
  criticalMailFailures24h: [
    { name: "email", tags: { outcome: "critical_failed" } },
    { name: "email", tags: { outcome: "critical_lost" } },
  ],
  scanDlq24h: [
    { name: "scan", tags: { outcome: "dlq", reason: "no_node" } },
    { name: "scan", tags: { outcome: "dlq", reason: "requeued" } },
  ],
  holdBackstop24h: [{ name: "upload", tags: { outcome: "hold_backstop" } }],
  jobOutcomes24h: [{ name: "job", tags: {} }],
  deferredAbandoned24h: [{ name: "error", tags: { kind: "deferred_abandoned" } }],
  // The request line's outcome is computed the same way (`${Math.floor(status / 100)}xx`).
  requestTiles1h: [
    {
      name: "request",
      tags: { outcome: "5xx" },
      via: /writeMetric\(c\.env, "request", \{\s*outcome: `\$\{Math\.floor\(status \/ 100\)\}xx`/,
    },
  ],
};

const configured = {
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", // made up
  CF_ANALYTICS_TOKEN: "made-up-analytics-token-for-tests", // made up
  SENTRY_ENVIRONMENT: "dev",
};

async function sqlOf(query: (typeof NAMED_QUERIES)[keyof typeof NAMED_QUERIES]): Promise<string> {
  const fetcher = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ meta: [], data: [], rows: 0 }),
  );
  await query(configured, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  return String(fetcher.mock.calls[0]![1]!.body);
}

/** Every metric call in the Worker: its name and its tag object's text. */
function emitters(): Array<{ file: string; name: string; tags: string; text: string }> {
  const out: Array<{ file: string; name: string; tags: string; text: string }> = [];
  const call =
    /\b(?:metric|writeMetric|countFor)\(\s*(?:[\w.]+(?:\s+as\s+[^,]+)?,\s*)?"([a-z]+)",\s*\{([^}]*)\}/g;
  for (const [file, text] of Object.entries(sources)) {
    for (const match of code(text).matchAll(call)) {
      out.push({ file, name: match[1]!, tags: match[2]!, text: match[0] });
    }
  }
  return out;
}

const hasTag = (tags: string, tag: Tag, value: string) => new RegExp(`\\b${tag}:\\s*"${value}"`).test(tags);

describe("the named queries read what the code emits", () => {
  it("the scan sees the Worker's emitters (control: the backup job's ok and the DLQ's no_node are found)", () => {
    const all = emitters();
    expect(all.length).toBeGreaterThan(100);
    expect(
      all.some(
        (e) => e.name === "job" && hasTag(e.tags, "kind", "backup") && hasTag(e.tags, "outcome", "ok"),
      ),
    ).toBe(true);
    // The consumer's multi-line `bg.metric(\n "scan", …)` is found too.
    expect(
      all.some(
        (e) => e.file.endsWith("scan/consumer.ts") && e.name === "scan" && /applied\.stale/.test(e.tags),
      ),
    ).toBe(true);
  });

  // Over the QUERIES, not the pins: a new named query without pins goes red here.
  it.each(Object.keys(NAMED_QUERIES) as Array<keyof typeof NAMED_QUERIES>)(
    "%s: its pins are what its SQL filters on, and nothing it filters on is unpinned",
    async (query) => {
      const sql = await sqlOf(NAMED_QUERIES[query]);
      const names = [...sql.matchAll(/index1 = '([a-z]+)'/g)].map((m) => m[1]);
      expect(new Set(names)).toEqual(new Set((PINS[query] ?? []).map((pin) => pin.name)));
      const filtered = new Set<string>();
      for (const m of sql.matchAll(/(blob[2-4]) = '([a-z0-9_]+)'/g)) filtered.add(`${m[1]}=${m[2]}`);
      for (const m of sql.matchAll(/(blob[2-4]) IN \(([^)]*)\)/g)) {
        for (const v of m[2]!.matchAll(/'([a-z0-9_]+)'/g)) filtered.add(`${m[1]}=${v[1]}`);
      }
      const pinned = new Set<string>();
      for (const pin of PINS[query] ?? []) {
        for (const [tag, value] of Object.entries(pin.tags) as Array<[Tag, string]>) {
          // `IN` lists and per-reason pins: a pinned value the SQL only groups by (no filter) is fine
          // for `reason` (scanDlq24h groups by it); anything else must be in the SQL.
          if (!filtered.has(`${BLOB[tag]}=${value}`) && !(tag === "reason" && sql.includes("blob4")))
            throw new Error(`${query}: pin ${pin.name}{${tag}:"${value}"} is not in its SQL`);
          pinned.add(`${BLOB[tag]}=${value}`);
        }
      }
      for (const filter of filtered) expect(pinned, `${query} filters ${filter} unpinned`).toContain(filter);
    },
  );

  it.each(
    Object.entries(PINS).flatMap(([query, pins]) =>
      pins.map((pin) => [`${query} ← ${pin.name}${JSON.stringify(pin.tags)}`, pin] as const),
    ),
  )("%s has an emitter in src/worker", (_label, pin) => {
    const all = emitters();
    const found = pin.via
      ? Object.values(sources).some((text) => pin.via!.test(code(text)))
      : all.some(
          (e) =>
            e.name === pin.name &&
            (Object.entries(pin.tags) as Array<[Tag, string]>).every(([tag, value]) =>
              hasTag(e.tags, tag, value),
            ),
        );
    expect(found).toBe(true);
  });

  it("files-host's outcomeOf computes the status class the download pin reads ('2xx')", () => {
    const host = Object.entries(sources).find(([file]) => file.endsWith("/src/worker/files-host.ts"))![1];
    expect(code(host)).toMatch(
      /function outcomeOf\(status: number\): string \{\s*return `\$\{Math\.floor\(status \/ 100\)\}xx`;/,
    );
  });
});
