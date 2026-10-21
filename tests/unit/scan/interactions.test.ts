// Two interactions the brief names (T21):
//  - T22's owed-node path: the node of an owed csam session is written LOCKED by the repair sweep,
//    and its session's `expected_sha256` holds the SERVER hash — the consumer leaves it
//    suspected_csam, never `hash_mismatch` (f.1 decides before f.4);
//  - the lock order of the verdict transaction (PLAN §6 rule 15): the owner's tree lock FIRST, so
//    a takedown of a folder above waits for the verdict — which therefore either sees the takedown
//    or commits before it.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takedownNode } from "../../../src/worker/db/queries/moderation";
import { lockJob } from "../../../src/worker/db/queries/scan";
import { nodes, uploads } from "../../../src/worker/db/schema";
import { backendPid, gate, untilBlockedBy } from "../services-core/helpers";
import {
  cleanBytes,
  deliver,
  explicit,
  listAs,
  makeFolder,
  makeUser,
  nodeById,
  r2Event,
  rand,
  sha256Of,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/db/queries/scan", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/scan")>();
  return { ...real, lockJob: vi.fn(real.lockJob) };
});
afterEach(() => {
  vi.mocked(lockJob).mockClear();
});

const ack = [{ outcome: "ack" }];

describe("T22's owed-node path", () => {
  it("an owed session whose node the sweep wrote locked: the consumer leaves it suspected_csam — no hash_mismatch (and with a client hash on the session too: f.1 first)", async () => {
    for (const declared of ["server", "client"] as const) {
      for (const status of ["completing", "done"] as const) {
        const bytes = cleanBytes("owed");
        const server = await sha256Of(bytes);
        await listAs(server, "csam");
        // As `writeLockedNode` leaves it: locked from its first commit, the server hash on it.
        const { file } = await uploadedFile(bytes, {
          scanStatus: "suspected_csam",
          legalHold: true,
          sha256: server,
          declared: declared === "server" ? server : rand(32),
        });
        await testDb().update(uploads).set({ status }).where(eq(uploads.r2Key, file.r2Key!));
        const label = `${declared} hash, session ${status}`;
        expect(await deliver([{ body: r2Event(file.r2Key!) }, { body: explicit(file) }]), label).toEqual([
          ...ack,
          ...ack,
        ]);
        const row = (await nodeById(file.id))!;
        expect(row.scanStatus, label).toBe("suspected_csam");
        expect(row.scanReason, label).toBeNull();
        expect(row.sha256, label).toBe(server);
      }
    }
  });
});

describe("lock order: the verdict transaction takes the owner's tree lock first", () => {
  it("a takedown of a folder above waits for a verdict in flight; the verdict commits first, then the folder is down", async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner.id, null);
    const { file } = await uploadedFile(cleanBytes(), { owner, parentId: folder.id });
    const held = gate();
    const reached = gate<number>();
    const real = (
      await vi.importActual<typeof import("../../../src/worker/db/queries/scan")>(
        "../../../src/worker/db/queries/scan",
      )
    ).lockJob;
    // Inside the verdict transaction, after the tree lock and the node's row: report the
    // connection and wait.
    vi.mocked(lockJob).mockImplementationOnce(async (tx, key, opts) => {
      reached.open(await backendPid(tx as never));
      await held.opened;
      return real(tx, key, opts);
    });
    const delivery = deliver([{ body: explicit(file) }]);
    const pid = await reached.opened;
    let takenDown = false;
    const takedown = takedownNode(testDb(), folder.id, { reason: "abuse", by: null }).then((done) => {
      takenDown = true;
      return done;
    });
    // The takedown cannot get the owner's tree lock while the verdict holds it.
    expect(await untilBlockedBy(pid, () => takenDown)).toBe("blocked");
    expect(takenDown).toBe(false);
    held.open();
    expect(await delivery).toEqual(ack);
    expect(await takedown).toBe(true);
    // The verdict committed before the takedown: it was written; the folder is down now.
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
    const [down] = await testDb().select().from(nodes).where(eq(nodes.id, folder.id));
    expect(down!.takedownAt).toBeInstanceOf(Date);
  });
});
