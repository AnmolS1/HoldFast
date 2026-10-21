// POST /api/public/csp-report (T26 item 2): attacker-controlled input. Both report formats are
// counted under the violated directive's NAME (a fixed list, else `other`); the body is capped at
// 8 KB while it streams; the Sentry message is sampled and its URIs and sample are redacted;
// nothing reads a session or sets a cookie; the answer is 204 whatever was sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { directiveTag, MAX_REPORT_BYTES } from "../../../src/worker/routes/csp-report";
import { metric } from "../../../src/worker/services/metrics";
import { redactText } from "../../../src/shared/sentry-redact";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { ALLOW_ALL, appWith, fakeCore, fakeCtx, testEnv } from "../worker-core/helpers";

const sentry = vi.hoisted(() => ({
  messages: [] as Array<{
    message: string;
    level: unknown;
    tags: Record<string, string>;
    contexts: Record<string, unknown>;
  }>,
}));

vi.mock("@sentry/cloudflare", async (original) => {
  const real = await original<typeof import("@sentry/cloudflare")>();
  return {
    ...real,
    withScope: (callback: (scope: unknown) => void) => {
      const tags: Record<string, string> = {};
      const contexts: Record<string, unknown> = {};
      const scope = {
        setTag: (key: string, value: string) => void (tags[key] = value),
        setContext: (key: string, value: unknown) => void (contexts[key] = value),
      };
      callback(scope);
      const last = sentry.messages.at(-1);
      if (last && !last.tags.csp_directive) Object.assign(last, { tags, contexts });
    },
    captureMessage: (message: string, level: unknown) =>
      void sentry.messages.push({ message, level, tags: {}, contexts: {} }),
  };
});

vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn() };
});

const PATH = "/api/public/csp-report";
const LINK_TOKEN = "Zt4kQ9wPxR7mN2vB8cL5hJ3sD6fG1aYe";
const DOC = `${TEST_APP_ORIGIN}/s/${LINK_TOKEN}?k=secret-query-value`;

beforeEach(() => {
  vi.mocked(metric).mockClear();
  sentry.messages.length = 0;
  vi.restoreAllMocks();
});

type Post = {
  body: BodyInit | null;
  type?: string;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
};

async function post({ body, type = "application/csp-report", headers = {}, env = {} }: Post) {
  const fake = fakeCore();
  const ctx = fakeCtx();
  const request = new Request(`${TEST_APP_ORIGIN}${PATH}`, {
    method: "POST",
    headers: { "content-type": type, ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const response = await appWith(fake).fetch(request, testEnv({ ...ALLOW_ALL, ...env }), ctx);
  const text = await response.text();
  await ctx.settle();
  return { response, text, fake };
}

const legacy = (fields: Record<string, unknown>) => JSON.stringify({ "csp-report": fields });
const metricReasons = () => vi.mocked(metric).mock.calls.map(([name, tags]) => `${name}:${tags?.reason}`);

/** A body that arrives in pieces and declares no length. */
function streamOf(text: string, piece = 1000): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + piece));
      offset += piece;
    },
  });
}

describe("accepted reports", () => {
  it("application/csp-report: 204, one metric under the directive name", async () => {
    const { response, text } = await post({
      body: legacy({ "document-uri": DOC, "violated-directive": "script-src-elem", "blocked-uri": "inline" }),
    });
    expect(response.status).toBe(204);
    expect(text).toBe("");
    expect(metricReasons()).toEqual(["csp:script-src-elem"]);
  });

  it("application/reports+json: every csp-violation of the batch, nothing of the other report types", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: { effectiveDirective: "style-src-elem", documentURL: DOC, sample: ".a{}" },
      },
      { type: "deprecation", body: { id: "x" } },
      { type: "csp-violation", body: { effectiveDirective: "worker-src", documentURL: DOC } },
    ]);
    const { response } = await post({ body, type: "application/reports+json" });
    expect(response.status).toBe(204);
    expect(metricReasons()).toEqual(["csp:style-src-elem", "csp:worker-src"]);
  });

  it("the legacy violated-directive with its policy text counts as its first token; effective-directive wins", async () => {
    await post({ body: legacy({ "violated-directive": "script-src 'nonce-abc' 'strict-dynamic'" }) });
    await post({
      body: legacy({ "violated-directive": "default-src 'self'", "effective-directive": "img-src" }),
    });
    expect(metricReasons()).toEqual(["csp:script-src", "csp:img-src"]);
  });
});

describe("the reason tag is a directive name from a fixed list, never the sender's text", () => {
  it.each([
    ["script-src", "script-src"],
    ["STYLE-SRC-ATTR", "style-src-attr"],
    ["frame-ancestors", "frame-ancestors"],
    [`https://evil.example/${LINK_TOKEN}`, "other"],
    ["script-src-evil", "other"],
    ["a".repeat(500), "other"],
    ["", "other"],
    [42, "other"],
    [null, "other"],
  ])("%s → %s", (raw, tag) => {
    expect(directiveTag(raw)).toBe(tag);
  });

  it("through the endpoint: an unknown directive is `other`, and nothing of it reaches the metric", async () => {
    await post({ body: legacy({ "violated-directive": `${DOC} injected` }) });
    expect(vi.mocked(metric).mock.calls).toEqual([["csp", { reason: "other" }]]);
  });
});

describe("the body cap: 8 KB, counted while it streams", () => {
  const padded = (bytes: number) => {
    const base = legacy({ "violated-directive": "img-src", "document-uri": DOC, "script-sample": "" });
    const fill = bytes - base.length;
    return legacy({
      "violated-directive": "img-src",
      "document-uri": DOC,
      "script-sample": "x".repeat(fill),
    });
  };

  it("exactly 8192 bytes is read; 8193 is dropped — with and without a declared length", async () => {
    expect(new TextEncoder().encode(padded(MAX_REPORT_BYTES)).length).toBe(8192);
    await post({ body: padded(MAX_REPORT_BYTES) });
    await post({ body: streamOf(padded(MAX_REPORT_BYTES)) });
    expect(metricReasons()).toEqual(["csp:img-src", "csp:img-src"]);
    vi.mocked(metric).mockClear();

    for (const body of [padded(MAX_REPORT_BYTES + 1), streamOf(padded(MAX_REPORT_BYTES + 1))]) {
      const { response } = await post({ body });
      expect(response.status).toBe(204);
    }
    // A lying Content-Length changes nothing: the bytes are counted.
    const { response } = await post({ body: streamOf(padded(20_000)), headers: { "content-length": "100" } });
    expect(response.status).toBe(204);
    expect(metricReasons()).toEqual([]);
  });

  it("a long body is not read to its end", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const { response } = await post({ body: endless });
    expect(response.status).toBe(204);
    expect(pulled).toBeLessThan(20);
  });
});

describe("malformed input is dropped silently", () => {
  it.each([
    ["not json", "application/csp-report"],
    ["[]", "application/csp-report"],
    ['{"csp-report": "x"}', "application/csp-report"],
    ['{"csp-report": {"violated-directive": "img-src"}}', "application/json"],
    ['{"csp-report": {"violated-directive": "img-src"}}', "text/plain"],
    ["{}", "application/reports+json"],
    ['[{"type":"csp-violation","body":"x"}]', "application/reports+json"],
    ["", "application/csp-report"],
  ])("%s as %s → 204, no metric (or `other` only for a report with no body)", async (body, type) => {
    const { response, text } = await post({ body, type });
    expect(response.status).toBe(204);
    expect(text).toBe("");
    expect(metricReasons().filter((reason) => reason !== "csp:other")).toEqual([]);
  });
});

describe("Sentry: sampled, redacted", () => {
  const report = legacy({
    "document-uri": DOC,
    referrer: `${TEST_APP_ORIGIN}/invite/abcdefghijklmnop?ref=mail`,
    "blocked-uri": `https://evil.example/collect?session=${LINK_TOKEN}`,
    "violated-directive": "connect-src",
    "script-sample": `fetch("/s/${LINK_TOKEN}")`,
  });

  it("a sampled report goes as a message whose every URI and sample are redacted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await post({ body: report });
    expect(sentry.messages).toHaveLength(1);
    const [message] = sentry.messages;
    expect(message!.message).toBe("CSP violation: connect-src");
    expect(message!.tags).toEqual({ csp_directive: "connect-src" });
    const sent = JSON.stringify(message);
    expect(sent).not.toContain(LINK_TOKEN);
    expect(sent).not.toContain("secret-query-value");
    expect(sent).not.toContain("abcdefghijklmnop");
    expect(message!.contexts.csp).toEqual({
      documentUri: redactText(DOC),
      blockedUri: redactText(`https://evil.example/collect?session=${LINK_TOKEN}`),
      referrer: redactText(`${TEST_APP_ORIGIN}/invite/abcdefghijklmnop?ref=mail`),
      sample: redactText(`fetch("/s/${LINK_TOKEN}")`),
    });
  });

  it("an unsampled report is counted and not sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await post({ body: report });
    expect(sentry.messages).toEqual([]);
    expect(metricReasons()).toEqual(["csp:connect-src"]);
  });
});

describe("no session, no cookie, limited by address", () => {
  it("never reads a session or opens the database, never sets a cookie — even with a session cookie sent", async () => {
    const { response, fake } = await post({
      body: legacy({ "violated-directive": "img-src" }),
      headers: {
        cookie: "hf.session_token=made-up-test-value",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("RL_API keyed by the client's address", async () => {
    const keys: string[] = [];
    const RL_API = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    };
    await post({
      body: legacy({ "violated-directive": "img-src" }),
      headers: { "cf-connecting-ip": "203.0.113.7" },
      env: { RL_API },
    });
    expect(keys).toEqual(["ip:203.0.113.7"]);
  });
});
