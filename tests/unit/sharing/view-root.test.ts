// `Access.viewRootId`: where a shared view starts — the OUTERMOST folder on the path with ANY
// activated share to the user (a link: its root; the owner: null). The routes cut breadcrumbs and
// root the tree there, while `shareRootId` keeps deciding the role and the share-root refusals.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { effectiveAccess } from "../../../src/worker/db/queries/tree";
import { getAccess, withLinkScope } from "../../../src/worker/services/permissions";
import { invoke } from "../services-core/request";
import { api, asCaller, makeFile, makeFolder, makeLink, makeShare, member, testDb } from "./helpers";

type Detail = {
  node: { id: string; parentId: string | null; role: string };
  breadcrumbs: { id: string; name: string }[];
};

/** Owner U: O / N / S / F (F a clean file in S). Grantee G: viewer on O, editor on N. */
async function outerViewerInnerEditor() {
  const owner = await member();
  const grantee = await member();
  const outer = await makeFolder(owner.id);
  const inner = await makeFolder(owner.id, outer.id);
  const sub = await makeFolder(owner.id, inner.id);
  const file = await makeFile(owner.id, sub.id, { scanStatus: "clean" });
  await makeShare(outer.id, owner.id, grantee.id, { role: "viewer" });
  await makeShare(inner.id, owner.id, grantee.id, { role: "editor" });
  return { owner, grantee, outer, inner, sub, file };
}

describe("viewRootId — the tree query", () => {
  it("grantee: the outermost share of any role; shareRootId stays the granting share; owner: null", async () => {
    const { owner, grantee, outer, inner, file } = await outerViewerInnerEditor();
    const atFile = await effectiveAccess(testDb(), grantee.id, file.id);
    expect(atFile).toMatchObject({ role: "editor", shareRootId: inner.id, viewRootId: outer.id });
    const atOuter = await effectiveAccess(testDb(), grantee.id, outer.id);
    expect(atOuter).toMatchObject({ role: "viewer", shareRootId: outer.id, viewRootId: outer.id });
    const asOwner = await effectiveAccess(testDb(), owner.id, file.id);
    expect(asOwner).toMatchObject({ role: "owner", shareRootId: null, viewRootId: null });
  });

  it("only an inner share: the view starts at it", async () => {
    const owner = await member();
    const grantee = await member();
    const outer = await makeFolder(owner.id);
    const inner = await makeFolder(owner.id, outer.id);
    const deep = await makeFolder(owner.id, inner.id);
    await makeShare(inner.id, owner.id, grantee.id, { role: "viewer" });
    expect(await effectiveAccess(testDb(), grantee.id, deep.id)).toMatchObject({
      shareRootId: inner.id,
      viewRootId: inner.id,
    });
  });

  it("a pending share on an outer folder does not move the view", async () => {
    const owner = await member();
    const grantee = await member();
    const outer = await makeFolder(owner.id);
    const inner = await makeFolder(owner.id, outer.id);
    await makeShare(outer.id, owner.id, grantee.id, { granteeUserId: null, activatedAt: null });
    await makeShare(inner.id, owner.id, grantee.id, { role: "viewer" });
    expect(await effectiveAccess(testDb(), grantee.id, inner.id)).toMatchObject({ viewRootId: inner.id });
  });
});

describe("viewRootId — permissions", () => {
  it("behind a link the view starts at the link's root; for the owner it is null", async () => {
    const owner = await member();
    const root = await makeFolder(owner.id);
    const sub = await makeFolder(owner.id, root.id);
    const link = await makeLink(root.id, owner.id);
    const viaLink = await invoke(null, async (c) => {
      withLinkScope(c, { linkId: link.id, rootNodeId: root.id });
      return getAccess(c, sub.id);
    });
    expect(viaLink.ok && viaLink.value).toMatchObject({
      via: "link",
      shareRootId: root.id,
      viewRootId: root.id,
    });
    const asOwner = await invoke({ user: owner }, (c) => getAccess(c, sub.id));
    expect(asOwner.ok && asOwner.value).toMatchObject({ via: "owner", shareRootId: null, viewRootId: null });
  });
});

describe("viewRootId — the routes (outer viewer share O, inner editor share N)", () => {
  it("GET /nodes/N: breadcrumbs from O, N keeps its parent, the role is editor", async () => {
    const { grantee, outer, inner } = await outerViewerInnerEditor();
    const answer = await api(asCaller(grantee), `/nodes/${inner.id}`);
    expect(answer.status).toBe(200);
    const detail = answer.body as Detail;
    expect(detail.breadcrumbs.map((crumb) => crumb.id)).toEqual([outer.id]);
    expect(detail.node.parentId).toBe(outer.id);
    expect(detail.node.role).toBe("editor");
  });

  it("GET a folder two levels below N: breadcrumbs O, N, …", async () => {
    const { grantee, outer, inner, sub, file } = await outerViewerInnerEditor();
    const answer = await api(asCaller(grantee), `/nodes/${file.id}`);
    expect(answer.status).toBe(200);
    const detail = answer.body as Detail;
    expect(detail.breadcrumbs.map((crumb) => crumb.id)).toEqual([outer.id, inner.id, sub.id]);
    expect(detail.node.role).toBe("editor");
  });

  it("GET /nodes/O: O goes out as the root of the view (parentId null)", async () => {
    const { grantee, owner, outer } = await outerViewerInnerEditor();
    const top = await makeFolder(owner.id);
    // O under another folder of the owner's: its parent must not be told.
    // Re-parented directly (no route: only the shape of the tree matters here).
    await testDb().execute(sql`UPDATE nodes SET parent_id = ${top.id} WHERE id = ${outer.id}`);
    const answer = await api(asCaller(grantee), `/nodes/${outer.id}`);
    expect(answer.status).toBe(200);
    const detail = answer.body as Detail;
    expect(detail.node.parentId).toBeNull();
    expect(detail.breadcrumbs).toEqual([]);
  });

  it("listing O as the grantee: N goes out with its parent (it is inside the view)", async () => {
    const { grantee, outer, inner } = await outerViewerInnerEditor();
    const answer = await api(asCaller(grantee), `/nodes/${outer.id}/children`);
    expect(answer.status).toBe(200);
    const items = (answer.body as { items: { id: string; parentId: string | null }[] }).items;
    expect(items.find((item) => item.id === inner.id)?.parentId).toBe(outer.id);
  });

  it("renaming N is still 403 forbidden (shareRootId decides the refusal)", async () => {
    const { grantee, inner, sub } = await outerViewerInnerEditor();
    const refused = await api(asCaller(grantee), `/nodes/${inner.id}`, {
      method: "PATCH",
      json: { name: "renamed by a grantee" },
    });
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe("forbidden");
    // Below N the editor may rename.
    const renamed = await api(asCaller(grantee), `/nodes/${sub.id}`, {
      method: "PATCH",
      json: { name: "renamed sub" },
    });
    expect(renamed.status).toBe(200);
  });
});
