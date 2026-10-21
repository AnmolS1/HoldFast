// The role matrix through shares made with the API: a viewer browses, previews and downloads and
// may not rename or upload; an editor with uploads on uploads into the owner's tree (the OWNER's
// quota is charged); an editor with uploads off is told so. Two folders down, as one folder down.
import { describe, expect, it } from "vitest";
import { complete, uploaded, usedBytes, init } from "../uploads/helpers";
import { api, asCaller, errorOf, makeFile, makeFolder, member, settingsWith } from "./helpers";

type Member = Awaited<ReturnType<typeof member>>;

async function shareWith(
  owner: Member,
  nodeId: string,
  grantee: Member,
  role: "viewer" | "editor",
  canUpload = true,
) {
  const answer = await api(asCaller(owner), `/nodes/${nodeId}/shares`, {
    json: { email: grantee.email, role, canUpload },
  });
  if (answer.status !== 201) throw new Error(`share: ${answer.status}`);
}

describe("roles through shares, on nested folders", () => {
  it("viewer: browses, previews and downloads two folders down; may not rename, move or upload", async () => {
    const owner = await member();
    const viewer = await member();
    const top = await makeFolder(owner.id);
    const mid = await makeFolder(owner.id, top.id);
    const photo = await makeFile(owner.id, mid.id, {
      scanStatus: "clean",
      name: "p.png",
      mimeSniffed: "image/png",
      size: 500,
    });
    await shareWith(owner, top.id, viewer, "viewer");
    const as = asCaller(viewer);
    const listing = await api(as, `/nodes/${mid.id}/children`);
    expect((listing.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([photo.id]);
    expect((await api(as, `/nodes/${photo.id}/download-url`, { json: { kind: "download" } })).status).toBe(
      200,
    );
    expect((await api(as, `/nodes/${photo.id}/download-url`, { json: { kind: "inline" } })).status).toBe(200);
    const rename = await api(as, `/nodes/${photo.id}`, { method: "PATCH", json: { name: "renamed.png" } });
    expect([rename.status, errorOf(rename).error]).toEqual([403, "forbidden"]);
    const upload = await api(as, "/uploads", {
      json: {
        parentId: mid.id,
        name: "from-a-viewer.bin",
        size: 10,
        mimeDeclared: "application/octet-stream",
        fileLastModified: "2026-10-01T12:00:00.000Z",
        onConflict: "fail",
        purpose: "file",
      },
      settings: settingsWith(),
    });
    expect([upload.status, errorOf(upload).error]).toEqual([403, "forbidden"]);
  });

  it("editor with uploads on: uploads two folders down and the OWNER's quota is charged", async () => {
    const owner = await member();
    const editor = await member();
    const top = await makeFolder(owner.id);
    const mid = await makeFolder(owner.id, top.id);
    await shareWith(owner, top.id, editor, "editor", true);
    const ownerBefore = await usedBytes(owner.id);
    const editorBefore = await usedBytes(editor.id);
    const session = await uploaded(
      editor,
      { parentId: mid.id, name: "from-an-editor.bin" },
      new Uint8Array(4321),
    );
    const done = await complete(editor, session.uploadId);
    expect(done.status).toBe(201);
    expect(await usedBytes(owner.id)).toBe(ownerBefore + 4321);
    expect(await usedBytes(editor.id)).toBe(editorBefore);
  });

  it("editor with uploads off: a clear 403 upload_not_allowed", async () => {
    const owner = await member();
    const editor = await member();
    const folder = await makeFolder(owner.id);
    await shareWith(owner, folder.id, editor, "editor", false);
    await expect(init(editor, { parentId: folder.id })).rejects.toThrow(/403.*upload_not_allowed/);
  });
});
