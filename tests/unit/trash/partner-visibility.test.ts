// A share partner and the files they may not see (the partner rule, `partnerSees`, decided in
// `requireRole`): for an editor, a file that is under review, or that someone else uploaded and
// the scanner has not passed, does not exist — trash, restore and delete answer exactly as for an
// id that was never issued: status, body, every header and the number of statements. So does a
// node that is already in the trash, on the trash route.
import { describe, expect, it } from "vitest";
import type { ScanStatus } from "../../../src/shared/schemas/node";
import {
  api,
  envelope,
  makeFile,
  makeFolder,
  makeShare,
  member,
  setNode,
  type Answer,
  type Caller,
} from "./helpers";

const POST = { method: "POST" } as const;
const DELETE = { method: "DELETE" } as const;

/** Everything but the request id, which differs per request by design. */
const shape = (answer: Answer) => ({
  body: envelope(answer),
  headers: answer.headers,
  statements: answer.statements,
});

/** owner:  shared/ (editor: editor)  →  inner/  →  the files of a case */
async function tree() {
  const owner = await member();
  const editor = await member();
  const shared = await makeFolder(owner.id);
  const inner = await makeFolder(owner.id, shared.id);
  await makeShare(shared.id, owner.id, editor.id, { role: "editor" });
  return { owner, editor, inner, as: { owner: { user: owner }, editor: { user: editor } } as const };
}
type Tree = Awaited<ReturnType<typeof tree>>;

/**
 * Two files in the state of a case: one live, one in the trash — trashed by the EDITOR while it
 * was clean (so their restore would be allowed, were the file visible to them).
 */
async function files(t: Tree, status: ScanStatus, createdBy: string) {
  const live = await makeFile(t.owner.id, t.inner.id, { scanStatus: "clean", createdBy });
  const trashed = await makeFile(t.owner.id, t.inner.id, { scanStatus: "clean", createdBy });
  const done = await api(t.as.editor, `/nodes/${trashed.id}/trash`, POST);
  expect(done.status).toBe(200);
  await setNode(live.id, { scanStatus: status });
  await setNode(trashed.id, { scanStatus: status });
  return { live, trashed };
}

/** The three by-id routes, for `caller`, on `live` (trash, delete) and `trashed` (restore). */
async function routes(caller: Caller, ids: { live: string; trashed: string }) {
  return {
    trash: await api(caller, `/nodes/${ids.live}/trash`, POST),
    restore: await api(caller, `/nodes/${ids.trashed}/restore`, POST),
    delete: await api(caller, `/nodes/${ids.trashed}`, DELETE),
  };
}

const unknownFor = (caller: Caller) =>
  routes(caller, { live: crypto.randomUUID(), trashed: crypto.randomUUID() });

const INVISIBLE: Array<[string, ScanStatus, "owner" | "other"]> = [
  ["under review (uploaded by the owner)", "under_review", "owner"],
  ["pending, uploaded by the owner", "pending", "owner"],
  ["infected, uploaded by the owner", "infected", "owner"],
  ["pending, uploaded by a third person", "pending", "other"],
];

describe("an editor and a file they may not see", () => {
  it.each(INVISIBLE)(
    "%s: trash, restore and delete answer as for an unknown id — bytes, headers and statements",
    async (_name, status, uploader) => {
      const t = await tree();
      const createdBy = uploader === "owner" ? t.owner.id : (await member()).id;
      const f = await files(t, status, createdBy);
      const seen = await routes(t.as.editor, { live: f.live.id, trashed: f.trashed.id });
      const unknown = await unknownFor(t.as.editor);
      for (const route of ["trash", "restore", "delete"] as const) {
        expect(seen[route].status, route).toBe(404);
        expect(shape(seen[route]), route).toEqual(shape(unknown[route]));
      }
      // Nothing was done: the live file is not in the trash, the trashed one has not come back.
      const owner = await routes(t.as.owner, { live: f.live.id, trashed: f.trashed.id });
      expect(owner.restore.status).toBe(200);
      expect(owner.trash.status).toBe(200);
    },
  );

  it("the same file once the scanner has passed it: the editor may trash and restore it (the twin)", async () => {
    const t = await tree();
    const f = await files(t, "clean", t.owner.id);
    const seen = await routes(t.as.editor, { live: f.live.id, trashed: f.trashed.id });
    expect([seen.trash.status, seen.restore.status]).toEqual([200, 200]);
    // Delete is the owner's: a visible file is `403` for an editor, never an unknown id.
    expect(seen.delete.status).toBe(403);
  });

  it("their OWN upload while it is pending or infected is theirs to trash and restore", async () => {
    for (const status of ["pending", "infected"] as const) {
      const t = await tree();
      const f = await files(t, status, t.editor.id);
      const seen = await routes(t.as.editor, { live: f.live.id, trashed: f.trashed.id });
      expect([seen.trash.status, seen.restore.status], status).toEqual([200, 200]);
    }
  });
});
