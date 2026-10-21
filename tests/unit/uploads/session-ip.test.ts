// The uploader's sealed address on the upload session (ruling 2026-10-21, T22 (0c)), through the
// real routes: init seals the request's address on the session exactly as complete seals it for
// `upload_ips`; every way a session ends clears it; an unfinished session that owes a locked node
// keeps it for the repair sweep; and no answer or audit row ever carries it.
// The addresses below are from the documentation ranges (RFC 5737): made up, not anyone's.
import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { SINGLE_PUT_MAX } from "../../../src/shared/constants";
import { describe, expect, it } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { sealedIpOf } from "../../../src/worker/db/queries/uploads";
import { auditLog, shares } from "../../../src/worker/db/schema";
import { openIp } from "../../../src/worker/services/tokens";
import { auditRows, makeFolder, makeShare, testDb } from "../services-core/helpers";
import {
  call,
  GB,
  complete,
  init,
  initBody,
  putSingle,
  sessionRow,
  sha256Of,
  uniqueBytes,
  uploaded,
  uploader,
  type UserRow,
} from "./helpers";

const AT_INIT = "203.0.113.45";
const AT_RESUME = "198.51.100.9";
const AT_COMPLETE = "192.0.2.200";
const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });

const CLEARED = { ipEncrypted: null, ipIv: null, ipKeyVersion: null };

async function sealedOn(uploadId: string) {
  const row = (await sessionRow(uploadId))!;
  return sealedIpOf(row);
}

/** True when the session holds the given address, sealed. Never prints either. */
async function holds(uploadId: string, ip: string): Promise<boolean> {
  const sealed = await sealedOn(uploadId);
  return sealed !== null && (await openIp(env, sealed)) === ip;
}

/** Text that must not reach an answer or an audit row: the address, and the sealed bytes. */
async function secretsOf(uploadId: string): Promise<string[]> {
  const row = (await sessionRow(uploadId))!;
  const out: string[] = [];
  for (const bytes of [row.ipEncrypted, row.ipIv]) {
    if (!bytes) continue;
    const u8 = new Uint8Array(bytes);
    out.push(btoa(String.fromCharCode(...u8)));
    out.push([...u8].map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return out;
}

const NAMES = /ip_?enc|ipEncrypted|ip_?iv|keyVersion|key_version|sealed/i;
function assertClean(text: string, secrets: string[], what: string) {
  expect(NAMES.test(text), `${what} names the sealed address`).toBe(false);
  for (const ip of [AT_INIT, AT_RESUME, AT_COMPLETE]) expect(text.includes(ip), `${what} carries an address`).toBe(false);
  for (const s of secrets) expect(text.includes(s), `${what} carries the sealed bytes`).toBe(false);
}

type Reason = "malware" | "csam";
async function listed(reason: Reason) {
  const bytes = uniqueBytes();
  const sha256 = await sha256Of(bytes);
  await blocklist.upsert(testDb(), { sha256, reason });
  return { bytes, sha256 };
}

/** An editor's session in another user's folder, uploaded from AT_INIT; `revoke` takes the share. */
async function editorSession(bytes: Uint8Array) {
  const owner = await uploader();
  const editor = await uploader();
  const folder = await makeFolder(owner.id);
  const share = await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
  const session = await uploaded(editor, { parentId: folder.id }, bytes, from(AT_INIT));
  const revoke = () => testDb().delete(shares).where(eq(shares.id, share.id));
  return { owner, editor, session, revoke };
}

describe("init seals the uploader's address on the session", () => {
  it("with sealIp: the same encryption as upload_ips — it opens to the request's address", async () => {
    const user = await uploader();
    const session = await init(user, {}, from(AT_INIT));
    const row = (await sessionRow(session.uploadId))!;
    expect(row.status).toBe("open");
    expect(row.ipKeyVersion).toBe(1);
    expect(row.ipIv!.byteLength).toBe(12);
    expect(await holds(session.uploadId, AT_INIT)).toBe(true);
    // Control: it is the request's address, not any address.
    expect(await holds(session.uploadId, AT_RESUME)).toBe(false);
  });

  it("an avatar session too, and a multipart one", async () => {
    const user = await uploader({ quotaBytes: 20 * GB });
    const avatar = await init(user, { purpose: "avatar", mimeDeclared: "image/png", size: 100 }, from(AT_INIT));
    expect(await holds(avatar.uploadId, AT_INIT)).toBe(true);
    const big = await init(user, { size: SINGLE_PUT_MAX + 1 }, from(AT_INIT));
    expect(big.mode).toBe("multipart");
    expect(await holds(big.uploadId, AT_INIT)).toBe(true);
  });

  it("DECISION: a resume keeps the address of the init that created the session — nothing is written on that path", async () => {
    const user = await uploader();
    const body = initBody();
    const first = await call<{ uploadId: string }>(user, "POST", "/uploads", { json: body, ...from(AT_INIT) });
    expect(first.status).toBe(201);
    const before = (await sessionRow(first.body.uploadId))!;
    const again = await call<{ uploadId: string }>(user, "POST", "/uploads", { json: body, ...from(AT_RESUME) });
    expect(again.status).toBe(200);
    expect(again.body.uploadId).toBe(first.body.uploadId);
    const after = (await sessionRow(first.body.uploadId))!;
    expect(Array.from(after.ipEncrypted!)).toEqual(Array.from(before.ipEncrypted!));
    expect(Array.from(after.ipIv!)).toEqual(Array.from(before.ipIv!));
    expect(await holds(first.body.uploadId, AT_INIT)).toBe(true);
  });
});

describe("every way a session ends through the routes clears it", () => {
  it("complete → done", async () => {
    const user = await uploader();
    const session = await uploaded(user, {}, undefined, from(AT_INIT));
    expect(await holds(session.uploadId, AT_INIT)).toBe(true);
    const answer = await complete(user, session.uploadId, {}, from(AT_COMPLETE));
    expect(answer.status).toBe(201);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done", ...CLEARED });
  });

  it("DELETE /uploads/:id → aborted", async () => {
    const user = await uploader();
    const session = await init(user, {}, from(AT_INIT));
    const answer = await call(user, "DELETE", `/uploads/${session.uploadId}`, from(AT_INIT));
    expect(answer.status).toBe(204);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted", ...CLEARED });
  });

  it("blocked content (refuseBlocked) → aborted", async () => {
    const user = await uploader();
    const { bytes, sha256 } = await listed("malware");
    const session = await uploaded(user, {}, bytes, from(AT_INIT));
    const answer = await complete(user, session.uploadId, { sha256 }, from(AT_COMPLETE));
    expect(answer.status).toBe(403);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted", ...CLEARED });
  });

  it("suspected CSAM, written in place → done", async () => {
    const user = await uploader();
    const { bytes, sha256 } = await listed("csam");
    const session = await uploaded(user, {}, bytes, from(AT_INIT));
    const answer = await complete(user, session.uploadId, { sha256 }, from(AT_COMPLETE));
    expect(answer.status).toBe(403);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done", ...CLEARED });
  });

  it("suspected CSAM given up by complete (preserveAndEnd: the share was revoked) → aborted", async () => {
    const { bytes, sha256 } = await listed("csam");
    const { editor, session, revoke } = await editorSession(bytes);
    await revoke();
    const answer = await complete(editor, session.uploadId, { sha256 }, from(AT_COMPLETE));
    expect(answer.status).toBe(404);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted", ...CLEARED });
  });

  it("an ordinary upload complete gives up (abandonClaimed: the share was revoked) → aborted", async () => {
    const { editor, session, revoke } = await editorSession(uniqueBytes());
    await revoke();
    const answer = await complete(editor, session.uploadId, {}, from(AT_COMPLETE));
    expect(answer.status).toBe(404);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted", ...CLEARED });
  });
});

describe("a session that owes a locked node keeps it — the repair sweep's only source", () => {
  it("the node cannot be written (oweNode): still completing, and the address is the init's", async () => {
    const { bytes, sha256 } = await listed("csam");
    const { editor, session, revoke } = await editorSession(bytes);
    await revoke();
    const answer = await complete(
      editor,
      session.uploadId,
      { sha256 },
      {
        ...from(AT_COMPLETE),
        beforeCommit: (attempt) => {
          if (attempt === 1) throw new Error("test: the node cannot be written");
        },
      },
    );
    expect(answer.status).toBe(404);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "completing" });
    expect(await holds(session.uploadId, AT_INIT)).toBe(true);
    expect((await auditRows({ action: "upload.csam_node_owed", targetId: session.uploadId })).length).toBe(1);
  });
});

describe("never exposed", () => {
  it("not in init's answer, a resume's, GET /uploads/open, a part or single PUT, complete's — nor in any audit row of the session", async () => {
    const user: UserRow = await uploader();
    const body = initBody();
    const created = await call<{ uploadId: string }>(user, "POST", "/uploads", { json: body, ...from(AT_INIT) });
    const id = created.body.uploadId;
    const secrets = await secretsOf(id);
    expect(secrets.length).toBe(4); // the scan below is looking for something
    assertClean(created.bytes, secrets, "init");
    const resumed = await call(user, "POST", "/uploads", { json: body, ...from(AT_RESUME) });
    assertClean(resumed.bytes, secrets, "resume");
    const open = await call(user, "GET", "/uploads/open", from(AT_INIT));
    expect(open.status).toBe(200);
    expect(JSON.stringify(open.body)).toContain(id);
    assertClean(JSON.stringify(open.body), secrets, "GET /uploads/open");
    const put = await putSingle(user, id, new Uint8Array(body.size), from(AT_INIT));
    assertClean(put.bytes, secrets, "single PUT");
    const done = await complete(user, id, {}, from(AT_COMPLETE));
    expect(done.status).toBe(201);
    assertClean(done.bytes, secrets, "complete");

    // The audit rows of the session and of the node it became, and of a blocked upload.
    const { bytes, sha256 } = await listed("malware");
    const blocked = await uploaded(user, {}, bytes, from(AT_INIT));
    const blockedSecrets = await secretsOf(blocked.uploadId);
    await complete(user, blocked.uploadId, { sha256 }, from(AT_COMPLETE));
    const node = (await sessionRow(id))!.nodeId;
    const rows = await testDb()
      .select()
      .from(auditLog)
      .where(inArray(auditLog.targetId, [id, node, blocked.uploadId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) assertClean(JSON.stringify(row), [...secrets, ...blockedSecrets], `audit ${row.action}`);
  });
});
