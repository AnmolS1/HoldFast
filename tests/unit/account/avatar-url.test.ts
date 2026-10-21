// GET /api/account/avatar-url/:userId — who may see an avatar. Decided here alone: the files host
// does not ask again for an avatar thumbnail (gate 4d).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createKeys } from "../../../src/worker/services/keys";
import { verifyDownloadToken } from "../../../src/worker/services/tokens";
import { takedownNode } from "../../../src/worker/db/queries/moderation";
import { user, type ScanStatus } from "../../../src/worker/db/schema";
import { makePendingShare } from "../auth/helpers";
import {
  api,
  comparable,
  impersonated,
  makeFile,
  makeFolder,
  makeShare,
  person,
  rand,
  testDb,
} from "../nodes/helpers";
import { env } from "cloudflare:workers";

const keysFor = () => createKeys(env.FILES_TOKEN_SECRET);

async function withAvatar(scanStatus: ScanStatus = "clean") {
  const who = await person();
  const node = await makeFile(who.id, null, {
    name: `avatar-${rand()}.png`,
    system: "avatar",
    scanStatus,
    mimeSniffed: "image/png",
  });
  await testDb().update(user).set({ avatarNodeId: node.id }).where(eq(user.id, who.id));
  return { ...who, node };
}

const urlOf = (target: string, size = 160) => `/account/avatar-url/${target}?size=${size}`;

describe("who sees an avatar", () => {
  it("the user themself: a thumbnail URL minted for the requester", async () => {
    const me = await withAvatar();
    const answer = await api(me.as, "GET", urlOf(me.id, 320));
    expect(answer.status).toBe(200);
    const url = new URL(answer.body.url);
    expect(url.origin).toBe(env.FILES_ORIGIN);
    const [, t, nodeId, size, token] = url.pathname.split("/");
    expect([t, nodeId, size]).toEqual(["t", me.node.id, "320"]);
    const claims = await verifyDownloadToken(keysFor(), token!, {
      kind: "thumb",
      nodeId: me.node.id,
      size: 320,
    });
    expect(claims).toMatchObject({ st: "u", sub: me.id, ver: me.node.versionId, k: "thumb" });
    expect(Date.parse(answer.body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("a share partner, in either direction — the token names the REQUESTER", async () => {
    const owner = await withAvatar();
    const grantee = await withAvatar();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, grantee.id);
    const seen = await api(grantee.as, "GET", urlOf(owner.id));
    expect(seen.status).toBe(200);
    const token = new URL(seen.body.url).pathname.split("/")[4]!;
    expect(
      await verifyDownloadToken(keysFor(), token, { kind: "thumb", nodeId: owner.node.id, size: 160 }),
    ).toMatchObject({ sub: grantee.id });
    expect((await api(owner.as, "GET", urlOf(grantee.id))).status).toBe(200);
  });

  it("an admin (role, two-factor, and a session that passed it)", async () => {
    const target = await withAvatar();
    const admin = await person({ role: "admin", twoFactorEnabled: true });
    expect((await api({ ...admin.as, secondFactor: true }, "GET", urlOf(target.id))).status).toBe(200);
    // The role alone is not an admin session.
    expect((await api(admin.as, "GET", urlOf(target.id))).status).toBe(404);
  });

  it("nobody else: a stranger, a pending share, no avatar, a non-clean or hidden avatar — one 404 for the same work", async () => {
    const target = await withAvatar();
    const stranger = await person();
    const pending = await person();
    const folder = await makeFolder(target.id);
    await makePendingShare(folder.id, target.id, pending.row.email);
    const bare = await person();
    const partnerOf = async (other: { id: string }) => {
      const viewer = await person();
      const shared = await makeFolder(other.id);
      await makeShare(shared.id, other.id, viewer.id);
      return viewer;
    };
    const flagged = await withAvatar("infected");
    const unscanned = await withAvatar("pending");
    const takenDown = await withAvatar();
    await takedownNode(testDb(), takenDown.node.id, { reason: "abuse", by: null });

    const cases = [
      ["stranger", await api(stranger.as, "GET", urlOf(target.id))],
      ["pending share", await api(pending.as, "GET", urlOf(target.id))],
      ["no avatar", await api((await partnerOf(bare)).as, "GET", urlOf(bare.id))],
      ["infected", await api((await partnerOf(flagged)).as, "GET", urlOf(flagged.id))],
      ["pending scan", await api((await partnerOf(unscanned)).as, "GET", urlOf(unscanned.id))],
      ["taken down", await api((await partnerOf(takenDown)).as, "GET", urlOf(takenDown.id))],
      ["no such user", await api(stranger.as, "GET", urlOf("Q".repeat(32)))],
    ] as const;
    const reference = comparable(cases[0][1]);
    for (const [name, answer] of cases) {
      expect(answer.status, name).toBe(404);
      expect(comparable(answer), name).toEqual(reference);
      expect(answer.statements, name).toBe(cases[0][1].statements);
    }
  });

  it("refuses an impersonated session (403), a size that is not an avatar size (400), an id that is no user id (404)", async () => {
    const me = await withAvatar();
    expect((await api(impersonated(me), "GET", urlOf(me.id))).status).toBe(403);
    expect((await api(me.as, "GET", urlOf(me.id, 1280))).status).toBe(400);
    expect((await api(me.as, "GET", `/account/avatar-url/${me.id}`)).status).toBe(400);
    expect((await api(me.as, "GET", "/account/avatar-url/not-an-id?size=160")).status).toBe(404);
  });
});
