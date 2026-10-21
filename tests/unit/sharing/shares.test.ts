// Shares to people: create (to an account or to an address with none), change, remove, leave,
// the node's sharing panel, Shared with me and Shared by me. Every address here is made up.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activatePendingShares } from "../../../src/worker/db/queries/shares";
import { nodes, shares, user } from "../../../src/worker/db/schema";
import { freshEmail, verifiedUser } from "../auth/helpers";
import {
  api,
  asCaller,
  auditRows,
  envelope,
  errorOf,
  mailTo,
  makeFile,
  makeFolder,
  makePendingShare,
  makeShare,
  member,
  sharesOn,
  settingsWith,
  testDb,
} from "./helpers";

type ShareDto = {
  id: string;
  nodeId: string;
  email: string;
  role: string;
  canUpload: boolean;
  createdAt: string;
};

const create = (
  caller: Awaited<ReturnType<typeof member>>,
  nodeId: string,
  json: unknown,
  settings = settingsWith(),
) => api(asCaller(caller), `/nodes/${nodeId}/shares`, { json, settings });

async function setNode(id: string, values: Partial<typeof nodes.$inferInsert>) {
  await testDb().update(nodes).set(values).where(eq(nodes.id, id));
}

describe("POST /nodes/:id/shares", () => {
  it("shares a folder with an account: 201 ShareDto, the grantee can open it, one audit row", async () => {
    const owner = await member();
    const grantee = await member();
    const folder = await makeFolder(owner.id);
    const answer = await create(owner, folder.id, { email: grantee.email, role: "viewer" });
    expect(answer.status).toBe(201);
    const dto = answer.body as ShareDto;
    expect(Object.keys(dto).sort()).toEqual(["canUpload", "createdAt", "email", "id", "nodeId", "role"]);
    expect(dto).toMatchObject({ nodeId: folder.id, email: grantee.email, role: "viewer" });
    expect((await api(asCaller(grantee), `/nodes/${folder.id}`)).status).toBe(200);
    expect(await auditRows({ action: "share.create", targetId: folder.id })).toHaveLength(1);
  });

  it("the role is inherited two folders down; removing the share takes the access away", async () => {
    const owner = await member();
    const grantee = await member();
    const top = await makeFolder(owner.id);
    const mid = await makeFolder(owner.id, top.id);
    const file = await makeFile(owner.id, mid.id, { scanStatus: "clean" });
    const made = (await create(owner, top.id, { email: grantee.email, role: "editor" })).body as ShareDto;
    const detail = await api(asCaller(grantee), `/nodes/${file.id}`);
    expect((detail.body as { node: { role: string } }).node.role).toBe("editor");
    expect((await api(asCaller(owner), `/shares/${made.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(asCaller(grantee), `/nodes/${file.id}`)).status).toBe(404);
  });

  it("pending by e-mail: the same ShareDto shape, statements and mails for a known and an unknown address", async () => {
    const owner = await member();
    const known = await member();
    const unknown = freshEmail();
    const a = await makeFolder(owner.id);
    const b = await makeFolder(owner.id);
    const toKnown = await create(owner, a.id, { email: known.email, role: "viewer" });
    const toUnknown = await create(owner, b.id, { email: unknown, role: "viewer" });
    expect([toKnown.status, toUnknown.status]).toEqual([201, 201]);
    const shape = (dto: unknown) => Object.keys(dto as object).sort();
    expect(shape(toKnown.body)).toEqual(shape(toUnknown.body));
    expect(toKnown.statements).toBe(toUnknown.statements);
    expect(mailTo(known.email, "shareInvitation")).toHaveLength(1);
    expect(mailTo(unknown, "shareInvitation")).toHaveLength(1);
    // The pending row grants nothing.
    const [row] = await sharesOn(b.id);
    expect(row).toMatchObject({ granteeUserId: null, activatedAt: null, granteeEmail: unknown });
  });

  it("an unverified account's address stays pending, and grants that account nothing", async () => {
    const owner = await member();
    const unverified = await member({ emailVerified: false });
    const folder = await makeFolder(owner.id);
    expect((await create(owner, folder.id, { email: unverified.email, role: "viewer" })).status).toBe(201);
    const [row] = await sharesOn(folder.id);
    expect(row).toMatchObject({ granteeUserId: null, activatedAt: null });
  });

  it("an address that signs up and verifies afterwards gets the share with no owner action, not twice", async () => {
    const owner = await member();
    const email = freshEmail();
    const folder = await makeFolder(owner.id);
    expect((await create(owner, folder.id, { email, role: "viewer" })).status).toBe(201);
    const { user: signedUp } = await verifiedUser({ email });
    const rows = await sharesOn(folder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ granteeUserId: signedUp.id });
    expect(rows[0]!.activatedAt).not.toBeNull();
    const asGrantee = { ...signedUp, quotaBytes: Number(signedUp.quotaBytes), usedBytes: 0 } as never;
    expect((await api(asCaller(asGrantee), `/nodes/${folder.id}`)).status).toBe(200);
    // Activation again changes nothing (one share per user and node).
    await activatePendingShares(testDb(), signedUp.id, email);
    expect(await sharesOn(folder.id)).toHaveLength(1);
  });

  it("refusals: self 400, a file not clean 409/403, hidden 404 like an unknown id, non-owner 403/404", async () => {
    const owner = await member();
    const editor = await member();
    const stranger = await member();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor" });
    const self = await create(owner, folder.id, { email: owner.email.toUpperCase(), role: "viewer" });
    expect([self.status, errorOf(self).error]).toEqual([400, "validation"]);

    const pending = await makeFile(owner.id, null, { scanStatus: "pending" });
    const infected = await makeFile(owner.id, null, { scanStatus: "infected" });
    const asked = { email: stranger.email, role: "viewer" };
    expect(errorOf(await create(owner, pending.id, asked)).error).toBe("scan_pending");
    const blocked = await create(owner, infected.id, asked);
    expect([blocked.status, errorOf(blocked).error]).toEqual([403, "scan_blocked"]);

    const takenDown = await makeFolder(owner.id);
    await setNode(takenDown.id, { takedownAt: new Date() });
    const csam = await makeFile(owner.id, null, { scanStatus: "suspected_csam" });
    const unknownId = "0199d3c2-7a10-7000-8000-00000000ffff";
    const reference = envelope(await create(owner, unknownId, asked));
    expect(reference).toMatchObject({ status: 404, error: "not_found" });
    expect(envelope(await create(owner, takenDown.id, asked))).toEqual(reference);
    expect(envelope(await create(owner, csam.id, asked))).toEqual(reference);

    const byEditor = await create(editor, folder.id, asked);
    expect([byEditor.status, errorOf(byEditor).error]).toEqual([403, "forbidden"]);
    expect(envelope(await create(stranger, folder.id, asked))).toEqual(reference);
    expect(await sharesOn(pending.id)).toHaveLength(0);
  });

  it("the route source has no takedown test of its own (hidden is requireRole's answer)", async () => {
    const sources = import.meta.glob("../../../src/worker/routes/{shares,links,public-links}.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    expect(Object.keys(sources)).toHaveLength(3);
    for (const source of Object.values(sources)) expect(String(source)).not.toMatch(/takedown/i);
  });

  it("a duplicate address on the node is 409; the 101st grantee is 409 (pending ones count)", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const email = freshEmail();
    expect((await create(owner, folder.id, { email, role: "viewer" })).status).toBe(201);
    const again = await create(owner, folder.id, { email: email.toUpperCase(), role: "editor" });
    expect([again.status, errorOf(again).error]).toEqual([409, "conflict"]);

    const full = await makeFolder(owner.id);
    await testDb()
      .insert(shares)
      .values(
        Array.from({ length: 100 }, (_, i) => ({
          nodeId: full.id,
          grantedBy: owner.id,
          granteeEmail: `pending-${i}-${full.id}@made-up.example.test`,
          role: "viewer" as const,
        })),
      );
    const over = await create(owner, full.id, { email: freshEmail(), role: "viewer" });
    expect([over.status, errorOf(over).error, errorOf(over).details]).toEqual([
      409,
      "conflict",
      { reason: "grantee_limit" },
    ]);
    expect(await sharesOn(full.id)).toHaveLength(100);
  });

  it("share_user: a refused consume is the thrown 429, no row, no mail", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const email = freshEmail();
    const refused = await create(
      owner,
      folder.id,
      { email, role: "viewer" },
      settingsWith({ ceilings: { CEIL_SHARES_DAY: 0 } }),
    );
    expect([refused.status, errorOf(refused).error, errorOf(refused).details]).toEqual([
      429,
      "ceiling_exceeded",
      { kind: "share_user", dimension: "count" },
    ]);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(await sharesOn(folder.id)).toHaveLength(0);
    expect(mailTo(email)).toHaveLength(0);
  });

  it("share_user under concurrency: two parallel creations at CEIL_SHARES_DAY - 1 → one 201, one 429", async () => {
    const owner = await member();
    const a = await makeFolder(owner.id);
    const b = await makeFolder(owner.id);
    const c = await makeFolder(owner.id);
    const settings = settingsWith({ ceilings: { CEIL_SHARES_DAY: 2 } });
    expect((await create(owner, a.id, { email: freshEmail(), role: "viewer" }, settings)).status).toBe(201);
    const both = await Promise.all([
      create(owner, b.id, { email: freshEmail(), role: "viewer" }, settings),
      create(owner, c.id, { email: freshEmail(), role: "viewer" }, settings),
    ]);
    expect(both.map((answer) => answer.status).sort()).toEqual([201, 429]);
    expect((await sharesOn(b.id)).length + (await sharesOn(c.id)).length).toBe(1);
  });

  it("a share made for an owner who is suspended grants nothing", async () => {
    const owner = await member();
    const grantee = await member();
    const folder = await makeFolder(owner.id);
    expect((await create(owner, folder.id, { email: grantee.email, role: "viewer" })).status).toBe(201);
    await testDb().update(user).set({ suspendedAt: new Date() }).where(eq(user.id, owner.id));
    expect((await api(asCaller(grantee), `/nodes/${folder.id}`)).status).toBe(404);
  });
});

describe("PATCH / DELETE /shares/:id", () => {
  async function shared() {
    const owner = await member();
    const grantee = await member();
    const stranger = await member();
    const folder = await makeFolder(owner.id);
    const share = await makeShare(folder.id, owner.id, grantee.id, { role: "viewer" });
    return { owner, grantee, stranger, folder, share };
  }

  it("the owner changes the role and the upload toggle", async () => {
    const { owner, grantee, folder, share } = await shared();
    const answer = await api(asCaller(owner), `/shares/${share.id}`, {
      method: "PATCH",
      json: { role: "editor", canUpload: false },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: share.id, role: "editor", canUpload: false });
    const detail = await api(asCaller(grantee), `/nodes/${folder.id}`);
    expect((detail.body as { node: { role: string } }).node.role).toBe("editor");
  });

  it("the grantee may mute only; {} is 400; a stranger gets 404", async () => {
    const { grantee, stranger, share } = await shared();
    const muted = await api(asCaller(grantee), `/shares/${share.id}`, {
      method: "PATCH",
      json: { mutedByGrantee: true },
    });
    expect(muted.status).toBe(200);
    const [row] = await testDb().select().from(shares).where(eq(shares.id, share.id));
    expect(row!.mutedByGrantee).toBe(true);
    const raise = await api(asCaller(grantee), `/shares/${share.id}`, {
      method: "PATCH",
      json: { role: "editor" },
    });
    expect([raise.status, errorOf(raise).error]).toEqual([403, "forbidden"]);
    const empty = await api(asCaller(grantee), `/shares/${share.id}`, { method: "PATCH", json: {} });
    expect([empty.status, errorOf(empty).error]).toEqual([400, "validation"]);
    const foreign = await api(asCaller(stranger), `/shares/${share.id}`, {
      method: "PATCH",
      json: { mutedByGrantee: true },
    });
    const unknown = await api(asCaller(stranger), `/shares/0199d3c2-7a10-7000-8000-00000000eeee`, {
      method: "PATCH",
      json: { mutedByGrantee: true },
    });
    expect(envelope(foreign)).toEqual(envelope(unknown));
    expect(foreign.status).toBe(404);
  });

  it("the owner may not mute for the grantee", async () => {
    const { owner, share } = await shared();
    const answer = await api(asCaller(owner), `/shares/${share.id}`, {
      method: "PATCH",
      json: { mutedByGrantee: true },
    });
    expect([answer.status, errorOf(answer).error]).toEqual([403, "forbidden"]);
  });

  it("the grantee leaves (DELETE); afterwards the folder is gone for them", async () => {
    const { grantee, folder, share } = await shared();
    expect((await api(asCaller(grantee), `/shares/${share.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(asCaller(grantee), `/nodes/${folder.id}`)).status).toBe(404);
    expect(await auditRows({ action: "share.delete", targetId: folder.id })).toHaveLength(1);
  });

  it("a stranger cannot remove a share: 404 like an unknown id", async () => {
    const { stranger, share } = await shared();
    const answer = await api(asCaller(stranger), `/shares/${share.id}`, { method: "DELETE" });
    expect(answer.status).toBe(404);
    expect(await sharesOn(share.nodeId)).toHaveLength(1);
  });
});

describe("GET /nodes/:id/sharing", () => {
  it("owner or editor: shares, links, inheritedFrom (the nearest shared folder above); viewer 403", async () => {
    const owner = await member();
    const editor = await member();
    const viewer = await member();
    const top = await makeFolder(owner.id, null, { name: "Top shared" });
    const mid = await makeFolder(owner.id, top.id, { name: "Middle shared" });
    const leaf = await makeFolder(owner.id, mid.id);
    await makeShare(top.id, owner.id, viewer.id, { role: "viewer" });
    await makeShare(mid.id, owner.id, editor.id, { role: "editor" });
    const pending = await makePendingShare(leaf.id, owner.id, freshEmail());

    const asOwner = await api(asCaller(owner), `/nodes/${leaf.id}/sharing`);
    expect(asOwner.status).toBe(200);
    const body = asOwner.body as { shares: ShareDto[]; links: unknown[]; inheritedFrom: unknown };
    expect(body.shares.map((share) => share.id)).toEqual([pending.id]);
    expect(body.links).toEqual([]);
    expect(body.inheritedFrom).toEqual({ nodeId: mid.id, name: "Middle shared" });

    expect((await api(asCaller(editor), `/nodes/${leaf.id}/sharing`)).status).toBe(200);
    const byViewer = await api(asCaller(viewer), `/nodes/${leaf.id}/sharing`);
    expect([byViewer.status, errorOf(byViewer).error]).toEqual([403, "forbidden"]);
    const top2 = await api(asCaller(owner), `/nodes/${top.id}/sharing`);
    expect((top2.body as { inheritedFrom: unknown }).inheritedFrom).toBeNull();
  });
});

describe("GET /shared-with-me", () => {
  type Item = {
    node: { id: string; parentId: string | null };
    role: string;
    owner: { id: string };
    sharedAt: string;
  };

  it("active shares only, with the owner and the role; the node is the root of the view", async () => {
    const owner = await member();
    const me = await member();
    const outer = await makeFolder(owner.id);
    const shared = await makeFolder(owner.id, outer.id);
    await makeShare(shared.id, owner.id, me.id, { role: "editor" });
    await makeShare((await makeFolder(owner.id)).id, owner.id, me.id, {
      granteeUserId: null,
      activatedAt: null,
    });
    const answer = await api(asCaller(me), "/shared-with-me");
    expect(answer.status).toBe(200);
    const items = (answer.body as Item[]).filter((item) => item.owner.id === owner.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      node: { id: shared.id, parentId: null },
      role: "editor",
      owner: { id: owner.id },
    });
  });

  it("an owner banned, suspended or scheduled for deletion: their shares are absent", async () => {
    const me = await member();
    for (const state of [
      { banned: true },
      { suspendedAt: new Date() },
      { deleteScheduledAt: new Date(Date.now() + 86_400_000) },
    ]) {
      const owner = await member();
      const folder = await makeFolder(owner.id);
      await makeShare(folder.id, owner.id, me.id);
      await testDb().update(user).set(state).where(eq(user.id, owner.id));
      const items = (await api(asCaller(me), "/shared-with-me")).body as Item[];
      expect(items.some((item) => item.node.id === folder.id)).toBe(false);
    }
  });

  it("a share on or two folders below a taken-down folder is absent, and back after the takedown is cleared", async () => {
    const owner = await member();
    const me = await member();
    const down = await makeFolder(owner.id);
    const mid = await makeFolder(owner.id, down.id);
    const deep = await makeFolder(owner.id, mid.id);
    const onIt = await makeShare(down.id, owner.id, me.id);
    const below = await makeShare(deep.id, owner.id, me.id, { role: "editor" });
    const listed = async () =>
      ((await api(asCaller(me), "/shared-with-me")).body as Item[]).map((i) => i.node.id);
    expect(await listed()).toEqual(expect.arrayContaining([down.id, deep.id]));
    await setNode(down.id, { takedownAt: new Date() });
    expect(await listed()).not.toContain(down.id);
    expect(await listed()).not.toContain(deep.id);
    expect((await api(asCaller(me), `/nodes/${deep.id}`)).status).toBe(404);
    await setNode(down.id, { takedownAt: null });
    expect(await listed()).toEqual(expect.arrayContaining([down.id, deep.id]));
    // The share rows were never touched.
    const [a] = await testDb().select().from(shares).where(eq(shares.id, onIt.id));
    const [b] = await testDb().select().from(shares).where(eq(shares.id, below.id));
    expect([a, b]).toEqual([onIt, below]);
  });
});

describe("GET /shares/mine", () => {
  type Group = { node: { id: string; name: string; kind: string }; shares: ShareDto[] };

  it("everything I shared, grouped by node, pending ones included; trashed and hidden nodes absent, back when restored", async () => {
    const owner = await member();
    const a = await member();
    const b = await member();
    const folder = await makeFolder(owner.id, null, { name: "Grouped" });
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    await makeShare(folder.id, owner.id, a.id);
    await makeShare(folder.id, owner.id, b.id, { role: "editor" });
    await makePendingShare(file.id, owner.id, freshEmail());
    const trashed = await makeFolder(owner.id);
    await makeShare(trashed.id, owner.id, a.id);
    await setNode(trashed.id, {
      deletedAt: new Date(),
      purgeAfter: new Date(Date.now() + 86_400_000),
      trashedBy: owner.id,
    });
    const down = await makeFolder(owner.id);
    const inside = await makeFolder(owner.id, down.id);
    await makeShare(inside.id, owner.id, a.id);
    await setNode(down.id, { takedownAt: new Date() });

    const groups = (await api(asCaller(owner), "/shares/mine")).body as Group[];
    const byNode = new Map(groups.map((group) => [group.node.id, group]));
    expect(byNode.get(folder.id)?.shares).toHaveLength(2);
    expect(byNode.get(folder.id)?.node).toEqual({ id: folder.id, name: "Grouped", kind: "folder" });
    expect(byNode.get(file.id)?.shares).toHaveLength(1);
    expect(byNode.has(trashed.id)).toBe(false);
    expect(byNode.has(inside.id)).toBe(false);
    await setNode(down.id, { takedownAt: null });
    const again = (await api(asCaller(owner), "/shares/mine")).body as Group[];
    expect(again.some((group) => group.node.id === inside.id)).toBe(true);
    void sql;
  });
});
