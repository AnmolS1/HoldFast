// The `node` metric (folder and file operations of the nodes API) in the one positional layout.
import { describe, expect, it } from "vitest";
import { metric, writeMetric, type MetricName } from "../../../src/worker/services/metrics";

describe("the node metric", () => {
  it("is a metric name and is written in the fixed layout, with its tags in their columns", () => {
    const name: MetricName = "node";
    const points: unknown[] = [];
    const METRICS = {
      writeDataPoint: (point: unknown) => points.push(point),
    } as unknown as AnalyticsEngineDataset;
    writeMetric({ METRICS, SENTRY_ENVIRONMENT: "test" }, name, { kind: "move", outcome: "refused" });
    expect(points).toEqual([
      { indexes: ["node"], blobs: ["node", "refused", "move", "", "", "test"], doubles: [1, 0] },
    ]);
    expect(() => metric("node", { kind: "move", outcome: "refused" })).not.toThrow();
  });

  it("the tag rules hold for it: a tag is cut at 96 characters and a non-string tag is dropped", () => {
    const points: Array<{ blobs: string[] }> = [];
    const METRICS = {
      writeDataPoint: (point: { blobs: string[] }) => points.push(point),
    } as unknown as AnalyticsEngineDataset;
    writeMetric({ METRICS }, "node", { kind: "m".repeat(200), outcome: 7 as unknown as string });
    expect(points[0]!.blobs).toEqual(["node", "", "m".repeat(96), "", "", ""]);
  });
});
