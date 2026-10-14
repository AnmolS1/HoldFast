// The move's transaction runs through `retryOnDeadlock`: an attempt Postgres ends as a deadlock
// victim is run again, and what the route does outside the database — the audit row — happens
// once, for the attempt that committed. (How many attempts, and which codes, are the helper's
// own tests: tests/unit/db/retry.test.ts.)
//
// A file of its own because it replaces `nodes.moveNode` for every request made here: the real
// function runs, and then the attempt is made to fail on demand.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, auditFor, nodeById, sharedTree } from "./helpers";

const injected = vi.hoisted(() => ({ failures: [] as unknown[], calls: 0 }));

vi.mock("../../../src/worker/db/queries/nodes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/worker/db/queries/nodes")>();
  return {
    ...real,
    moveNode: async (...args: Parameters<typeof real.moveNode>) => {
      injected.calls += 1;
      // The whole move has run in this attempt's transaction before it is made to fail.
      const moved = await real.moveNode(...args);
      const failure = injected.failures.shift();
      if (failure) throw failure;
      return moved;
    },
  };
});

/** What node-postgres raises: the SQLSTATE and a severity (db/errors.ts `pgError` asks for both). */
const pgFailure = (code: string) =>
  Object.assign(new Error(`made-up failure ${code}`), { code, severity: "ERROR" });

beforeEach(() => {
  injected.failures = [];
  injected.calls = 0;
});

describe("move and deadlocks", () => {
  it("a first attempt that ends as a deadlock victim (40P01) is run again: the move succeeds, ONE audit row", async () => {
    const t = await sharedTree();
    injected.failures = [pgFailure("40P01")];
    const answer = await api(t.owner.as, "POST", `/nodes/${t.notes.id}/move`, {
      body: { parentId: t.dest.id },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.parentId).toBe(t.dest.id);
    expect(injected.calls).toBe(2);
    expect((await nodeById(t.notes.id))!.parentId).toBe(t.dest.id);
    expect(await auditFor("node.move", t.notes.id)).toHaveLength(1);
  });

  it("a serialization failure (40001) is treated alike", async () => {
    const t = await sharedTree();
    injected.failures = [pgFailure("40001"), pgFailure("40P01")];
    const answer = await api(t.owner.as, "POST", `/nodes/${t.notes.id}/move`, {
      body: { parentId: t.dest.id },
    });
    expect(answer.status).toBe(200);
    expect(injected.calls).toBe(3);
    expect(await auditFor("node.move", t.notes.id)).toHaveLength(1);
  });

  it("an error with another code is not retried: one attempt, rolled back, 500, no audit row", async () => {
    const t = await sharedTree();
    injected.failures = [pgFailure("57014")];
    const answer = await api(t.owner.as, "POST", `/nodes/${t.notes.id}/move`, {
      body: { parentId: t.dest.id },
    });
    expect([answer.status, answer.body.error]).toEqual([500, "internal"]);
    expect(injected.calls).toBe(1);
    // The attempt's UPDATE had run; it was rolled back with the transaction.
    expect((await nodeById(t.notes.id))!.parentId).toBe(t.inner.id);
    expect(await auditFor("node.move", t.notes.id)).toEqual([]);
  });

  it("the control: without an injected failure there is one attempt and one row", async () => {
    const t = await sharedTree();
    const answer = await api(t.owner.as, "POST", `/nodes/${t.notes.id}/move`, {
      body: { parentId: t.dest.id },
    });
    expect(answer.status).toBe(200);
    expect(injected.calls).toBe(1);
    expect(await auditFor("node.move", t.notes.id)).toHaveLength(1);
  });
});
