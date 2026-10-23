// R1 func-8: two tabs restoring a folder and a file inside it at once. The file's restore used to
// read "its folder is in the trash" BEFORE the tree lock and then put the file at the top level,
// although the folder's restore had committed in between. Decided under the lock now.
import { beforeAll, describe, expect, it } from "vitest";
import {
  api,
  audits,
  hookedDb,
  makeFile,
  makeFolder,
  member,
  nodeById,
  setNode,
  type Caller,
  generationInStep,
} from "./helpers";

beforeAll(generationInStep);

const POST = { method: "POST" } as const;

describe("func-8: a folder restored while its file's restore is on its way", () => {
  async function trashedPair() {
    const owner = await member();
    const caller: Caller = { user: owner };
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    expect((await api(caller, `/nodes/${file.id}/trash`, POST)).status).toBe(200);
    expect((await api(caller, `/nodes/${folder.id}/trash`, POST)).status).toBe(200);
    return { caller, folder, file };
  }

  it("the folder's restore lands between the file's read and its transaction: the file comes back IN the folder", async () => {
    const { caller, folder, file } = await trashedPair();
    let done = false;
    // The other tab: the folder's restore commits just before this request's transaction starts.
    const racing = hookedDb(async () => {
      if (done) return;
      done = true;
      await setNode(folder.id, { deletedAt: null, trashedRoot: false, trashedBy: null, purgeAfter: null });
    });
    const answer = await api(caller, `/nodes/${file.id}/restore`, {
      ...POST,
      core: { createDb: () => racing },
    });
    expect(done).toBe(true);
    expect(answer.status).toBe(200);
    expect(await nodeById(file.id)).toMatchObject({ parentId: folder.id, deletedAt: null });
    const rows = await audits("node.restore", file.id);
    expect(rows.map((row) => row.meta)).toEqual([{ toRoot: false }]);
  });

  it("CONTROL: the folder still in the trash: the file comes back at the top level (toRoot audited)", async () => {
    const { caller, file } = await trashedPair();
    expect((await api(caller, `/nodes/${file.id}/restore`, POST)).status).toBe(200);
    expect(await nodeById(file.id)).toMatchObject({ parentId: null, deletedAt: null });
    expect((await audits("node.restore", file.id)).map((row) => row.meta)).toEqual([{ toRoot: true }]);
  });
});
