// What an account holder can learn about a hold from these routes: nothing but the one accepted
// thing — a restore that cannot happen now answers a bare `409 conflict`.
//
// Every comparison is between the answer for something held and the answer for its un-held
// twin, made the same way by an owner with the same tree: status, body, EVERY response header,
// and the number of SQL statements sent before the answer existed.
import { afterEach, describe, expect, it } from "vitest";
import { setNodeLegalHold, setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import { setEmptyTrashDeadlineForTests } from "../../../src/worker/routes/trash";
import {
  api,
  auditRows,
  audits,
  closeNotice,
  makeFile,
  makeFolder,
  member,
  nodeById,
  openNoticeOn,
  setNode,
  testDb,
  type Answer,
  type Caller,
} from "./helpers";

const POST = { method: "POST" } as const;
const DELETE = { method: "DELETE" } as const;

/** An answer with what differs per request by design taken out: ids, and timestamps of the node. */
function shape(answer: Answer) {
  const body = answer.body as Record<string, unknown> | null;
  const stable =
    body && typeof body === "object"
      ? Object.fromEntries(
          Object.entries(body).map(([key, value]) =>
            // (`scanStatus`: an owner is shown that a file of theirs is under review.)
            ["requestId", "id", "parentId", "name", "etag", "owner", "createdBy", "scanStatus"].includes(
              key,
            ) || /At$|After$/.test(key)
              ? [key, typeof value]
              : [key, value],
          ),
        )
      : body;
  return { status: answer.status, body: stable, headers: answer.headers, statements: answer.statements };
}

/** owner:  top/  →  folder/  →  file.bin */
async function tree() {
  const owner = await member();
  const top = await makeFolder(owner.id);
  const folder = await makeFolder(owner.id, top.id);
  const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
  const caller: Caller = { user: owner };
  return { owner, caller, top, folder, file };
}
type Tree = Awaited<ReturnType<typeof tree>>;

const CAUSES: Array<[string, (t: Tree) => Promise<unknown>]> = [
  ["a legal hold on the file", (t) => setNodeLegalHold(testDb(), t.file.id, true)],
  ["the file under review", (t) => setNode(t.file.id, { scanStatus: "under_review" })],
  ["an open notice on the file", (t) => openNoticeOn(t.file.id)],
  ["a legal hold on its folder", (t) => setNodeLegalHold(testDb(), t.folder.id, true)],
  ["an open notice on its folder", (t) => openNoticeOn(t.folder.id)],
  ["a legal hold two folders up", (t) => setNodeLegalHold(testDb(), t.top.id, true)],
  ["the owner on legal hold", (t) => setUserLegalHold(testDb(), t.owner.id, true)],
];

describe.each(CAUSES)("%s", (_name, hold) => {
  it("trash, an in-place restore and a permanent delete answer as for a file nothing holds", async () => {
    const held = await tree();
    const free = await tree();
    await hold(held);
    for (const path of ["trash", "restore", "trash"]) {
      const [a, b] = [
        await api(held.caller, `/nodes/${held.file.id}/${path}`, POST),
        await api(free.caller, `/nodes/${free.file.id}/${path}`, POST),
      ];
      expect(a.status, path).toBe(200);
      expect(shape(a), path).toEqual(shape(b));
    }
    const [a, b] = [
      await api(held.caller, `/nodes/${held.file.id}`, DELETE),
      await api(free.caller, `/nodes/${free.file.id}`, DELETE),
    ];
    // The un-held one is gone; the held one is not — and the two answers are the same bytes.
    expect(await nodeById(free.file.id)).toBeNull();
    expect(await nodeById(held.file.id)).not.toBeNull();
    expect([a.status, a.body, a.headers]).toEqual([b.status, b.body, b.headers]);
    expect(a.status).toBe(204);
    // The request is recorded the same way for both: nothing in the row says which was held.
    const rows = [
      await audits("node.purge_requested", held.file.id),
      await audits("node.purge_requested", free.file.id),
    ];
    expect([rows[0]!.length, rows[1]!.length]).toEqual([1, 1]);
    const comparable = (row: (typeof rows)[0][0], t: Tree) => ({
      ...row,
      id: "",
      at: "",
      requestId: typeof row.requestId,
      targetId: row.targetId === t.file.id,
      actorUserId: row.actorUserId === t.owner.id,
    });
    expect(comparable(rows[0]![0]!, held)).toEqual(comparable(rows[1]![0]!, free));
    expect(rows[0]![0]).toMatchObject({ actorType: "user", targetType: "node", meta: null });
    // The purge itself is recorded only where it happened.
    expect((await audits("node.purge", held.file.id)).length).toBe(0);
    expect((await audits("node.purge", free.file.id)).length).toBe(1);
    // Afterwards both are unknown ids, on every route here, at the same cost.
    for (const [method, path] of [
      ["POST", "/trash"],
      ["POST", "/restore"],
      ["DELETE", ""],
    ] as const) {
      const after = [
        await api(held.caller, `/nodes/${held.file.id}${path}`, { method }),
        await api(free.caller, `/nodes/${free.file.id}${path}`, { method }),
      ];
      expect(after[0]!.status, `${method} ${path}`).toBe(404);
      expect(shape(after[0]!), `${method} ${path}`).toEqual(shape(after[1]!));
    }
    const lists = [await api(held.caller, "/trash"), await api(free.caller, "/trash")];
    expect(shape(lists[0]!)).toEqual(shape(lists[1]!));
    expect(lists[0]!.body).toEqual({ items: [], nextCursor: null });
  });
});

describe("a restore out of a trashed folder that protects the file", () => {
  it("is one answer whatever the protection — the same bytes, headers and work", async () => {
    const refusal = async (protect: (t: Tree) => Promise<unknown>) => {
      const t = await tree();
      await api(t.caller, `/nodes/${t.file.id}/trash`, POST);
      await api(t.caller, `/nodes/${t.folder.id}/trash`, POST);
      const cleanup = await protect(t);
      const answer = await api(t.caller, `/nodes/${t.file.id}/restore`, POST);
      expect((await nodeById(t.file.id))!.trashedRoot).toBe(true);
      if (typeof cleanup === "string") await closeNotice(cleanup);
      return shape(answer);
    };
    const byHold = await refusal((t) => setNodeLegalHold(testDb(), t.folder.id, true));
    const byNotice = await refusal((t) => openNoticeOn(t.folder.id));
    const byHoldAbove = await refusal((t) => setNodeLegalHold(testDb(), t.top.id, true));
    const byBoth = await refusal(async (t) => {
      await setNodeLegalHold(testDb(), t.top.id, true);
      return openNoticeOn(t.folder.id);
    });
    expect(byHold).toMatchObject({
      status: 409,
      body: { error: "conflict", message: "That conflicts with the current state." },
    });
    // No `details`, and nothing but the three members of every error.
    expect(Object.keys(byHold.body as object).sort()).toEqual(["error", "message", "requestId"]);
    expect(byNotice).toEqual(byHold);
    expect(byHoldAbove).toEqual(byHold);
    expect(byBoth).toEqual(byHold);
  });
});

describe("DELETE /trash with a held root in it", () => {
  let restoreDeadline: (() => void) | null = null;
  afterEach(() => {
    restoreDeadline?.();
    restoreDeadline = null;
  });

  it("counts down exactly as an un-held trash does: the same `remaining`, the same number of requests", async () => {
    const trashOf = async (heldIndex: number | null) => {
      const owner = await member();
      const caller: Caller = { user: owner };
      for (let index = 0; index < 3; index++) {
        const file = await makeFile(owner.id, null, { scanStatus: "clean", legalHold: index === heldIndex });
        await api(caller, `/nodes/${file.id}/trash`, POST);
      }
      return caller;
    };
    const free = await trashOf(null);
    // Each position in turn: the newest root (purged first), the middle one, the oldest.
    const withHeld = [await trashOf(2), await trashOf(1), await trashOf(0)];
    restoreDeadline = setEmptyTrashDeadlineForTests(0);
    const countdown = async (caller: Caller) => {
      const seen: unknown[] = [];
      for (let request = 0; request < 6; request++) {
        const answer = await api(caller, "/trash", DELETE);
        seen.push([answer.status, answer.body]);
        if (answer.status === 204) break;
      }
      return seen;
    };
    const expected = await countdown(free);
    expect(expected).toEqual([
      [202, { remaining: 2 }],
      [202, { remaining: 1 }],
      [204, null],
    ]);
    for (const caller of withHeld) expect(await countdown(caller)).toEqual(expected);
    // One request row per root taken — a held one leaves the row any other does.
    const requestRows = async (caller: Caller) =>
      (await auditRows({ action: "node.purge_requested", actorUserId: caller!.user.id })).map((row) => [
        row.actorType,
        row.targetType,
        row.meta,
        typeof row.requestId,
        typeof row.ipHashDaily,
      ]);
    const expectedRows = await requestRows(free);
    expect(expectedRows).toEqual(Array.from({ length: 3 }, () => ["user", "node", null, "string", "string"]));
    for (const caller of withHeld) expect(await requestRows(caller)).toEqual(expectedRows);
  });
});
