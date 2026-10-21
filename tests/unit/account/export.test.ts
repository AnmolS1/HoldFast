// GET /api/account/export: what the file holds, what it never holds, and that a held account's
// export is the same as an unheld one's.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ExportManifest } from "../../../src/shared/schemas/account";
import { insertAudit } from "../../../src/worker/db/queries/audit";
import { takedownNode } from "../../../src/worker/db/queries/moderation";
import { nodes, shareLinks, user } from "../../../src/worker/db/schema";
import { makeLink } from "../auth/helpers";
import {
  api,
  auditRows,
  impersonated,
  makeFile,
  makeFolder,
  makeShare,
  person,
  rand,
  testDb,
} from "../nodes/helpers";

type Manifest = ExportManifest;

async function exportOf(who: Awaited<ReturnType<typeof person>>) {
  const answer = await api(who.as, "GET", "/account/export");
  return answer;
}

/**
 * owner's tree:   visible/            ← shared with `partner`; a link with a password
 *                   doc.txt          clean; a link
 *                 gone/               taken down
 *                   mid/
 *                     deep/          ← shared with `partner`
 *                       buried.txt   two folders below the taken-down folder; a link
 *                 locked.bin         suspected_csam; a link
 *                 old.txt            in the trash (exported, with its date)
 *                 asked/             in the trash, permanent deletion asked for
 *                   inside.txt
 *                 (avatar)           the user's avatar node
 * `partner` shares their own folder `theirs/` with the owner.
 */
async function library() {
  const owner = await person({ name: "Export Owner" });
  const partner = await person({ name: "Partner Person" });
  const visible = await makeFolder(owner.id, null, { name: `visible-${rand()}` });
  const doc = await makeFile(owner.id, visible.id, { name: `doc-${rand()}.txt`, scanStatus: "clean" });
  const gone = await makeFolder(owner.id, null, { name: `gone-${rand()}` });
  const mid = await makeFolder(owner.id, gone.id);
  const deep = await makeFolder(owner.id, mid.id);
  const buried = await makeFile(owner.id, deep.id, { name: `buried-${rand()}.txt`, scanStatus: "clean" });
  await takedownNode(testDb(), gone.id, { reason: "abuse", by: null });
  const locked = await makeFile(owner.id, null, {
    name: `locked-${rand()}.bin`,
    scanStatus: "suspected_csam",
  });
  const old = await makeFile(owner.id, null, {
    name: `old-${rand()}.txt`,
    scanStatus: "clean",
    deletedAt: new Date(),
    trashedRoot: true,
  });
  const asked = await makeFolder(owner.id, null, {
    name: `asked-${rand()}`,
    deletedAt: new Date(),
    trashedRoot: true,
    purgeRequestedAt: new Date(),
  });
  const inside = await makeFile(owner.id, asked.id, { name: `inside-${rand()}.txt`, deletedAt: new Date() });
  const avatar = await makeFile(owner.id, null, {
    name: `avatar-${rand()}.png`,
    system: "avatar",
    scanStatus: "clean",
    mimeSniffed: "image/png",
  });
  await testDb().update(user).set({ avatarNodeId: avatar.id }).where(eq(user.id, owner.id));
  await makeShare(visible.id, owner.id, partner.id, { role: "editor" });
  await makeShare(deep.id, owner.id, partner.id);
  const docLink = await makeLink(doc.id, owner.id);
  const folderLink = await makeLink(visible.id, owner.id);
  await testDb()
    .update(shareLinks)
    .set({ passwordHash: "scrypt$made-up" })
    .where(eq(shareLinks.id, folderLink.id));
  const buriedLink = await makeLink(buried.id, owner.id);
  const lockedLink = await makeLink(locked.id, owner.id);
  const theirs = await makeFolder(partner.id, null, { name: `theirs-${rand()}` });
  await makeShare(theirs.id, partner.id, owner.id);
  return {
    owner,
    partner,
    visible,
    doc,
    gone,
    mid,
    deep,
    buried,
    locked,
    old,
    asked,
    inside,
    avatar,
    theirs,
    links: { docLink, folderLink, buriedLink, lockedLink },
  };
}

describe("the export", () => {
  it("is a download of ExportManifest: the profile, prefs, own nodes, shares both ways, links, activity", async () => {
    const t = await library();
    await insertAudit(testDb(), {
      actorUserId: t.owner.id,
      actorType: "user",
      action: "auth.sign_in",
      targetType: "user",
      targetId: t.owner.id,
      ipHashDaily: "made-up-hash",
      ua: "Chrome",
      country: "DE",
      requestId: "made-up-request",
      meta: { method: "password", uaFamily: "Chrome on macOS" },
    });
    const answer = await exportOf(t.owner);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-disposition")).toMatch(
      /^attachment; filename="holdfast-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const manifest = ExportManifest.parse(answer.body);
    expect(manifest.user).toMatchObject({
      id: t.owner.id,
      email: t.owner.row.email,
      displayName: "Export Owner",
    });
    const names = manifest.nodes.map((node) => node.name).sort();
    expect(names).toEqual([t.visible.name, t.doc.name, t.old.name].sort());
    expect(manifest.nodes.find((node) => node.id === t.old.id)!.deletedAt).not.toBeNull();
    expect(manifest.shares).toEqual([
      expect.objectContaining({
        nodeId: t.visible.id,
        role: "editor",
        email: `${t.partner.id.toLowerCase()}@services-core.example.test`,
      }),
    ]);
    expect(manifest.sharedWithMe).toEqual([
      { nodeId: t.theirs.id, name: t.theirs.name, role: "viewer", ownerDisplayName: "Partner Person" },
    ]);
    expect(manifest.links.map((link) => [link.id, link.hasPassword, link.state]).sort()).toEqual(
      [
        [t.links.docLink.id, false, "active"],
        [t.links.folderLink.id, true, "active"],
      ].sort(),
    );
    expect(manifest.activity.map((row) => [row.action, row.outcome, row.uaLabel, row.country])).toEqual([
      ["auth.sign_in", "ok", "Chrome on macOS", "DE"],
    ]);
    expect(await auditRows({ action: "account.export", targetId: t.owner.id })).toHaveLength(1);
  });

  it("holds no secret, no URL, no object key, no avatar and nothing hidden — nor any share or link that names it", async () => {
    const t = await library();
    const answer = await exportOf(t.owner);
    const text = JSON.stringify(answer.body);
    // Exactly the contract's fields: the parsed form is the whole body.
    expect(answer.body).toEqual(ExportManifest.parse(answer.body));
    for (const hidden of [t.gone, t.mid, t.deep, t.buried, t.locked, t.asked, t.inside, t.avatar]) {
      expect(text, hidden.name).not.toContain(hidden.id);
      expect(text, hidden.name).not.toContain(hidden.name);
    }
    for (const link of Object.values(t.links)) {
      expect(text).not.toContain(link.tokenHash);
      expect(text).not.toContain(Buffer.from(link.tokenEnc).toString("base64"));
    }
    expect(text).not.toContain(t.links.buriedLink.id);
    expect(text).not.toContain(t.links.lockedLink.id);
    for (const row of await testDb().select().from(nodes).where(eq(nodes.ownerId, t.owner.id))) {
      if (row.r2Key) expect(text).not.toContain(row.r2Key);
      if (row.versionId) expect(text).not.toContain(row.versionId);
    }
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/scrypt|r2Key|token|"password"|passwordHash|legalHold|avatar/i);
    expect(text).not.toContain("made-up");
  });

  it("is refused under impersonation (403) and writes no audit row", async () => {
    const t = await library();
    const answer = await api(impersonated(t.owner), "GET", "/account/export");
    expect(answer.status).toBe(403);
    expect(await auditRows({ action: "account.export", targetId: t.owner.id })).toHaveLength(0);
  });

  it("still works for its owner inside the deletion window — as does the owner's own download URL", async () => {
    const t = await library();
    await testDb()
      .update(user)
      .set({ deleteScheduledAt: new Date(Date.now() + 7 * 86_400_000) })
      .where(eq(user.id, t.owner.id));
    const owner = {
      ...t.owner.as,
      user: { ...t.owner.as.user, deleteScheduledAt: new Date(Date.now() + 7 * 86_400_000) },
    };
    const exported = await api(owner, "GET", "/account/export");
    expect(exported.status).toBe(200);
    expect(ExportManifest.parse(exported.body).nodes.map((node) => node.id)).toContain(t.doc.id);
    const url = await api(owner, "POST", `/nodes/${t.doc.id}/download-url`, { body: { kind: "download" } });
    expect(url.status).toBe(200);
    expect(url.body.url).toMatch(/^http:\/\/files\.localhost\//);
  });
});

describe("a held account", () => {
  /** The same small library for a new account, and a file in it deleted for good through the routes. */
  async function deletedForGood(legalHold: boolean) {
    const who = await person({ name: "Same Name", legalHold, timezone: "UTC" });
    const kept = await makeFile(who.id, null, { name: "kept.txt", scanStatus: "clean", size: 100 });
    const doomed = await makeFile(who.id, null, { name: "doomed.txt", scanStatus: "clean", size: 100 });
    const folder = await makeFolder(who.id, null, { name: "folder" });
    await makeFile(who.id, folder.id, { name: "in-folder.txt", scanStatus: "clean", size: 100 });
    // The counter as uploads would have left it: the three files.
    await testDb().update(user).set({ usedBytes: 300 }).where(eq(user.id, who.id));
    expect((await api(who.as, "POST", `/nodes/${doomed.id}/trash`)).status).toBe(200);
    expect((await api(who.as, "POST", `/nodes/${folder.id}/trash`)).status).toBe(200);
    expect((await api(who.as, "DELETE", `/nodes/${doomed.id}`)).status).toBe(204);
    expect((await api(who.as, "DELETE", `/nodes/${folder.id}`)).status).toBe(204);
    return { who, kept, doomed };
  }

  /** Everything but what differs by construction: ids, the address, the instants — and usedBytes (see below). */
  function shape(manifest: Manifest) {
    return {
      user: { ...manifest.user, id: "", email: "", createdAt: "" },
      prefs: manifest.prefs,
      nodes: manifest.nodes
        .map((node) => [node.name, node.kind, node.deletedAt !== null, node.scanStatus])
        .sort(),
      shares: manifest.shares.length,
      sharedWithMe: manifest.sharedWithMe.length,
      links: manifest.links.length,
      activity: manifest.activity.map((row) => row.action),
    };
  }

  it("after a permanent deletion, a held and an unheld account export alike: the deleted rows are in neither", async () => {
    const held = await deletedForGood(true);
    const free = await deletedForGood(false);
    // Control, same run: the unheld rows really went, the held ones are still there.
    const left = async (id: string) => (await testDb().select().from(nodes).where(eq(nodes.id, id))).length;
    expect(await left(free.doomed.id)).toBe(0);
    expect(await left(held.doomed.id)).toBe(1);
    const a = ExportManifest.parse((await exportOf(held.who)).body);
    const b = ExportManifest.parse((await exportOf(free.who)).body);
    expect(a.nodes.map((node) => node.name)).toEqual(["kept.txt"]);
    expect(shape(a)).toEqual(shape(b));
    // `usedBytes` included: the stored counter still holds the held root's bytes (T14: "the meter
    // moved by the un-held file only"); the export answers it without them.
    expect(a.user.usedBytes).toBe(b.user.usedBytes);
    expect(a.user.usedBytes).toBe(100);
  });
});
