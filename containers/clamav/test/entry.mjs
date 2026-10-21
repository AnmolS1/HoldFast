// Test-only Worker for containers/clamav/test/integration.sh: drives the real helpers of
// src/worker/scan/container.ts against real containers in a local, containers-enabled `wrangler dev`.
// Never deployed; the app's entry is src/worker/index.ts.
import { getContainer } from "@cloudflare/containers";
import {
  preferredInstance,
  ScannerContainer as AppScannerContainer,
  scannerHealth,
  scanObject,
  scanSmall,
} from "../../../src/worker/scan/container.ts";

/** The app's class, told not to contact the signature mirror (the bake is fresh; C26). */
export class ScannerContainer extends AppScannerContainer {
  envVars = { SCANNER_OFFLINE: "1" };
}

/** A stub factory that records which instance answered what. */
function recording(env, calls) {
  return (name) => {
    const stub = getContainer(env.SCANNER, name);
    return {
      async fetch(input, init) {
        try {
          const response = await stub.fetch(input, init);
          const call = { name, status: response.status };
          if (response.status !== 200) {
            call.retryAfter = response.headers.get("Retry-After");
            call.body = (
              await response
                .clone()
                .text()
                .catch((error) => `<${error}>`)
            ).slice(0, 200);
          }
          calls.push(call);
          return response;
        } catch (error) {
          calls.push({ name, error: String(error) });
          throw error;
        }
      },
    };
  };
}

function failure(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error),
    reason: error?.reason,
    retryAfter: error?.retryAfter,
  };
}

async function run(work, calls) {
  try {
    return Response.json({ verdict: await work, calls });
  } catch (error) {
    return Response.json({ error: failure(error), calls });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const calls = [];
    const stub = recording(env, calls);
    switch (url.pathname) {
      case "/t/health":
        return run(scannerHealth(env, url.searchParams.get("name") ?? "", { stub }), calls);
      case "/t/keys": {
        // `count` object keys that all prefer `instance`.
        const instance = url.searchParams.get("instance");
        const count = Number(url.searchParams.get("count") ?? "2");
        const keys = [];
        for (let i = 0; keys.length < count; i++)
          if (preferredInstance(`u/it/${i}`) === instance) keys.push(`u/it/${i}`);
        return Response.json({ keys });
      }
      case "/t/scan-object": {
        const size = Number(request.headers.get("X-Object-Size"));
        const key = url.searchParams.get("key") ?? "u/it/0";
        // Counts what the helper pulled from the body, to see how much a refused attempt consumed.
        let pulled = 0;
        const reader = request.body.getReader();
        const body = new ReadableStream(
          {
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) return controller.close();
              pulled += value.byteLength;
              controller.enqueue(value);
            },
          },
          { highWaterMark: 0 },
        );
        const timeoutMs = url.searchParams.has("timeoutMs")
          ? Number(url.searchParams.get("timeoutMs"))
          : undefined;
        const response = await run(scanObject(env, { key, size, body }, { stub, timeoutMs }), calls);
        const result = await response.json();
        result.pulledBytes = pulled;
        return Response.json(result);
      }
      case "/t/scan-small":
        return run(scanSmall(env, new Uint8Array(await request.arrayBuffer()), { stub }), calls);
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
