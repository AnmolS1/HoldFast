// R1 perfops-8: "Shared with me" read one owner lookup per share (1 + S round trips). The page is
// mapped in one batch now: the statements a request sends do not grow with the shares.
import { describe, expect, it } from "vitest";
import { api, makeFile, makeFolder, makeShare, member } from "../trash/helpers";

type Item = {
  node: { id: string; parentId: string | null; kind: string };
  role: string;
  owner: { id: string };
};

describe("perfops-8: GET /shared-with-me in one batch", () => {
  it("2 shares and 10 shares from 3 owners: the same number of statements, every row the root of its view", async () => {
    const me = await member();
    const owners = [await member(), await member(), await member()];
    const shareOne = async (n: number) => {
      const owner = owners[n % owners.length]!;
      const outer = await makeFolder(owner.id);
      const node =
        n % 2
          ? await makeFolder(owner.id, outer.id)
          : await makeFile(owner.id, outer.id, { scanStatus: "clean" });
      await makeShare(node.id, owner.id, me.id, { role: n % 3 ? "viewer" : "editor" });
      return { node, owner, role: n % 3 ? "viewer" : "editor" };
    };
    const made = [await shareOne(0), await shareOne(1)];
    const few = await api({ user: me }, "/shared-with-me");
    expect(few.status).toBe(200);
    for (let n = 2; n < 10; n++) made.push(await shareOne(n));
    const many = await api({ user: me }, "/shared-with-me");
    expect((many.body as Item[]).length).toBe(10);
    expect(many.statements).toBe(few.statements);
    const byId = new Map((many.body as Item[]).map((item) => [item.node.id, item]));
    for (const { node, owner, role } of made) {
      expect(byId.get(node.id)).toMatchObject({
        node: { id: node.id, parentId: null },
        role,
        owner: { id: owner.id },
      });
    }
  });
});
