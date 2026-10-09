// Proves the Workers test project boots against the full wrangler.jsonc and that each local
// simulation the later tasks rely on is really there.
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { pngBytes } from "../../../setup/fixture-bytes";
import { TEST_APP_ORIGIN, TEST_FILES_ORIGIN, testVars, type TestVarName } from "../../../setup/test-vars";
import { WARM_UP_TIMEOUT_MS, warmWorker } from "./warm-up";

// The Worker entry is loaded here, under its own limit; the tests below are timed on requests.
beforeAll(warmWorker, WARM_UP_TIMEOUT_MS);

describe("workers project", () => {
  it("runs inside workerd", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("has every binding from wrangler.jsonc", () => {
    expect(env.HYPERDRIVE).toBeDefined();
    expect(env.FILES).toBeDefined();
    expect(env.SCAN_QUEUE).toBeDefined();
    expect(env.IMAGES).toBeDefined();
    expect(env.METRICS).toBeDefined();
    expect(env.ASSETS).toBeDefined();
    expect(env.SCANNER).toBeDefined();
    for (const limiter of [env.RL_AUTH, env.RL_API, env.RL_FILES, env.RL_LINKS]) {
      expect(limiter).toBeDefined();
    }
  });

  it("gets its vars from the explicit test values, not from .dev.vars", () => {
    const seen = env as unknown as Record<string, unknown>;
    for (const name of Object.keys(testVars) as TestVarName[]) {
      // Compared without printing: a mismatch must not put a real value in the test output.
      expect(seen[name] === testVars[name], `${name} is not the test value`).toBe(true);
    }
  });

  it("keeps the public vars from wrangler.jsonc", () => {
    expect(env.MAX_FILE_BYTES).toBe("2000000000");
    expect(env.PART_BYTES).toBe("67108864");
  });

  it("points Hyperdrive at this checkout's local database", () => {
    expect(env.HYPERDRIVE.database).toBe(inject("holdfastDb"));
    expect(env.HYPERDRIVE.user).toBe("postgres");
    expect(env.HYPERDRIVE.connectionString).toContain(`/${inject("holdfastDb")}`);
  });

  it("stores and reads an object in local R2", async () => {
    const key = `harness/${crypto.randomUUID()}`;
    await env.FILES.put(key, "hello");
    const object = await env.FILES.get(key);
    expect(await object?.text()).toBe("hello");
    await env.FILES.delete(key);
    expect(await env.FILES.head(key)).toBeNull();
  });

  it("accepts a message on the scan queue", async () => {
    // Delivery to the consumer is not observable from here (the handler acks and does nothing).
    await expect(env.SCAN_QUEUE.send({ harness: crypto.randomUUID() })).resolves.toBeDefined();
  });

  it("answers a rate-limit check", async () => {
    const outcome = await env.RL_API.limit({ key: `harness-${crypto.randomUUID()}` });
    expect(outcome.success).toBe(true);
  });

  it("writes an Analytics Engine data point without throwing", () => {
    expect(() =>
      env.METRICS.writeDataPoint({ blobs: ["harness"], doubles: [1], indexes: ["harness"] }),
    ).not.toThrow();
  });

  it("dispatches on the host: app, files host, anything else", async () => {
    // The Worker boots and answers on the app host. /__meta, not /api/health: health depends on
    // the database and has its own tests.
    const meta = await exports.default.fetch(`${TEST_APP_ORIGIN}/__meta`);
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await meta.json()).toMatchObject({ project: "holdfast" });

    // The SPA shell: any unknown path on the app host falls back to index.html.
    const shell = await exports.default.fetch(`${TEST_APP_ORIGIN}/some/deep/link`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await shell.text()).toContain('data-harness="test-shell"');

    const files = await exports.default.fetch(`${TEST_FILES_ORIGIN}/`);
    expect(files.status).toBe(404);
    expect(files.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(files.headers.get("set-cookie")).toBeNull();
    await files.text();

    const other = await exports.default.fetch("http://127.0.0.1/");
    expect(other.status).toBe(421);
    await other.text();
  });
});

describe("fixtures in workerd", () => {
  it("reads the generated PNG with the local Images simulation", async () => {
    const png = pngBytes(64, 32);
    const info = await env.IMAGES.info(new Blob([png]).stream());
    expect(info).toMatchObject({ format: "image/png", width: 64, height: 32 });
  });
});
