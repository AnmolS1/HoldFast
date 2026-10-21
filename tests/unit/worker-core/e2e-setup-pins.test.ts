// The e2e global setup deletes the rollback detector's object from the local bucket with every
// database reset (tests/setup/e2e-global-setup.ts). It names the bucket and the key as literals (it
// runs in Node, outside the Worker's module graph): they must be the Worker's own.
import { describe, expect, it } from "vitest";
import { GENERATION_KEY } from "../../../src/worker/jobs/reconcile";
import setupSource from "../../setup/e2e-global-setup.ts?raw";
import wranglerConfig from "../../../wrangler.jsonc?raw";

const literal = (name: string): string | undefined =>
  new RegExp(`export const ${name} = "([^"]+)";`).exec(setupSource)?.[1];

describe("e2e global setup: the rollback detector's object it deletes", () => {
  it("is the Worker's GENERATION_KEY", () => {
    expect(literal("GENERATION_OBJECT")).toBe(GENERATION_KEY);
  });

  it("in the local bucket of wrangler.jsonc's top-level FILES binding", () => {
    // The first r2_buckets entry is the top level (the named environments come after it).
    const bucket = /"r2_buckets":\s*\[\{\s*"binding":\s*"FILES",\s*"bucket_name":\s*"([^"]+)"/.exec(
      wranglerConfig,
    )?.[1];
    expect(bucket).toBeDefined();
    expect(literal("LOCAL_BUCKET")).toBe(bucket);
  });
});
