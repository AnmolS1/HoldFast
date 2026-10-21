// The full header set of both hosts (T26 item 12), in the normal form of
// scripts/security/normalise-headers.mjs — the nonce and the derived origins as tokens — compared
// with tests/unit/security/__snapshots__/headers.json. That file is the baseline T30 compares the
// production deploy against, through the same normaliser. A change to any header of these
// responses is a change to the file, reviewed like code.
import { describe, expect, it } from "vitest";
import { normaliseHeaders } from "../../../scripts/security/normalise-headers.mjs";
import { createFilesHost } from "../../../src/worker/files-host";
import { TEST_APP_ORIGIN, TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { ask, imagesMock, makeAccount, pattern, storedFile, urlFor } from "../files-host/harness";
import { appWith, call, fakeCore, type CallOptions } from "../worker-core/helpers";
import baseline from "./__snapshots__/headers.json";

type Origins = { appOrigin: string; filesOrigin: string; sentryOrigin: string | null };
const HTTP: Origins = { appOrigin: TEST_APP_ORIGIN, filesOrigin: TEST_FILES_ORIGIN, sentryOrigin: null };
// Made-up https origins and a made-up public DSN: the shape of a deploy.
const HTTPS_ENV = {
  APP_ORIGIN: "https://app.example.test",
  FILES_ORIGIN: "https://files.example.test",
  SENTRY_DSN_WEB: "https://publickey@o123.ingest.sentry.example.test/456",
};
const HTTPS = {
  appOrigin: HTTPS_ENV.APP_ORIGIN,
  filesOrigin: HTTPS_ENV.FILES_ORIGIN,
  sentryOrigin: "https://o123.ingest.sentry.example.test",
};

const script = {
  fetch: async () =>
    new Response("export {}", {
      headers: { "content-type": "text/javascript", "cache-control": "public, max-age=0" },
    }),
};

async function appHeaders(path: string, options: CallOptions, origins: Origins) {
  const { response, ctx } = await call(appWith(fakeCore()), path, options);
  await response.arrayBuffer();
  await ctx.settle();
  return { status: response.status, headers: normaliseHeaders(response.headers, origins) };
}

async function appHost(origin: string, env: Record<string, unknown>, origins: Origins) {
  return {
    "GET /": await appHeaders("/", { origin, env }, origins),
    "GET /api/health": await appHeaders("/api/health", { origin, env }, origins),
    "GET /s/x": await appHeaders("/s/x", { origin, env }, origins),
    "GET /assets/index-x.js": await appHeaders(
      "/assets/index-x.js",
      { origin, env: { ...env, ASSETS: script } },
      origins,
    ),
  };
}

async function snapshotNow() {
  const owner = await makeAccount();
  const { node } = await storedFile(owner.id, {
    mime: "image/png",
    name: "holiday photo.png",
    content: pattern(700),
  });
  const files = async (path: string, env: Record<string, unknown> = {}) => {
    const answer = await ask(path, { env });
    return { status: answer.status, headers: normaliseHeaders(answer.headers, HTTP) };
  };
  const filesHttps = async (path: string) => {
    const { response, ctx } = await call(createFilesHost(fakeCore().core), path, {
      origin: HTTPS_ENV.FILES_ORIGIN,
      env: HTTPS_ENV,
    });
    await response.arrayBuffer();
    await ctx.settle();
    return { status: response.status, headers: normaliseHeaders(response.headers, HTTPS) };
  };
  return {
    "app host, http (local)": await appHost(TEST_APP_ORIGIN, {}, HTTP),
    "app host, https (a deploy)": await appHost(HTTPS_ENV.APP_ORIGIN, HTTPS_ENV, HTTPS),
    "files host, http (local)": {
      "GET /d/…": await files(await urlFor("download", node, { user: owner.id })),
      "GET /i/…": await files(await urlFor("inline", node, { user: owner.id })),
      "GET /t/…": await files(await urlFor("thumb", node, { user: owner.id }), {
        IMAGES: imagesMock().binding,
      }),
      "GET /nope (404)": await files("/nope"),
    },
    "files host, https (a deploy)": {
      "GET / (404)": await filesHttps("/"),
      "GET /d/… refused (403)": await filesHttps("/d/abc/def"),
    },
  };
}

describe("the header snapshot of both hosts", () => {
  it("equals tests/unit/security/__snapshots__/headers.json", async () => {
    expect(await snapshotNow()).toEqual(baseline);
  });

  it("no cookie on any of them; the policy of the scripts is the shell's, less report-to", () => {
    for (const host of Object.values(baseline)) {
      for (const [label, answer] of Object.entries(host)) {
        expect(answer.headers, label).not.toHaveProperty("set-cookie");
      }
    }
    const app = baseline["app host, https (a deploy)"];
    expect(app["GET /assets/index-x.js"].headers["content-security-policy"]).toBe(
      app["GET /"].headers["content-security-policy"]!.replace("; report-to csp", ""),
    );
    expect(app["GET /assets/index-x.js"].headers).not.toHaveProperty("reporting-endpoints");
  });

  it("the normaliser replaces whole origins only, and every nonce", () => {
    expect(
      normaliseHeaders(
        {
          "Content-Security-Policy": "script-src 'nonce-abc+/=' x; style-src 'nonce-def'",
          "Access-Control-Allow-Origin": "http://localhost",
          Link: "http://localhost:5190/x http://files.localhost/y",
          ETag: '"1"',
          Date: "now",
        },
        HTTP,
      ),
    ).toEqual({
      "access-control-allow-origin": "<APP_ORIGIN>",
      "content-security-policy": "script-src 'nonce-<NONCE>' x; style-src 'nonce-<NONCE>'",
      etag: "<validator>",
      link: "http://localhost:5190/x <FILES_ORIGIN>/y",
    });
  });
});
