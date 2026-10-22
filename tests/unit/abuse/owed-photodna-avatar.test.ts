// AVSEAM residual, closed by OWEDLOCK: a PhotoDNA match on an avatar whose node cannot be written.
// The route lists the SERVER hash `csam` the way the lock itself does (scan/verdict.ts
// `listSuspectedCsam`: `sourceNodeId` the node the upload becomes) BEFORE any node write, so
// T22's repair sweep (abuse-hourly part 0c) takes its csam branch: the node written locked, held,
// reported, the object kept, the session ended — like every other CSAM detection. And because
// the entry is the lock's own (not a confirmed listing), an admin clearing it as a false positive
// takes the hash off the list again.
// End to end: the real upload route owes it, the sweep's own listing finds it, and the sweep's
// one-session step settles it. Not table-wide: the listing is only read, and only this test's
// session is settled. PhotoDNA is switched on for the requests only, with a made-up key and a
// mocked Match API.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { owedSessions } from "../../../src/worker/db/queries/abuse";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { utcDay } from "../../../src/worker/db/queries/ledger";
import { clearSuspectedCsam } from "../../../src/worker/db/queries/moderation";
import { nodes, reports, uploads } from "../../../src/worker/db/schema";
import { settleOwedSession } from "../../../src/worker/jobs/abuse-hourly";
import { PHOTODNA_MATCH_URL } from "../../../src/worker/scan/photodna";
import { pngBytes } from "../../setup/fixture-bytes";
import { mailTo } from "../auth/helpers";
import { jobContext, testDb } from "../trash/helpers";
import { auditFor, complete, init, putSingle, sessionRow, sha, uploader, userRow } from "../uploads/helpers";
import { operators } from "./helpers";

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
});

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("a PhotoDNA-matched avatar whose node cannot be written", () => {
  it("is listed csam (the lock's own entry) before the node write; T22's sweep then LOCKS it — node written locked, held, reported, object kept, session ended — and a false-positive clear unlists it", async () => {
    const ops = operators();
    const user = await uploader();
    // Unique content: a match lists its hash, and the bare fixture PNG is other files' avatar.
    const base = pngBytes(32, 32);
    const bytes = new Uint8Array(base.length + 16);
    bytes.set(base);
    crypto.getRandomValues(bytes.subarray(base.length));
    const server = await sha256Of(bytes);
    const session = await init(user, {
      purpose: "avatar",
      mimeDeclared: "image/png",
      name: "me.png",
      size: bytes.byteLength,
    });
    expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
    const answer = await complete(
      user,
      session.uploadId,
      { sha256: sha() },
      {
        env: { ...ON, ...ops.env },
        // Every transaction that would write a node fails: the route's and the preserve path's.
        beforeCommit: () => {
          throw new Error("test: the node cannot be written");
        },
      },
    );
    expect(answer.status).toBe(403);
    const row = (await sessionRow(session.uploadId))!;
    expect(row.status).toBe("completing");
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key))).toHaveLength(0);
    expect(await auditFor("upload.csam_node_owed", session.uploadId)).toHaveLength(1);
    // The SERVER hash is listed csam — the entry the lock itself writes, naming the node to be.
    expect(await blocklist.lookup(testDb(), server)).toEqual({ reason: "csam", sourceNodeId: row.nodeId });
    expect(mailTo(ops.address)).toHaveLength(1);

    // Past the stale clock, as the sweep requires.
    await testDb()
      .update(uploads)
      .set({ completingAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(uploads.id, session.uploadId));

    const listed = (await owedSessions(testDb(), 10_000, utcDay(new Date()))).find(
      (entry) => entry.session.id === session.uploadId,
    );
    expect(listed).toMatchObject({ owedRow: true });

    const ctx = jobContext({ env: ops.env });
    expect(await settleOwedSession(ctx.bg, listed!, async () => true)).toBe("locked");
    await ctx.settle();
    expect(ctx.metric.mock.calls).not.toContainEqual([
      "job",
      { kind: "abuse-hourly", outcome: "error", reason: "owed_not_csam" },
    ]);
    // LOCKED: the node written (the uploader's, on the session's key), suspected_csam and held;
    // a csam report; the uploader held; the object kept; the session ended.
    const written = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: row.nodeId,
      ownerId: user.id,
      sha256: server,
      scanStatus: "suspected_csam",
      legalHold: true,
    });
    expect(await testDb().select().from(reports).where(eq(reports.nodeId, written[0]!.id))).toMatchObject([
      { category: "csam", status: "open" },
    ]);
    expect(await userRow(user.id)).toMatchObject({ legalHold: true });
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    // Ended the way the route's preserve path ends it (`endPreserved`): the node holds the key now.
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });

    // A false positive: the admin's clear takes the hash off the list again — the entry was the
    // lock's own, not a confirmed (permanent) listing.
    const cleared = await testDb().transaction((tx) => clearSuspectedCsam(tx, written[0]!.id));
    expect(cleared).toMatchObject({ cleared: true, blocklistRemoved: true, blocklistKept: null });
    expect(await blocklist.lookup(testDb(), server)).toBeNull();
  });
});
