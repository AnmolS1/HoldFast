// PhotoDNA (T21 step 4) — off in v1; here switched on for the test only, with a made-up key and a
// mocked Match API (global `fetch`) and Images binding. Nothing reaches Microsoft.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totalsOn, utcDay } from "../../../src/worker/db/queries/ledger";
import { PHOTODNA_MATCH_URL, PHOTODNA_MAX_BYTES } from "../../../src/worker/scan/photodna";
import { metric } from "../../../src/worker/services/metrics";
import { pngBytes } from "../../setup/fixture-bytes";
import { deliver, enc, explicit, jobsFor, nodeById, reportsOf, testDb, uploadedFile } from "./helpers";

vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn(real.metric) };
});

// A made-up key: the request never leaves the test (fetch is mocked).
const ON = { PHOTODNA_ENABLED: "true", PHOTODNA_SUBSCRIPTION_KEY: "made-up-photodna-test-key" };
const ack = [{ outcome: "ack" }];

type Answer = () => Promise<Response>;
let answer: Answer;
let calls: { url: string; init?: RequestInit }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  answer = async () => Response.json({ Status: { Code: 3000, Description: "OK" }, IsMatch: false });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PHOTODNA_MATCH_URL)) return realFetch(input, init);
    calls.push({ url, init });
    return answer();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(metric).mockClear();
});

const skippedMetrics = () =>
  vi
    .mocked(metric)
    .mock.calls.filter(([name, tags]) => name === "scan" && tags?.outcome === "photodna_skipped")
    .map(([, tags]) => tags?.reason);

/** A PNG of `extra` more bytes than its pixels need (still sniffed as image/png). */
const png = (extra = 0) => {
  const base = pngBytes(32, 32);
  const out = new Uint8Array(base.length + extra);
  out.set(base, 0);
  return out;
};

/** An Images binding whose transform answers `result` (a Response body, or a throw). */
function images(result: () => Promise<Uint8Array>) {
  const inputs: string[] = [];
  const handle = {
    transform() {
      return handle;
    },
    async output() {
      const bytes = await result();
      return { response: () => new Response(bytes) };
    },
  };
  return {
    inputs,
    binding: {
      input: () => (inputs.push("input"), handle),
      info: async () => ({ width: 32, height: 32 }),
    },
  };
}

describe("PhotoDNA", () => {
  it("flag off (the default here and in every environment): never called", async () => {
    expect(env.PHOTODNA_ENABLED).toBe("false");
    const { file } = await uploadedFile(png(), { name: "p.png" });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(calls).toHaveLength(0);
    expect((await nodeById(file.id))!.scanDetail?.photodna).toBeUndefined();
  });

  it("not an image: never called", async () => {
    const { file } = await uploadedFile(enc("a text file"), { name: "a.txt" });
    expect(await deliver([{ body: explicit(file) }], ON)).toEqual(ack);
    expect(calls).toHaveLength(0);
  });

  it("no match: the scanner's verdict, noted; the request carries the key and the image bytes", async () => {
    const bytes = png();
    const { file } = await uploadedFile(bytes, { name: "p.png" });
    expect(await deliver([{ body: explicit(file) }], ON)).toEqual(ack);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("Ocp-Apim-Subscription-Key")).toBe(ON.PHOTODNA_SUBSCRIPTION_KEY);
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(calls[0]!.init!.body as ArrayBuffer)).toEqual(bytes);
    expect(await nodeById(file.id)).toMatchObject({
      scanStatus: "clean",
      scanDetail: { photodna: "no_match" },
    });
  });

  it("a match: suspected_csam through the shared handler, source photodna; the object kept", async () => {
    answer = async () => Response.json({ Status: { Code: 3000 }, IsMatch: true });
    const { file } = await uploadedFile(png(), { name: "p.png" });
    expect(await deliver([{ body: explicit(file) }], ON)).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await reportsOf(file.id)).toMatchObject([{ category: "csam", source: "photodna" }]);
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();
  });

  it("a match raises an under_review node", async () => {
    answer = async () => Response.json({ Status: { Code: 3000 }, IsMatch: true });
    const { file } = await uploadedFile(png(), { name: "p.png", scanStatus: "under_review" });
    expect(await deliver([{ body: explicit(file) }], ON)).toEqual(ack);
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
  });

  it("transient — a network error, 429, 5xx from the PhotoDNA request: job failed, message retried, node pending", async () => {
    for (const [label, next] of [
      ["network", async () => Promise.reject(new TypeError("fetch failed"))],
      ["429", async () => new Response("slow down", { status: 429 })],
      ["503", async () => new Response("down", { status: 503 })],
    ] as [string, Answer][]) {
      answer = next;
      const { file } = await uploadedFile(png(), { name: "p.png" });
      expect(await deliver([{ body: explicit(file) }], ON), label).toEqual([
        { outcome: "retry", delaySeconds: 30 },
      ]);
      expect(await jobsFor(file.r2Key!), label).toMatchObject([{ status: "failed", lastError: "photodna" }]);
      expect((await nodeById(file.id))!.scanStatus, label).toBe("pending");
    }
  });

  it("enabled without a subscription key: fail closed (retried), never unchecked", async () => {
    const { file } = await uploadedFile(png(), { name: "p.png" });
    expect(await deliver([{ body: explicit(file) }], { ...ON, PHOTODNA_SUBSCRIPTION_KEY: "" })).toEqual([
      { outcome: "retry", delaySeconds: 30 },
    ]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
  });

  it("above the Match API's size: downscaled through Images — one transform_user unit for the owner", async () => {
    const small = png();
    const fake = images(async () => small);
    const { file, owner } = await uploadedFile(png(PHOTODNA_MAX_BYTES), { name: "big.png" });
    const before = (await totalsOn(testDb(), utcDay(), "transform_user", owner.id)).count;
    expect(await deliver([{ body: explicit(file) }], { ...ON, IMAGES: fake.binding })).toEqual(ack);
    expect(fake.inputs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init?.headers).get("Content-Type")).toBe("image/jpeg");
    expect((await totalsOn(testDb(), utcDay(), "transform_user", owner.id)).count).toBe(before + 1);
    expect((await nodeById(file.id))!.scanDetail?.photodna).toBe("no_match");
  });

  it("Images quota error 9422 / a plain 'Network connection lost.' from the binding: PhotoDNA skipped, the scan finishes, NO retry", async () => {
    for (const [thrown, note] of [
      [Object.assign(new Error("ERROR 9422: quota exceeded"), { code: 9422 }), "images_9422"],
      [new Error("Network connection lost."), "images"],
    ] as const) {
      const fake = images(async () => Promise.reject(thrown));
      const { file } = await uploadedFile(png(PHOTODNA_MAX_BYTES), { name: "big.png" });
      expect(await deliver([{ body: explicit(file) }], { ...ON, IMAGES: fake.binding }), note).toEqual(ack);
      expect(await nodeById(file.id), note).toMatchObject({
        scanStatus: "clean",
        scanDetail: { photodna: `skipped:${note}` },
      });
      expect(calls, note).toHaveLength(0);
    }
    expect(skippedMetrics()).toEqual(["images_9422", "images"]);
  });

  it("an image above 20,000,000 bytes never reaches the Images mock (skipped:size); an unsupported format is skipped", async () => {
    const fake = images(async () => png());
    const { file } = await uploadedFile(png(20_000_001), { name: "huge.png" });
    expect(await deliver([{ body: explicit(file) }], { ...ON, IMAGES: fake.binding })).toEqual(ack);
    expect(fake.inputs).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await nodeById(file.id))!.scanDetail?.photodna).toBe("skipped:size");

    const webp = new Uint8Array(64);
    webp.set(enc("RIFF\0\0\0\0WEBPVP8 "));
    const w = await uploadedFile(webp, { name: "w.webp" });
    expect(await deliver([{ body: explicit(w.file) }], ON)).toEqual(ack);
    expect((await nodeById(w.file.id))!.scanDetail?.photodna).toBe("skipped:format");
  });
});
