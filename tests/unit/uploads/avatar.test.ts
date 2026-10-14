// The avatar path: one PUT under a/, scanned synchronously at complete (no notification is sent
// for a key outside u/), a system node outside the quota — and only ONE of them per user.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { NodeDto } from "../../../src/shared/schemas/node";
import { nodes, user as userTable } from "../../../src/worker/db/schema";
import { eicarBytes, pngBytes } from "../../setup/fixture-bytes";
import { nodeById, testDb } from "../services-core/helpers";
import {
  auditFor,
  complete,
  init,
  putSingle,
  sessionRow,
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

const avatarNodes = (userId: string) =>
  testDb()
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, userId), eq(nodes.system, "avatar")));
const avatarObjects = async (userId: string) =>
  (await env.FILES.list({ prefix: `a/${userId}/` })).objects.map((object) => object.key);

async function sendAvatar(user: UserRow, bytes: Uint8Array, options: Parameters<typeof complete>[3] = {}) {
  const session = await init(user, {
    purpose: "avatar",
    mimeDeclared: "image/png",
    name: "me.png",
    size: bytes.byteLength,
    fileLastModified: new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString(),
  });
  expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
  const sent: unknown[] = [];
  const answer = await complete(user, session.uploadId, {}, { ...options, sent });
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
      eicarBytes(),
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
    const flagged = new Uint8Array(PNG.byteLength + 68);
    flagged.set(PNG);
    flagged.set(eicarBytes(), PNG.byteLength);
    const bad = await sendAvatar(user, flagged);
    expect(bad.answer.status).toBe(201);
    expect(bad.answer.body.scanStatus).toBe("infected");
    expect((await userRow(user.id)).avatarNodeId).toBe(good.answer.body.id);
    expect(await avatarNodes(user.id)).toHaveLength(2);
    // Another flagged one replaces the first flagged one: never more than the avatar and one more.
    await sendAvatar(user, flagged);
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
