// The Links screen's API (T25 section 8): search by owner or node, the STORED pause reasons, and
// never a URL or a token; lock / unlock, revoke, and the hand-made `anomaly` pause and its lift.
import { describe, expect, it } from "vitest";
import { admin, adminCall, auditOf, linkRowOf, makeFile, makeFolder, makeLink, member } from "./helpers";

async function owned() {
  const who = await admin();
  const owner = await member();
  const folder = await makeFolder(owner.id);
  const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
  const onFile = await makeLink(file.id, owner.id, ["owner", "report"]);
  const onFolder = await makeLink(folder.id, owner.id);
  return { who, owner, folder, file, onFile, onFolder };
}

describe("listing links", () => {
  it("by owner and by node, with the stored pause reasons; no URL, token or password hash in the answer", async () => {
    const t = await owned();
    const byOwner = await adminCall(t.who.as, "GET", `/links?ownerId=${t.owner.id}`);
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.items.map((l: { id: string }) => l.id).sort()).toEqual(
      [t.onFile.id, t.onFolder.id].sort(),
    );
    const byNode = await adminCall(t.who.as, "GET", `/links?nodeId=${t.file.id}`);
    expect(byNode.body.items).toHaveLength(1);
    expect(byNode.body.items[0]).toMatchObject({
      id: t.onFile.id,
      nodeId: t.file.id,
      ownerId: t.owner.id,
      pauseReasons: ["owner", "report"],
      lockedByAdmin: false,
      hasPassword: false,
    });
    for (const banned of ["url", "token", "tokenHash", "tokenEnc", "passwordHash"]) {
      expect(byOwner.text).not.toContain(`"${banned}"`);
    }
    expect(byOwner.text).not.toContain(t.onFile.tokenHash);
    const paused = await adminCall(t.who.as, "GET", `/links?ownerId=${t.owner.id}&paused=true`);
    expect(paused.body.items.map((l: { id: string }) => l.id)).toEqual([t.onFile.id]);
  });
});

describe("acting on a link", () => {
  it("lock and unlock write lockedByAdmin, each audited", async () => {
    const t = await owned();
    const locked = await adminCall(t.who.as, "POST", `/links/${t.onFolder.id}`, { body: { action: "lock" } });
    expect(locked.status).toBe(200);
    expect(locked.body.lockedByAdmin).toBe(true);
    expect((await linkRowOf(t.onFolder.id)).lockedByAdmin).toBe(true);
    expect((await auditOf("admin.link_locked", t.onFolder.id))[0]).toMatchObject({ actorUserId: t.who.id });
    await adminCall(t.who.as, "POST", `/links/${t.onFolder.id}`, { body: { action: "unlock" } });
    expect((await linkRowOf(t.onFolder.id)).lockedByAdmin).toBe(false);
    expect(await auditOf("admin.link_unlocked", t.onFolder.id)).toHaveLength(1);
  });

  it("revoke sets revokedAt and is audited; an unknown link is a 404", async () => {
    const t = await owned();
    const revoked = await adminCall(t.who.as, "POST", `/links/${t.onFolder.id}`, {
      body: { action: "revoke" },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await linkRowOf(t.onFolder.id)).revokedAt).not.toBeNull();
    expect(await auditOf("admin.link_revoked", t.onFolder.id)).toHaveLength(1);
    expect(
      (
        await adminCall(t.who.as, "POST", `/links/0199d3c2-7a10-7000-8000-0000000000aa`, {
          body: { action: "lock" },
        })
      ).status,
    ).toBe(404);
  });

  it("anomaly: pause adds the reason, unpause removes only it — a link also paused `owner` stays paused; both audited with the reason", async () => {
    const t = await owned();
    const live = t.onFolder;
    const pause = await adminCall(t.who.as, "POST", `/links/${live.id}/anomaly`, {
      body: { paused: true, reason: "traffic spike" },
    });
    expect(pause.body.pauseReasons).toEqual(["anomaly"]);
    expect((await auditOf("admin.link_anomaly_paused", live.id))[0]).toMatchObject({
      meta: { reason: "traffic spike" },
    });
    await adminCall(t.who.as, "POST", `/links/${live.id}/anomaly`, {
      body: { paused: false, reason: "explained" },
    });
    expect((await linkRowOf(live.id)).pauseReasons).toEqual([]);
    expect((await linkRowOf(live.id)).pausedAt).toBeNull();
    expect((await auditOf("admin.link_anomaly_unpaused", live.id))[0]).toMatchObject({
      meta: { reason: "explained" },
    });

    await adminCall(t.who.as, "POST", `/links/${t.onFile.id}/anomaly`, {
      body: { paused: true, reason: "x" },
    });
    await adminCall(t.who.as, "POST", `/links/${t.onFile.id}/anomaly`, {
      body: { paused: false, reason: "y" },
    });
    expect((await linkRowOf(t.onFile.id)).pauseReasons.sort()).toEqual(["owner", "report"]);
  });

  it("the anomaly action needs a reason", async () => {
    const t = await owned();
    for (const body of [{ paused: true }, { paused: true, reason: "" }]) {
      expect((await adminCall(t.who.as, "POST", `/links/${t.onFolder.id}/anomaly`, { body })).status).toBe(
        400,
      );
    }
    expect((await linkRowOf(t.onFolder.id)).pauseReasons).toEqual([]);
  });
});
