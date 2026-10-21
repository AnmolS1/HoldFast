// The stale-upload job and the uploader's sealed address on a session (ruling 2026-10-21, T22 (0c)).
// TABLE-WIDE: the job settles every stale session in the database, so this file runs alone.
// Whatever the job ends — aborted or done — loses the address; a stale `completing` session that
// owes a locked node is not the job's and keeps it for the repair sweep.
// (The sealed values are made-up bytes, not a sealed address.)
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { job as staleUploadsJob } from "../../../src/worker/jobs/stale-uploads";
import {
  cronEvent,
  generationInStep,
  jobContext,
  makeFile,
  makeUpload,
  member,
  putObject,
  testDb,
  uploadRow,
} from "../trash/helpers";

beforeAll(generationInStep);

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const SEALED = { ipEncrypted: new Uint8Array([1, 2, 3, 4, 5]), ipIv: new Uint8Array(12).fill(3), ipKeyVersion: 1 };
const CLEARED = { ipEncrypted: null, ipIv: null, ipKeyVersion: null };

const hex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function run() {
  return staleUploadsJob.run(jobContext().bg, env, cronEvent(staleUploadsJob.cron), { softDeadlineMs: 120_000 });
}

describe("the stale-upload job clears the sealed address of every session it ends", () => {
  it("open past its expiry → aborted; completing with its node written → done; both cleared — an owed one keeps it", async () => {
    const owner = await member();
    const expired = await makeUpload(owner.id, owner.id, { ...SEALED, expiresAt: ago(HOUR) });

    const stuck = { status: "completing" as const, completingAt: ago(2 * HOUR) };
    const committed = await makeUpload(owner.id, owner.id, { ...SEALED, ...stuck, size: 100 });
    await makeFile(owner.id, null, { id: committed.nodeId, versionId: committed.versionId, r2Key: committed.r2Key });
    await putObject(committed.r2Key, "committed");

    const lost = await makeUpload(owner.id, owner.id, { ...SEALED, ...stuck, size: 70 });

    // Owes a locked node: its declared hash is csam-listed — the repair sweep's, not the job's.
    const sha256 = hex();
    await blocklist.upsert(testDb(), { sha256, reason: "csam" });
    const owed = await makeUpload(owner.id, owner.id, { ...SEALED, ...stuck, size: 300, expectedSha256: sha256 });
    await putObject(owed.r2Key, "verified bytes, owed a node");

    expect(await run()).toEqual({ done: true });
    expect(await uploadRow(expired.id)).toMatchObject({ status: "aborted", ...CLEARED });
    expect(await uploadRow(committed.id)).toMatchObject({ status: "done", ...CLEARED });
    expect(await uploadRow(lost.id)).toMatchObject({ status: "aborted", ...CLEARED });
    const kept = (await uploadRow(owed.id))!;
    expect(kept.status).toBe("completing");
    expect(Array.from(kept.ipEncrypted!)).toEqual(Array.from(SEALED.ipEncrypted));
    expect(Array.from(kept.ipIv!)).toEqual(Array.from(SEALED.ipIv));
    expect(kept.ipKeyVersion).toBe(1);
  });
});
