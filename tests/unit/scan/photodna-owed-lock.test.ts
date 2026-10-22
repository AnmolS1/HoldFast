// OWEDLOCK, the file path: PhotoDNA runs on a FILE in the scan consumer, after its node exists.
// "The node write that fails" there is the lock itself — the shared handler that makes the node
// `suspected_csam` after the verdict's transaction committed. The verdict's transaction lists the
// SERVER hash `csam` the way the lock does (`listSuspectedCsam`, `sourceNodeId` the node) before
// that, so a redelivery on which PhotoDNA does not answer a match (switched off, skipped, down)
// still ends the file LOCKED — held, reported, the object kept — never clean.
// PhotoDNA is switched on for the first delivery only, with a made-up key and a mocked Match API.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { clearSuspectedCsam } from "../../../src/worker/db/queries/moderation";
import { PHOTODNA_MATCH_URL } from "../../../src/worker/scan/photodna";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { pngBytes } from "../../setup/fixture-bytes";
import { userRow } from "../uploads/helpers";
import { deliver, explicit, nodeById, reportsOf, sha256Of, testDb, uploadedFile } from "./helpers";

vi.mock("../../../src/worker/services/scanning", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/scanning")>();
  return { ...real, lockSuspectedCsam: vi.fn(real.lockSuspectedCsam) };
});

// A made-up key: the request never leaves the test (fetch is mocked).
const ON = { PHOTODNA_ENABLED: "true", PHOTODNA_SUBSCRIPTION_KEY: "made-up-photodna-test-key" };
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PHOTODNA_MATCH_URL)) return realFetch(input, init);
    return Response.json({ Status: { Code: 3000, Description: "OK" }, IsMatch: true });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(lockSuspectedCsam).mockClear();
});

/** A PNG with bytes of its own after its end: a match lists its hash, so it is unique per test. */
const png = () => {
  const base = pngBytes(32, 32);
  const out = new Uint8Array(base.length + 16);
  out.set(base, 0);
  crypto.getRandomValues(out.subarray(base.length));
  return out;
};

describe("a PhotoDNA-matched file whose lock fails", () => {
  it("is listed csam by the verdict's transaction; the redelivery — PhotoDNA off — LOCKS it (held, reported, object kept), and a false-positive clear unlists it", async () => {
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file, owner } = await uploadedFile(bytes, { name: "p.png" });

    // Delivery 1: PhotoDNA matches; the lock (the write that makes the node suspected_csam) fails.
    vi.mocked(lockSuspectedCsam).mockRejectedValueOnce(new Error("test: the lock cannot be written"));
    expect(await deliver([{ body: explicit(file) }], ON)).toMatchObject([{ outcome: "retry" }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "pending", legalHold: false });
    // Listed before the lock — the entry the lock itself writes, naming the node.
    expect(await blocklist.lookup(testDb(), server)).toEqual({ reason: "csam", sourceNodeId: file.id });

    // Delivery 2: PhotoDNA does not answer a match (here: switched off). The list decides.
    expect(await deliver([{ body: explicit(file), attempts: 2 }])).toEqual([{ outcome: "ack" }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await reportsOf(file.id)).toMatchObject([{ category: "csam", status: "open" }]);
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true });
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();

    // A false positive: the clear takes the hash off the list — the entry is the lock's own.
    const cleared = await testDb().transaction((tx) => clearSuspectedCsam(tx, file.id));
    expect(cleared).toMatchObject({ cleared: true, blocklistRemoved: true, blocklistKept: null });
    expect(await blocklist.lookup(testDb(), server)).toBeNull();
  });
});
