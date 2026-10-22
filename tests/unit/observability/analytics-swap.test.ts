// The analytics-tiles swap (T27B P-2): the console's dashboard reads its request tiles from
// `analyticsTiles` — unavailable (and no SQL request) without the HUMAN token; with one, the
// tiles from exactly ONE request. `fetch` is spied: no request leaves. The ids are made up.
import { afterEach, expect, it, vi } from "vitest";
import { admin, adminCall } from "../admin/helpers";

afterEach(() => vi.restoreAllMocks());

const sqlCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([url]) => String(url).includes("/analytics_engine/sql"));

it("GET /api/admin/dashboard: analytics unavailable without the token; configured → the tiles from one SQL request", async () => {
  const who = await admin();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  expect((await adminCall(who.as, "GET", "/dashboard")).body.analytics).toEqual({ available: false });
  expect(sqlCalls(fetchSpy)).toHaveLength(0);

  fetchSpy.mockImplementation(async (url) =>
    String(url).includes("/analytics_engine/sql")
      ? Response.json({ data: [{ requests: "600", errors: "3", p95: 40 }] })
      : new Response("not expected in this test", { status: 599 }),
  );
  const answer = await adminCall(who.as, "GET", "/dashboard", {
    env: {
      CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", // made up
      CF_ANALYTICS_TOKEN: "made-up-analytics-token", // made up
      SENTRY_ENVIRONMENT: "dev",
    },
  });
  expect(answer.status).toBe(200);
  expect(answer.body.analytics).toEqual({
    available: true,
    requestsPerMinute: 10,
    errorRate: 0.005,
    p95LatencyMs: 40,
  });
  expect(sqlCalls(fetchSpy)).toHaveLength(1);
});
