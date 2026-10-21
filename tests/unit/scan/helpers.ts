// Shared by the scan pipeline's tests (T21). Runs inside workerd against this checkout's local
// Postgres, the local object store and the local queue — `SCAN_STUB=1` (the test vars), so the
// real pipeline runs with the stub SCANNER.
//
// Postgres is shared by every file and every run: random ids everywhere, no table-wide counts.
// INFECTED CONTENT IS UNIQUE PER TEST (`infectedBytes`): an infected verdict lists its hash, so
// the bare EICAR file's listing would be shared by every file of the run.
import { eq } from "drizzle-orm";
import { uuidv7 } from "../../../src/worker/db/ids";
import { hashBlocklist, reports, strikes } from "../../../src/worker/db/schema";
import { keyFor } from "../../../src/worker/services/storage";
import { eicarBytes } from "../../setup/fixture-bytes";
import { makeFile, makeUpload, makeUser, putObject, rand, testDb } from "../services-core/helpers";

export {
  auditRows,
  deliver,
  eventually,
  jobsFor,
  makeFile,
  makeFolder,
  makeUpload,
  makeUser,
  mailTo,
  nodeById,
  putObject,
  r2Event,
  rand,
  serviceDeps,
  testDb,
} from "../services-core/helpers";

export const enc = (text: string) => new TextEncoder().encode(text);

/** EICAR followed by bytes no other test has: infected for the stub, and a hash of its own. */
export function infectedBytes(): Uint8Array {
  const tail = enc(`\n${rand(16)}\n`);
  const out = new Uint8Array(eicarBytes().length + tail.length);
  out.set(eicarBytes(), 0);
  out.set(tail, eicarBytes().length);
  return out;
}

/** Harmless bytes no other test has. */
export const cleanBytes = (label = "harmless") => enc(`${label} ${rand(16)}\n`);

export async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The explicit message T12 sends after its commit. */
export const explicit = (node: { id: string; r2Key: string | null }, force?: boolean) => ({
  v: 1,
  nodeId: node.id,
  key: node.r2Key,
  ...(force === undefined ? {} : { force }),
});

export type UserRow = Awaited<ReturnType<typeof makeUser>>;

type FileOpts = Parameters<typeof makeFile>[2] & {
  /** The hash the client declared at complete: a `done` session row is written with it. */
  declared?: string | null;
  /** Write no session row at all (a trimmed session). */
  noSession?: boolean;
  owner?: UserRow;
  uploader?: UserRow;
  parentId?: string | null;
};

/**
 * A `pending` file whose object holds `bytes`, uploaded the way T12 leaves it: a `done` session
 * on its key that declared `declared` (default: the bytes' real hash), and `nodes.sha256` the
 * declared value with `scannedAt` null.
 */
export async function uploadedFile(bytes: Uint8Array, opts: FileOpts = {}) {
  const owner = opts.owner ?? (await makeUser());
  const uploader = opts.uploader ?? owner;
  const id = opts.id ?? uuidv7();
  const versionId = opts.versionId ?? uuidv7();
  const declared = opts.declared === undefined ? await sha256Of(bytes) : opts.declared;
  const { declared: _d, noSession, owner: _o, uploader: _u, parentId, ...overrides } = opts;
  void _d;
  void _o;
  void _u;
  const file = await makeFile(owner.id, parentId ?? null, {
    id,
    versionId,
    createdBy: uploader.id,
    sha256: declared,
    size: bytes.length,
    scanStatus: "pending",
    ...overrides,
  });
  if (!noSession) {
    await makeUpload(owner.id, uploader.id, {
      nodeId: id,
      versionId,
      r2Key: keyFor(owner.id, id, versionId),
      size: bytes.length,
      status: "done",
      completedAt: new Date(),
      expectedSha256: declared,
    });
  }
  await putObject(file.r2Key!, bytes);
  return { file, owner, uploader };
}

export async function strikesOf(userId: string) {
  return testDb().select().from(strikes).where(eq(strikes.userId, userId));
}

export async function listing(sha256: string) {
  const [row] = await testDb().select().from(hashBlocklist).where(eq(hashBlocklist.sha256, sha256));
  return row ?? null;
}

export async function listAs(sha256: string, reason: "malware" | "csam" | "dmca" | "admin") {
  await testDb()
    .insert(hashBlocklist)
    .values({ sha256, reason })
    .onConflictDoUpdate({ target: hashBlocklist.sha256, set: { reason } });
}

export async function reportsOf(nodeId: string) {
  return testDb().select().from(reports).where(eq(reports.nodeId, nodeId));
}

/** Everything about a node that opens or closes access — what a verdict that is "left" keeps. */
export const accessOf = (row: Record<string, unknown> | null) => ({
  scanStatus: row?.scanStatus,
  scanStatusPrev: row?.scanStatusPrev,
  scanReason: row?.scanReason,
  takedownAt: row?.takedownAt,
  takedownReason: row?.takedownReason,
  legalHold: row?.legalHold,
  r2Key: row?.r2Key,
});
