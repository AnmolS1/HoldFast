// Owner rescan: who, which statuses, once an hour — and that a file which may not be rescanned
// answers exactly as an id that does not exist, whenever it became such a file.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nodes } from "../../../src/worker/db/schema";
import { backendPid, gate, untilBlockedBy } from "../services-core/helpers";
import {
  api,
  auditFor,
  comparable,
  makeFile,
  makeFolder,
  nodeById,
  person,
  scanQueueSpy,
  setStatus,
  sharedTree,
  takeDown,
  testDb,
  type Answer,
  type Caller,
} from "./helpers";

const rescan = (caller: Caller, nodeId: string, spy = scanQueueSpy()) =>
  api(caller, "POST", `/nodes/${nodeId}/rescan`, { env: spy.env });

describe("POST /nodes/:id/rescan", () => {
  it("an `error` or `skipped` file: 202, back to pending, one forced message, one node.rescan row", async () => {
    for (const status of ["error", "skipped"] as const) {
      const owner = await person();
      const file = await makeFile(owner.id, null, { scanStatus: status, scanReason: "engine" });
      const spy = scanQueueSpy();
      const answer = await rescan(owner.as, file.id, spy);
      expect([answer.status, answer.body]).toEqual([202, { ok: true }]);
      expect(spy.sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
      const row = (await nodeById(file.id))!;
      expect([row.scanStatus, row.scanReason, row.rescanRequestedAt !== null]).toEqual([
        "pending",
        null,
        true,
      ]);
      const audited = await auditFor("node.rescan", file.id);
      expect(audited.map((entry) => [entry.actorUserId, entry.actorType])).toEqual([[owner.id, "user"]]);
    }
  });

  it("only `error` and `skipped`: any other status is 409 conflict, and does not use up the hour", async () => {
    const owner = await person();
    for (const status of ["pending", "clean", "infected", "under_review"] as const) {
      const file = await makeFile(owner.id, null, { scanStatus: status });
      const spy = scanQueueSpy();
      const answer = await rescan(owner.as, file.id, spy);
      expect([answer.status, answer.body.error], status).toEqual([409, "conflict"]);
      expect(spy.sent).toEqual([]);
      const row = (await nodeById(file.id))!;
      expect([row.scanStatus, row.rescanRequestedAt]).toEqual([status, null]);
      expect(await auditFor("node.rescan", file.id)).toEqual([]);
    }
    const folder = await makeFolder(owner.id);
    expect((await rescan(owner.as, folder.id)).status).toBe(404);
  });

  it("once per node per hour: the second is 429 rate_limited with Retry-After; an hour later it is allowed", async () => {
    const owner = await person();
    const file = await makeFile(owner.id, null, { scanStatus: "error" });
    const other = await makeFile(owner.id, null, { scanStatus: "error" });
    expect((await rescan(owner.as, file.id)).status).toBe(202);
    // The scan (a stand-in here) failed again: the file is `error` once more, within the hour.
    await setStatus(file.id, "error");
    const spy = scanQueueSpy();
    const again = await rescan(owner.as, file.id, spy);
    expect([again.status, again.body.error]).toEqual([429, "rate_limited"]);
    const wait = Number(again.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(3_500);
    expect(wait).toBeLessThanOrEqual(3_600);
    expect(spy.sent).toEqual([]);
    expect((await nodeById(file.id))!.scanStatus).toBe("error");
    expect(await auditFor("node.rescan", file.id)).toHaveLength(1);
    // Per node: another file of the same owner is not throttled by it.
    expect((await rescan(owner.as, other.id)).status).toBe(202);

    // 59 minutes: still throttled. 61 minutes: allowed. (This test's own row is moved back.)
    const setRequested = (minutesAgo: number) =>
      testDb()
        .update(nodes)
        .set({ rescanRequestedAt: sql`now() - make_interval(mins => ${minutesAgo})` })
        .where(eq(nodes.id, file.id));
    await setRequested(59);
    const soon = await rescan(owner.as, file.id);
    expect(soon.status).toBe(429);
    expect(Number(soon.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    await setRequested(61);
    expect((await rescan(owner.as, file.id)).status).toBe(202);
    expect(await auditFor("node.rescan", file.id)).toHaveLength(2);
  });

  it("a rescan that could not be queued does not use up the hour: the throttle is as it was before", async () => {
    const owner = await person();
    const failing = { SCAN_QUEUE: { send: async () => Promise.reject(new Error("made-up queue failure")) } };
    const fresh = await makeFile(owner.id, null, { scanStatus: "error" });
    const earlier = new Date(Date.now() - 61 * 60_000);
    const asked = await makeFile(owner.id, null, { scanStatus: "skipped", rescanRequestedAt: earlier });
    for (const [file, before] of [
      [fresh, null],
      [asked, earlier],
    ] as const) {
      const answer = await api(owner.as, "POST", `/nodes/${file.id}/rescan`, { env: failing });
      expect([answer.status, answer.body.error]).toEqual([500, "internal"]);
      expect((await nodeById(file.id))!.rescanRequestedAt).toEqual(before);
      expect(await auditFor("node.rescan", file.id)).toEqual([]);
    }
    // The control: the same request with a queue that takes the message keeps the hour.
    const fine = await makeFile(owner.id, null, { scanStatus: "error" });
    expect((await rescan(owner.as, fine.id)).status).toBe(202);
    expect((await nodeById(fine.id))!.rescanRequestedAt).not.toBeNull();
    // A REFUSAL keeps it too (the file was hidden while the request ran: see the next block).
  });

  it("the owner's alone: a partner who can see the file (its uploader) is 403, anyone else 404; nothing is queued", async () => {
    const t = await sharedTree();
    const spy = scanQueueSpy();
    for (const [who, expected] of [
      [t.editor, [403, "forbidden"]],
      // An `error` file the viewer did not upload does not exist for them.
      [t.viewer, [404, "not_found"]],
      [t.stranger, [404, "not_found"]],
      [t.invited, [404, "not_found"]],
    ] as const) {
      const answer = await rescan(who.as, t.broken.id, spy);
      expect([answer.status, answer.body.error]).toEqual(expected);
    }
    expect(spy.sent).toEqual([]);
    expect((await nodeById(t.broken.id))!.rescanRequestedAt).toBeNull();
    expect(await auditFor("node.rescan", t.broken.id)).toEqual([]);
  });
});

/**
 * Makes `change` land BETWEEN the route's read of the node and the service's locked check: the
 * node's row is held locked until the request is seen waiting on it (its throttle statement —
 * the reads before that have gone through and saw a rescannable file), then `change` is made in
 * the locking transaction and committed.
 */
async function changedMidRequest(
  nodeId: string,
  change: Partial<typeof nodes.$inferInsert>,
  request: () => Promise<Answer>,
) {
  const locked = gate<number>();
  const release = gate();
  const holder = testDb().transaction(async (tx) => {
    await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).for("update");
    locked.open(await backendPid(tx));
    await release.opened;
    await tx.update(nodes).set(change).where(eq(nodes.id, nodeId));
  });
  const pid = await locked.opened;
  const answer = request();
  expect(await untilBlockedBy(pid)).toBe("blocked");
  release.open();
  await holder;
  return answer;
}

describe("a rescan that is refused does not say why", () => {
  it("taken down or locked — from the start, or while the request was running — and an unknown id: the same 404, no audit row, no message", async () => {
    const owner = await person();
    const file = () => makeFile(owner.id, null, { scanStatus: "error", scanReason: "engine" });
    const spy = scanQueueSpy();
    const ask = (id: string) => () => rescan(owner.as, id, spy);

    const unknown = await ask(crypto.randomUUID())();
    expect([unknown.status, unknown.body.error]).toEqual([404, "not_found"]);

    const downBefore = await file();
    await takeDown(downBefore.id);
    const lockedBefore = await file();
    await setStatus(lockedBefore.id, "suspected_csam");
    const downDuring = await file();
    const lockedDuring = await file();

    const answers: [string, { id: string }, Answer][] = [
      ["taken down from the start", downBefore, await ask(downBefore.id)()],
      ["locked from the start", lockedBefore, await ask(lockedBefore.id)()],
      [
        "taken down while the request ran",
        downDuring,
        await changedMidRequest(
          downDuring.id,
          { takedownAt: new Date(), takedownReason: "abuse" },
          ask(downDuring.id),
        ),
      ],
      [
        "locked while the request ran",
        lockedDuring,
        await changedMidRequest(lockedDuring.id, { scanStatus: "suspected_csam" }, ask(lockedDuring.id)),
      ],
    ];
    for (const [label, node, answer] of answers) {
      expect(comparable(answer), label).toEqual(comparable(unknown));
      expect(Object.keys(answer.body).sort(), label).toEqual(["error", "message", "requestId"]);
      expect(await auditFor("node.rescan", node.id), label).toEqual([]);
      expect(await auditFor("scan.rescan_requested", node.id), label).toEqual([]);
    }
    expect(spy.sent).toEqual([]);
    // Nothing was reset: a rescan is not a way back to `pending`.
    expect((await nodeById(downBefore.id))!.scanStatus).toBe("error");
    expect((await nodeById(downDuring.id))!.scanStatus).toBe("error");
    expect((await nodeById(lockedBefore.id))!.scanStatus).toBe("suspected_csam");
    expect((await nodeById(lockedDuring.id))!.scanStatus).toBe("suspected_csam");
    // The two mid-request cases did get past the route's own checks: the throttle was taken.
    expect((await nodeById(downDuring.id))!.rescanRequestedAt).not.toBeNull();
    expect((await nodeById(lockedDuring.id))!.rescanRequestedAt).not.toBeNull();
    expect((await nodeById(downBefore.id))!.rescanRequestedAt).toBeNull();

    // The control: a file that may be rescanned, asked the same way — and held the same way.
    const fine = await file();
    const granted = await changedMidRequest(fine.id, { scanReason: "timeout" }, ask(fine.id));
    expect(granted.status).toBe(202);
    expect(await auditFor("node.rescan", fine.id)).toHaveLength(1);
    expect(spy.sent).toEqual([{ v: 1, nodeId: fine.id, key: fine.r2Key, force: true }]);
  });
});
