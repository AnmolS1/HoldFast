// AVSEAM residual: a PhotoDNA match on an avatar whose node cannot be written is OWED only by the
// route's `upload.csam_node_owed` audit row — PhotoDNA matched, the blocklist does not list the
// hash. What T22's repair sweep (abuse-hourly part 0c) does with such a session, end to end: the
// real upload route owes it, the sweep's own listing finds it, and the sweep's one-session step
// settles it. Not table-wide: the listing is only read, and only this test's session is settled.
// PhotoDNA is switched on for the requests only, with a made-up key and a mocked Match API.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { owedSessions } from "../../../src/worker/db/queries/abuse";
import { utcDay } from "../../../src/worker/db/queries/ledger";
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

describe("a PhotoDNA-matched avatar whose node cannot be written", () => {
  it("is owed by the audit row alone; T22's sweep lists it and HOLDS it (object kept, session completing, operators told once) — it does not write or lock the node", async () => {
    const ops = operators();
    const user = await uploader();
    const base = pngBytes(32, 32);
    const bytes = new Uint8Array(base.length + 16);
    bytes.set(base);
    crypto.getRandomValues(bytes.subarray(base.length));
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
    const alertsAtRoute = mailTo(ops.address).length;
    expect(alertsAtRoute).toBe(1);

    // Past the stale clock, as the sweep requires.
    await testDb()
      .update(uploads)
      .set({ completingAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(uploads.id, session.uploadId));

    // The sweep's own listing finds it — by the audit row; the hash is on no list.
    const listed = (await owedSessions(testDb(), 10_000, utcDay(new Date()))).find(
      (entry) => entry.session.id === session.uploadId,
    );
    expect(listed).toMatchObject({ owedRow: true });

    const ctx = jobContext({ env: ops.env });
    expect(await settleOwedSession(ctx.bg, listed!, async () => true)).toBe("held");
    await ctx.settle();
    expect(ctx.metric.mock.calls).toContainEqual([
      "job",
      { kind: "abuse-hourly", outcome: "error", reason: "owed_not_csam" },
    ]);
    // Held: nothing deleted, nothing ended — and nothing locked (no node, no report, no hold).
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "completing" });
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key))).toHaveLength(0);
    expect(await testDb().select().from(reports).where(eq(reports.ownerId, user.id))).toHaveLength(0);
    expect(await userRow(user.id)).toMatchObject({ legalHold: false });
    // The operators are told — once: a second run holds it again and tells nobody.
    const told = mailTo(ops.address).length;
    expect(told).toBe(alertsAtRoute + 1);
    expect(await settleOwedSession(ctx.bg, listed!, async () => true)).toBe("held");
    await ctx.settle();
    expect(mailTo(ops.address)).toHaveLength(told);
  });
});
