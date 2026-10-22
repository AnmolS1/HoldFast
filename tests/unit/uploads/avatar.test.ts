// The avatar path: one PUT under a/, scanned synchronously at complete (no notification is sent
// for a key outside u/), a system node outside the quota — and only ONE of them per user.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { NodeDto } from "../../../src/shared/schemas/node";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { hashBlocklist, nodes, reports, user as userTable } from "../../../src/worker/db/schema";
import { BLOCKED_MESSAGE } from "../../../src/worker/routes/uploads";
import { eicarBytes, pngBytes } from "../../setup/fixture-bytes";
import { auditRows, mailTo, nodeById, testDb } from "../services-core/helpers";
import {
  auditFor,
  complete,
  init,
  putSingle,
  sessionRow,
  sha,
  sha256Of,
  strikesOf,
  uploader,
  usedBytes,
  userRow,
  watchedBucket,
  type UserRow,
} from "./helpers";

const PNG = pngBytes(32, 32);
/** Another picture: the same PNG with bytes after its end (still a PNG to the type detector). */
const picture = (n: number) => {
  const bytes = new Uint8Array(PNG.byteLength + 4);
  bytes.set(PNG);
  new DataView(bytes.buffer).setUint32(PNG.byteLength, n);
  return bytes;
};

/** A picture nobody else has: the PNG with a per-run random tail (the blocklist is shared). */
const uniquePicture = () => {
  const bytes = new Uint8Array(PNG.byteLength + 16);
  bytes.set(PNG);
  crypto.getRandomValues(bytes.subarray(PNG.byteLength));
  return bytes;
};

const avatarNodes = (userId: string) =>
  testDb()
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, userId), eq(nodes.system, "avatar")));
const avatarObjects = async (userId: string) =>
  (await env.FILES.list({ prefix: `a/${userId}/` })).objects.map((object) => object.key);

async function sendAvatar(
  user: UserRow,
  bytes: Uint8Array,
  options: Parameters<typeof complete>[3] = {},
  /** The hash the client declares; random when not given (`complete`'s default). */
  declared?: string,
) {
  const session = await init(user, {
    purpose: "avatar",
    mimeDeclared: "image/png",
    name: "me.png",
    size: bytes.byteLength,
    fileLastModified: new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString(),
  });
  expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
  const sent: unknown[] = [];
  const answer = await complete(user, session.uploadId, declared ? { sha256: declared } : {}, {
    ...options,
    sent,
  });
  return { session, answer, sent };
}

describe("avatar", () => {
  it("is scanned at complete and written with its verdict: a system node under a/, outside the quota, set as the user's avatar", async () => {
    const user = await uploader();
    const { session, answer, sent } = await sendAvatar(user, PNG);
    expect(answer.status).toBe(201);
    const dto = NodeDto.parse(answer.body);
    expect(dto).toMatchObject({
      scanStatus: "clean",
      mimeSniffed: "image/png",
      parentId: null,
      role: "owner",
    });
    const row = (await sessionRow(session.uploadId))!;
    expect(await nodeById(dto.id)).toMatchObject({
      system: "avatar",
      parentId: null,
      r2Key: `a/${user.id}/${dto.id}`,
      scanStatus: "clean",
      ownerId: user.id,
    });
    expect((await nodeById(dto.id))!.scannedAt).not.toBeNull();
    expect(row.status).toBe("done");
    expect((await userRow(user.id)).avatarNodeId).toBe(dto.id);
    // Never the quota, and no scan message: the verdict was written before the answer.
    expect(await usedBytes(user.id)).toBe(0);
    expect(sent).toEqual([]);
    expect(await auditFor("account.avatar_replaced", user.id)).toHaveLength(1);
  });

  it("bytes that are not a picture are not stored at all, whatever type was declared", async () => {
    const user = await uploader();
    const first = await sendAvatar(user, PNG);
    const current = String(first.answer.body.id);
    for (const bytes of [
      new Uint8Array(5000),
      new TextEncoder().encode("<svg onload=alert(1)>"),
      // Per-run random bytes that are no picture (T21, Addendum 3 Q4): the case is the format
      // check — fixed content may be on the shared blocklist once any verdict listed it.
      crypto.getRandomValues(new Uint8Array(5000)),
    ]) {
      const { session, answer } = await sendAvatar(user, bytes);
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe("validation");
      const row = (await sessionRow(session.uploadId))!;
      expect(row.status).toBe("aborted");
      expect(await env.FILES.head(row.r2Key)).toBeNull();
    }
    expect((await userRow(user.id)).avatarNodeId).toBe(current);
    expect(await avatarNodes(user.id)).toHaveLength(1);
    expect(await avatarObjects(user.id)).toHaveLength(1);
  });

  it("ten avatars in a row leave ONE avatar node and one object", async () => {
    const user = await uploader();
    let last = "";
    for (let n = 0; n < 10; n++) {
      const { answer } = await sendAvatar(user, picture(n));
      expect(answer.status).toBe(201);
      last = String(answer.body.id);
    }
    expect((await avatarNodes(user.id)).map((node) => node.id)).toEqual([last]);
    expect(await avatarObjects(user.id)).toEqual([`a/${user.id}/${last}`]);
    expect((await userRow(user.id)).avatarNodeId).toBe(last);
    expect(await usedBytes(user.id)).toBe(0);
    expect(await auditFor("account.avatar_replaced", user.id)).toHaveLength(10);
  });

  it("a picture the scanner flags is written with its verdict but does not become the avatar — and goes with the next good one", async () => {
    const user = await uploader();
    const good = await sendAvatar(user, picture(1));
    // EICAR with a per-run tail (Common addendum 3): fixed content that reaches a verdict may be
    // on the shared blocklist once any verdict listed it.
    const flagged = new Uint8Array(PNG.byteLength + 68 + 16);
    flagged.set(PNG);
    flagged.set(eicarBytes(), PNG.byteLength);
    crypto.getRandomValues(flagged.subarray(PNG.byteLength + 68));
    const bad = await sendAvatar(user, flagged);
    expect(bad.answer.status).toBe(201);
    expect(bad.answer.body.scanStatus).toBe("infected");
    expect((await userRow(user.id)).avatarNodeId).toBe(good.answer.body.id);
    expect(await avatarNodes(user.id)).toHaveLength(2);
    // Another flagged one replaces the first flagged one: never more than the avatar and one more.
    // (Other bytes: the first one's hash is on the blocklist now — see "an infected avatar" below.)
    const flagged2 = flagged.slice();
    crypto.getRandomValues(flagged2.subarray(PNG.byteLength + 68));
    expect((await sendAvatar(user, flagged2)).answer.body.scanStatus).toBe("infected");
    expect(await avatarNodes(user.id)).toHaveLength(2);
    const next = await sendAvatar(user, picture(2));
    expect((await avatarNodes(user.id)).map((node) => node.id)).toEqual([next.answer.body.id]);
    expect(await avatarObjects(user.id)).toHaveLength(1);
  });

  it("a user on legal hold keeps the old avatar — row and object — and the new one still becomes current", async () => {
    const user = await uploader();
    const old = await sendAvatar(user, picture(1));
    await testDb().update(userTable).set({ legalHold: true }).where(eq(userTable.id, user.id));
    const next = await sendAvatar(user, picture(2));
    expect(next.answer.status).toBe(201);
    expect((await userRow(user.id)).avatarNodeId).toBe(next.answer.body.id);
    expect((await avatarNodes(user.id)).map((node) => node.id).sort()).toEqual(
      [String(old.answer.body.id), String(next.answer.body.id)].sort(),
    );
    expect(await avatarObjects(user.id)).toHaveLength(2);
    const [row] = (await auditFor("account.avatar_replaced", user.id)).slice(-1);
    expect(row!.meta).toMatchObject({ removed: 0, keptHeld: 1 });
    // Control: the hold lifted, the next upload removes both older ones.
    await testDb().update(userTable).set({ legalHold: false }).where(eq(userTable.id, user.id));
    const last = await sendAvatar(user, picture(3));
    expect((await avatarNodes(user.id)).map((node) => node.id)).toEqual([last.answer.body.id]);
    expect(await avatarObjects(user.id)).toHaveLength(1);
  });

  it("an old avatar that is itself held stays, too", async () => {
    const user = await uploader();
    const old = await sendAvatar(user, picture(1));
    await testDb()
      .update(nodes)
      .set({ legalHold: true })
      .where(eq(nodes.id, String(old.answer.body.id)));
    const next = await sendAvatar(user, picture(2));
    expect(next.answer.status).toBe(201);
    expect(await avatarNodes(user.id)).toHaveLength(2);
    expect(await env.FILES.head(`a/${user.id}/${old.answer.body.id}`)).not.toBeNull();
  });

  it("the old object's delete failing after the commit does not fail the request: the row is gone, the object is an orphan", async () => {
    const user = await uploader();
    const old = await sendAvatar(user, picture(1));
    const watched = watchedBucket(["delete"]);
    const next = await sendAvatar(user, picture(2), { env: { FILES: watched.bucket } });
    expect(next.answer.status).toBe(201);
    expect(watched.calls["delete"]).toBeGreaterThan(0);
    expect((await avatarNodes(user.id)).map((node) => node.id)).toEqual([next.answer.body.id]);
    expect(await env.FILES.head(`a/${user.id}/${old.answer.body.id}`)).not.toBeNull();
    expect((await userRow(user.id)).avatarNodeId).toBe(next.answer.body.id);
  });
});

// T21 R3: the blocklist is consulted with the hash THE SERVER computed of the avatar's bytes —
// the client's declared hash (random in every case below) is trusted for nothing.
describe("avatar: the blocklist acts on the server's hash, never the declared one", () => {
  async function listedPicture(reason: "csam" | "malware" | "dmca" | "admin") {
    const bytes = uniquePicture();
    const sha256 = await sha256Of(bytes);
    await blocklist.upsert(testDb(), { sha256, reason });
    return { bytes, sha256 };
  }

  it("bytes listed as csam under a lying hash: locked through the CSAM flow — kept, held, reported — never the avatar", async () => {
    const user = await uploader();
    const good = await sendAvatar(user, uniquePicture());
    const known = await listedPicture("csam");
    const declared = sha();
    const { session, answer, sent } = await sendAvatar(user, known.bytes, {}, declared);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: "forbidden", message: BLOCKED_MESSAGE });
    const row = (await sessionRow(session.uploadId))!;
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await nodeById(row.nodeId)).toMatchObject({
      scanStatus: "suspected_csam",
      legalHold: true,
      ownerId: user.id,
      sha256: known.sha256,
    });
    expect((await userRow(user.id)).avatarNodeId).toBe(good.answer.body.id);
    expect(await userRow(user.id)).toMatchObject({ legalHold: true });
    expect(await testDb().select().from(reports).where(eq(reports.ownerId, user.id))).toMatchObject([
      { nodeId: row.nodeId, category: "csam", source: "system" },
    ]);
    expect(await strikesOf(user.id)).toHaveLength(0);
    expect(sent).toEqual([]);

    // A repeat answers as a refused (malware) avatar's repeat does: the lock is not told apart.
    const someone = await uploader();
    const malware = await listedPicture("malware");
    const malwareDeclared = sha();
    const refused = await sendAvatar(someone, malware.bytes, {}, malwareDeclared);
    expect(refused.answer.status).toBe(403);
    expect(answer.bytes).toBe(refused.answer.bytes);
    const repeatCsam = await complete(user, session.uploadId, { sha256: declared });
    const repeatMalware = await complete(someone, refused.session.uploadId, { sha256: malwareDeclared });
    expect(repeatCsam.status).toBe(409);
    expect(repeatCsam.bytes).toBe(repeatMalware.bytes);

    // The next avatar's one-per-user sweep leaves the locked node and its object where they are.
    const next = await sendAvatar(user, uniquePicture());
    expect(next.answer.status).toBe(201);
    expect((await userRow(user.id)).avatarNodeId).toBe(next.answer.body.id);
    expect(await nodeById(row.nodeId)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
  });

  for (const [reason, kind] of [
    ["malware", "malware"],
    ["dmca", "dmca"],
    ["admin", "abuse"],
  ] as const) {
    it(`bytes listed as ${reason} under a lying hash: refused like a file — object deleted, session aborted, struck, the avatar unchanged`, async () => {
      const user = await uploader();
      const good = await sendAvatar(user, uniquePicture());
      const known = await listedPicture(reason);
      const { session, answer } = await sendAvatar(user, known.bytes, {}, sha());
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: "forbidden", message: BLOCKED_MESSAGE });
      const row = (await sessionRow(session.uploadId))!;
      expect(row.status).toBe("aborted");
      expect(await env.FILES.head(row.r2Key)).toBeNull();
      expect(await nodeById(row.nodeId)).toBeNull();
      expect((await userRow(user.id)).avatarNodeId).toBe(good.answer.body.id);
      expect(await avatarNodes(user.id)).toHaveLength(1);
      expect(await strikesOf(user.id)).toMatchObject([{ kind, contentSha256: known.sha256 }]);
      expect(await userRow(user.id)).toMatchObject({ legalHold: false });
    });
  }

  it("an unlisted picture under a lying hash is accepted, and the node carries the SERVER's hash", async () => {
    const user = await uploader();
    const bytes = uniquePicture();
    const declared = sha();
    const { answer } = await sendAvatar(user, bytes, {}, declared);
    expect(answer.status).toBe(201);
    const node = (await nodeById(String(answer.body.id)))!;
    expect(node.sha256).toBe(await sha256Of(bytes));
    expect(node.sha256).not.toBe(declared);
    expect((await userRow(user.id)).avatarNodeId).toBe(answer.body.id);
  });
});

/** A picture the stub scanner flags: the PNG, EICAR, and a per-run tail. */
const infectedPicture = () => {
  const bytes = new Uint8Array(PNG.byteLength + 68 + 16);
  bytes.set(PNG);
  bytes.set(eicarBytes(), PNG.byteLength);
  crypto.getRandomValues(bytes.subarray(PNG.byteLength + 68));
  return bytes;
};

// AVSEAM (a): an infected avatar is handled as the scan consumer handles an infected file — its
// server hash listed `malware` (source: the node), the uploader struck, the notice sent.
describe("an infected avatar", () => {
  it("is listed malware by its server hash, struck once, noticed — and the same bytes again are refused as listed", async () => {
    const user = await uploader();
    const good = await sendAvatar(user, uniquePicture());
    const bytes = infectedPicture();
    const sha256 = await sha256Of(bytes);
    const bad = await sendAvatar(user, bytes);
    expect(bad.answer.status).toBe(201);
    expect(bad.answer.body.scanStatus).toBe("infected");
    const nodeId = String(bad.answer.body.id);
    expect((await userRow(user.id)).avatarNodeId).toBe(good.answer.body.id);
    expect(await testDb().select().from(hashBlocklist).where(eq(hashBlocklist.sha256, sha256))).toMatchObject(
      [{ reason: "malware", sourceNodeId: nodeId }],
    );
    expect(await strikesOf(user.id)).toMatchObject([
      { kind: "malware", nodeId, contentSha256: sha256, liftedAt: null },
    ]);
    expect(await auditRows({ action: "scan.infected", targetId: nodeId })).toHaveLength(1);
    expect(mailTo(user.email, "quarantineNotice")).toHaveLength(1);

    // The same bytes again (any declared hash): the blocklist refuses them — still ONE strike.
    const again = await sendAvatar(user, bytes, {}, sha());
    expect(again.answer.status).toBe(403);
    expect(again.answer.body).toMatchObject({ error: "forbidden", message: BLOCKED_MESSAGE });
    expect(await strikesOf(user.id)).toHaveLength(1);
    expect((await userRow(user.id)).avatarNodeId).toBe(good.answer.body.id);
  });

  it("a clean avatar lists nothing and strikes nobody (the control)", async () => {
    const user = await uploader();
    const bytes = uniquePicture();
    const { answer } = await sendAvatar(user, bytes);
    expect(answer.status).toBe(201);
    expect(
      await testDb()
        .select()
        .from(hashBlocklist)
        .where(eq(hashBlocklist.sha256, await sha256Of(bytes))),
    ).toHaveLength(0);
    expect(await strikesOf(user.id)).toHaveLength(0);
    expect(mailTo(user.email, "quarantineNotice")).toHaveLength(0);
  });
});
