// The Analytics Engine queries, with a mocked `fetch` — no test reaches the network. The account id
// and token here are made up. The "recorded" response is built from the documented `FORMAT JSON`
// shape (meta / data / rows / rows_before_limit_at_least — developers.cloudflare.com/analytics/
// sql-api/query-api, read 2026-10-21) with ClickHouse's quoted 64-bit integers: no real account
// was queried (the token is a HUMAN step; a real reading is post-integration).
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  NAMED_QUERIES,
  SQL_API_URL,
  verdictCounts24h,
  backupLastOk,
  noOperatorRecipient24h,
} from "../../../src/worker/services/metrics-queries";

const ACCOUNT = "0123456789abcdef0123456789abcdef"; // made up
const TOKEN = "made-up-analytics-token-for-tests"; // made up
const configured = { CF_ACCOUNT_ID: ACCOUNT, CF_ANALYTICS_TOKEN: TOKEN, SENTRY_ENVIRONMENT: "dev" };

const RECORDED_VERDICTS = {
  meta: [
    { name: "outcome", type: "String" },
    { name: "kind", type: "String" },
    { name: "n", type: "UInt64" },
  ],
  data: [
    { outcome: "clean", kind: "stub", n: "41" },
    { outcome: "infected", kind: "stub", n: "2" },
  ],
  rows: 2,
  rows_before_limit_at_least: 2,
};

function recorder(answer: () => Response | Promise<Response>) {
  // Typed like fetch, so the calls' URL and init can be read back.
  return vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => answer());
}

describe("not configured → { available: false }, and no request", () => {
  it("the test environment's token is empty: unavailable, never zeros", async () => {
    // The test vars set CF_ANALYTICS_TOKEN to "" (tests/setup/test-vars.ts).
    expect(env.CF_ANALYTICS_TOKEN).toBe("");
    const fetcher = recorder(() => Response.json(RECORDED_VERDICTS));
    expect(await verdictCounts24h(env, fetcher)).toEqual({ available: false, reason: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["no account id", { CF_ANALYTICS_TOKEN: TOKEN }],
    ["no token", { CF_ACCOUNT_ID: ACCOUNT }],
    ["blank token", { CF_ACCOUNT_ID: ACCOUNT, CF_ANALYTICS_TOKEN: "   " }],
  ])("%s: every named query answers unavailable without a request", async (_label, partial) => {
    const fetcher = recorder(() => Response.json(RECORDED_VERDICTS));
    for (const [name, query] of Object.entries(NAMED_QUERIES)) {
      expect(await query(partial, fetcher), name).toEqual({ available: false, reason: "not_configured" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("configured", () => {
  it("verdictCounts24h POSTs one SQL text with the bearer token and parses the recorded response", async () => {
    const fetcher = recorder(() => Response.json(RECORDED_VERDICTS));
    const result = await verdictCounts24h(configured, fetcher);
    expect(result).toEqual({
      available: true,
      rows: [
        { kind: "stub", outcome: "clean", count: 41 },
        { kind: "stub", outcome: "infected", count: 2 },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(SQL_API_URL(ACCOUNT));
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const sqlText = String(init?.body);
    // The dev dataset, its own rows, the sampled count, a lower time bound, the JSON format.
    expect(sqlText).toContain("FROM holdfast_metrics_dev");
    expect(sqlText).toContain("index1 = 'scan'");
    expect(sqlText).toContain("blob6 = 'dev'");
    expect(sqlText).toContain("SUM(_sample_interval)");
    expect(sqlText).toContain("timestamp > NOW() - INTERVAL '1' DAY");
    expect(sqlText.trim().endsWith("FORMAT JSON")).toBe(true);
  });

  it("production reads its own dataset and rows", async () => {
    const fetcher = recorder(() => Response.json({ data: [] }));
    await verdictCounts24h({ ...configured, SENTRY_ENVIRONMENT: "production" }, fetcher);
    const sqlText = String(fetcher.mock.calls[0]![1]?.body);
    expect(sqlText).toContain("FROM holdfast_metrics\n");
    expect(sqlText).toContain("blob6 = 'production'");
  });

  it("the no-recipient alarm reads error{kind:csam_alert} by reason (brief R-12: the real name)", async () => {
    const fetcher = recorder(() => Response.json({ data: [{ reason: "no_recipient", n: 1 }] }));
    expect(await noOperatorRecipient24h(configured, fetcher)).toEqual({
      available: true,
      rows: [{ reason: "no_recipient", count: 1 }],
    });
    const sqlText = String(fetcher.mock.calls[0]![1]?.body);
    expect(sqlText).toContain("index1 = 'error'");
    expect(sqlText).toContain("blob3 = 'csam_alert'");
  });

  it("backupLastOk: no export in the window reads null, not a date", async () => {
    const fetcher = recorder(() => Response.json({ data: [{ at: "1970-01-01 00:00:00" }] }));
    expect(await backupLastOk(configured, fetcher)).toEqual({ available: true, rows: [{ at: null }] });
  });

  it.each([
    ["a 403", () => new Response("forbidden", { status: 403 }), "request_failed"],
    ["a 500", () => new Response("oops", { status: 500 }), "request_failed"],
    ["a network failure", () => Promise.reject(new TypeError("network")), "request_failed"],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), "bad_response"],
    ["JSON without data", () => Response.json({ errors: ["x"] }), "bad_response"],
    ["data that is not rows", () => Response.json({ data: [1, 2] }), "bad_response"],
  ] as const)("%s → unavailable after exactly ONE request (no retry)", async (_label, answer, reason) => {
    for (const [name, query] of Object.entries(NAMED_QUERIES)) {
      const fetcher = recorder(answer as () => Response | Promise<Response>);
      expect(await query(configured, fetcher), name).toEqual({ available: false, reason });
      expect(fetcher, name).toHaveBeenCalledTimes(1);
    }
  });

  it("every named query makes exactly one request per call", async () => {
    for (const [name, query] of Object.entries(NAMED_QUERIES)) {
      const fetcher = recorder(() => Response.json({ data: [] }));
      const result = await query(configured, fetcher);
      expect(result.available, name).toBe(true);
      expect(fetcher, name).toHaveBeenCalledTimes(1);
    }
  });

  it("review minor 7: a row whose count is not a number reads as bad_response, never as a zero", async () => {
    const fetcher = recorder(() => Response.json({ data: [{ outcome: "clean", kind: "stub", n: "lots" }] }));
    expect(await verdictCounts24h(configured, fetcher)).toEqual({ available: false, reason: "bad_response" });
  });

  it("review minor 8: an environment that is neither dev nor production is not configured — no request", async () => {
    for (const SENTRY_ENVIRONMENT of ["staging", "test", "", undefined]) {
      const fetcher = recorder(() => Response.json(RECORDED_VERDICTS));
      expect(
        await verdictCounts24h({ ...configured, SENTRY_ENVIRONMENT }, fetcher),
        String(SENTRY_ENVIRONMENT),
      ).toEqual({
        available: false,
        reason: "not_configured",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});
