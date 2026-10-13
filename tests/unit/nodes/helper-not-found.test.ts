// When the query helpers themselves say "no such node" — as they will once they re-decide
// "still visible" under their own lock, for a takedown that lands between the route's read and
// the write — the route answers the ordinary `404 not_found`: not a 500, no audit row, and
// nothing that tells it from an id that was never issued.
//
// A file of its own because it replaces `rename`, `setStar` and `move` for the requests made
// here: each throws on demand what the real helper throws for a missing node.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, auditFor, comparable, nodeById, sharedTree } from "./helpers";

const refuse = vi.hoisted(() => ({ rename: false, setStar: false, move: false }));

vi.mock("../../../src/worker/db/queries/nodes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/worker/db/queries/nodes")>();
  const { QueryError: Refusal } = await import("../../../src/worker/db/errors");
  return {
    ...real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (refuse.rename) throw new Refusal("not_found");
      return real.rename(...args);
    },
    setStar: async (...args: Parameters<typeof real.setStar>) => {
      if (refuse.setStar) throw new Refusal("not_found");
      return real.setStar(...args);
    },
    move: async (...args: Parameters<typeof real.move>) => {
      if (refuse.move) throw new Refusal("not_found");
      return real.move(...args);
    },
  };
});

beforeEach(() => {
  refuse.rename = refuse.setStar = refuse.move = false;
});

describe("a helper that answers not_found after the route's own checks passed", () => {
  it.each([
    {
      helper: "rename",
      method: "PATCH",
      suffix: "",
      body: () => ({ name: "late.txt" }),
      action: "node.rename",
    },
    { helper: "setStar", method: "PATCH", suffix: "", body: () => ({ starred: true }), action: "node.star" },
    {
      helper: "move",
      method: "POST",
      suffix: "/move",
      body: (dest: string) => ({ parentId: dest }),
      action: "node.move",
    },
  ] as const)(
    "$helper → 404 not_found, the unknown id's answer; no $action row; nothing written",
    async (row) => {
      const t = await sharedTree();
      const unknown = await api(t.owner.as, row.method, `/nodes/${crypto.randomUUID()}${row.suffix}`, {
        body: row.body(t.dest.id),
      });
      expect([unknown.status, unknown.body.error]).toEqual([404, "not_found"]);

      refuse[row.helper] = true;
      for (const who of [t.owner, ...(row.helper === "setStar" ? [] : [t.editor])]) {
        const answer = await api(who.as, row.method, `/nodes/${t.notes.id}${row.suffix}`, {
          body: row.body(t.dest.id),
        });
        expect(answer.status).toBe(404);
        expect(comparable(answer)).toEqual(comparable(unknown));
      }
      expect(await auditFor(row.action, t.notes.id)).toEqual([]);
      const after = (await nodeById(t.notes.id))!;
      expect([after.name, after.starred, after.parentId]).toEqual([t.notes.name, false, t.inner.id]);

      // The control: the same request, with the helper answering, goes through.
      refuse[row.helper] = false;
      const done = await api(t.owner.as, row.method, `/nodes/${t.notes.id}${row.suffix}`, {
        body: row.body(t.dest.id),
      });
      expect(done.status).toBe(200);
      expect(await auditFor(row.action, t.notes.id)).toHaveLength(1);
    },
  );

  it("the helper is told apart from a QueryError that IS a conflict: that one stays 409", async () => {
    const t = await sharedTree();
    // A real cycle, through the real helper.
    const cycle = await api(t.owner.as, "POST", `/nodes/${t.inner.id}/move`, {
      body: { parentId: t.inner.id },
    });
    expect([cycle.status, cycle.body.error]).toEqual([409, "conflict"]);
  });
});
