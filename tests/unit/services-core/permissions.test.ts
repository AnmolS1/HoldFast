// The permission matrix: owner, editor, viewer, nobody and a public link — against each question
// a route asks. Run inside real requests.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { statementsSent } from "../../../src/worker/db/client";
import { auditLog, nodes, shares, user as userTable } from "../../../src/worker/db/schema";
import {
  assertContentAccess,
  assertNotTrashed,
  getAccess,
  requireRole,
  requireUpload,
  withLinkScope,
  type Role,
} from "../../../src/worker/services/permissions";
import { db } from "../../../src/worker/services/request-context";
import { makeFile, makeFolder, makeShare, makeUser, testDb } from "./helpers";
import { invoke, value, type Caller } from "./request";

/**
 * owner's tree:   shared/            ← shared with the editors and the viewer
 *                   inner/
 *                     file.txt
 *                 private/           ← shared with nobody
 *                   secret.txt
 */
async function tree() {
  const owner = await makeUser();
  const editor = await makeUser();
  const editorNoUpload = await makeUser();
  const viewer = await makeUser();
  const stranger = await makeUser();
  const shared = await makeFolder(owner.id);
  const inner = await makeFolder(owner.id, shared.id);
  const file = await makeFile(owner.id, inner.id, { scanStatus: "clean" });
  const privateFolder = await makeFolder(owner.id);
  const secret = await makeFile(owner.id, privateFolder.id, { scanStatus: "clean" });
  await makeShare(shared.id, owner.id, editor.id, { role: "editor", canUpload: true });
  await makeShare(shared.id, owner.id, editorNoUpload.id, { role: "editor", canUpload: false });
  await makeShare(shared.id, owner.id, viewer.id, { role: "viewer" });
  const as = (row: typeof owner): Caller => ({ user: row });
  return {
    owner: as(owner),
    editor: as(editor),
    editorNoUpload: as(editorNoUpload),
    viewer: as(viewer),
    stranger: as(stranger),
    ids: { owner: owner.id, viewer: viewer.id },
    shared,
    inner,
    file,
    privateFolder,
    secret,
  };
}

const outcome = async (caller: Caller, work: Parameters<typeof invoke>[1]) => {
  const invoked = await invoke(caller, work);
  return invoked.ok ? "ok" : `${invoked.status} ${invoked.error}`;
};

describe("getAccess", () => {
  it("answers the role, where it comes from and whether uploads are allowed", async () => {
    const t = await tree();
    for (const node of [t.shared, t.inner, t.file]) {
      expect(await value(t.owner, (c) => getAccess(c, node.id))).toEqual({
        role: "owner",
        shareRootId: null,
        canUpload: true,
        via: "owner",
      });
      // A share on a folder reaches everything under it.
      expect(await value(t.editor, (c) => getAccess(c, node.id))).toEqual({
        role: "editor",
        shareRootId: t.shared.id,
        canUpload: true,
        via: "share",
      });
      expect(await value(t.editorNoUpload, (c) => getAccess(c, node.id))).toEqual({
        role: "editor",
        shareRootId: t.shared.id,
        canUpload: false,
        via: "share",
      });
      expect(await value(t.viewer, (c) => getAccess(c, node.id))).toEqual({
        role: "viewer",
        shareRootId: t.shared.id,
        canUpload: false,
        via: "share",
      });
      expect(await value(t.stranger, (c) => getAccess(c, node.id))).toBeNull();
      expect(await value(null, (c) => getAccess(c, node.id))).toBeNull();
    }
    // Nothing leaks sideways: the share is on `shared`, not on the owner's other folders.
    for (const caller of [t.editor, t.viewer, t.stranger]) {
      expect(await value(caller, (c) => getAccess(c, t.privateFolder.id))).toBeNull();
      expect(await value(caller, (c) => getAccess(c, t.secret.id))).toBeNull();
    }
    for (const id of [crypto.randomUUID(), "not-an-id", ""]) {
      expect(await value(t.owner, (c) => getAccess(c, id))).toBeNull();
    }
  });

  it("a share that is not activated grants nothing; an inactive owner's shares grant nothing", async () => {
    const t = await tree();
    await testDb()
      .update(shares)
      .set({ activatedAt: null, granteeUserId: null })
      .where(eq(shares.granteeUserId, t.ids.viewer));
    expect(await value(t.viewer, (c) => getAccess(c, t.file.id))).toBeNull();

    // The control: the editor's share still works — until the owner is suspended.
    expect((await value(t.editor, (c) => getAccess(c, t.file.id)))?.role).toBe("editor");
    await testDb().update(userTable).set({ suspendedAt: new Date() }).where(eq(userTable.id, t.ids.owner));
    expect(await value(t.editor, (c) => getAccess(c, t.file.id))).toBeNull();
  });

  it("is cached for the request: the second answer for a node costs no statement", async () => {
    const t = await tree();
    const counts = await value(t.viewer, async (c) => {
      const sent = () => statementsSent(db(c));
      const start = sent();
      const first = await getAccess(c, t.file.id);
      const afterFirst = sent();
      const second = await getAccess(c, t.file.id);
      const afterSecond = sent();
      const missing = await getAccess(c, t.secret.id);
      const afterMiss = sent();
      const missingAgain = await getAccess(c, t.secret.id);
      return {
        same: first === second,
        firstCost: afterFirst - start,
        secondCost: afterSecond - afterFirst,
        missCost: afterMiss - afterSecond,
        secondMissCost: sent() - afterMiss,
        missing,
        missingAgain,
      };
    });
    expect(counts.same).toBe(true);
    // The control: the first answer for each node does cost statements.
    expect(counts.firstCost).toBeGreaterThan(0);
    expect(counts.missCost).toBeGreaterThan(0);
    expect(counts.secondCost).toBe(0);
    expect(counts.secondMissCost, "a cached 'no access' is not asked again either").toBe(0);
    expect(counts.missing).toBeNull();
    expect(counts.missingAgain).toBeNull();
  });
});

describe("requireRole", () => {
  it("the matrix: nobody → 404, too low → 403, enough → the access", async () => {
    const t = await tree();
    const expected: Record<string, Record<Role, string>> = {
      owner: { viewer: "ok", editor: "ok", owner: "ok" },
      editor: { viewer: "ok", editor: "ok", owner: "403 forbidden" },
      editorNoUpload: { viewer: "ok", editor: "ok", owner: "403 forbidden" },
      viewer: { viewer: "ok", editor: "403 forbidden", owner: "403 forbidden" },
      stranger: { viewer: "404 not_found", editor: "404 not_found", owner: "404 not_found" },
      signedOut: { viewer: "404 not_found", editor: "404 not_found", owner: "404 not_found" },
    };
    const callers: Record<string, Caller> = {
      owner: t.owner,
      editor: t.editor,
      editorNoUpload: t.editorNoUpload,
      viewer: t.viewer,
      stranger: t.stranger,
      signedOut: null,
    };
    for (const [name, caller] of Object.entries(callers)) {
      for (const min of ["viewer", "editor", "owner"] as const) {
        expect(await outcome(caller, (c) => requireRole(c, t.file.id, min)), `${name} needs ${min}`).toBe(
          expected[name]![min],
        );
      }
    }
    expect(await value(t.editor, (c) => requireRole(c, t.file.id, "editor"))).toMatchObject({
      role: "editor",
      via: "share",
    });
  });

  it("no existence oracle: an unknown id and a node of someone else's answer identically", async () => {
    const t = await tree();
    const unknown = await invoke(t.stranger, (c) => requireRole(c, crypto.randomUUID(), "viewer"));
    const foreign = await invoke(t.stranger, (c) => requireRole(c, t.secret.id, "viewer"));
    const malformed = await invoke(t.stranger, (c) => requireRole(c, "not-an-id", "owner"));
    for (const answer of [unknown, foreign, malformed]) {
      expect(answer).toMatchObject({ ok: false, status: 404, error: "not_found", message: "Not found." });
      expect("details" in answer ? answer.details : undefined).toBeUndefined();
    }
    // 403 only to someone who can already see the node.
    expect(await invoke(t.viewer, (c) => requireRole(c, t.file.id, "owner"))).toMatchObject({
      status: 403,
      error: "forbidden",
      details: { reason: "role" },
    });
  });
});

describe("requireUpload", () => {
  it("the owner and an editor with the toggle may; an editor without it and a viewer may not; nobody else sees it", async () => {
    const t = await tree();
    for (const parent of [t.shared, t.inner]) {
      expect(await outcome(t.owner, (c) => requireUpload(c, parent.id))).toBe("ok");
      expect(await outcome(t.editor, (c) => requireUpload(c, parent.id))).toBe("ok");
      expect(await invoke(t.editorNoUpload, (c) => requireUpload(c, parent.id))).toMatchObject({
        status: 403,
        error: "forbidden",
        details: { reason: "upload_not_allowed" },
      });
      // A viewer is refused for the ROLE, before the upload toggle is even looked at.
      expect(await invoke(t.viewer, (c) => requireUpload(c, parent.id))).toMatchObject({
        status: 403,
        error: "forbidden",
        details: { reason: "role" },
      });
      expect(await outcome(t.stranger, (c) => requireUpload(c, parent.id))).toBe("404 not_found");
      expect(await outcome(null, (c) => requireUpload(c, parent.id))).toBe("404 not_found");
    }
    expect(await outcome(t.editor, (c) => requireUpload(c, t.privateFolder.id))).toBe("404 not_found");
    expect(await value(t.editor, (c) => requireUpload(c, t.inner.id))).toMatchObject({
      role: "editor",
      canUpload: true,
      via: "share",
    });
  });

  it("the caller's own root (no parent) is theirs; not a signed-out caller's", async () => {
    const t = await tree();
    expect(await value(t.viewer, (c) => requireUpload(c, null))).toEqual({
      role: "owner",
      shareRootId: null,
      canUpload: true,
      via: "owner",
    });
    expect(await outcome(null, (c) => requireUpload(c, null))).toBe("404 not_found");
  });
});

describe("link scope", () => {
  it("is viewer for the link's root and its descendants, and nothing for any other node", async () => {
    const t = await tree();
    const scope = { linkId: crypto.randomUUID(), rootNodeId: t.shared.id };
    const linkAccess = { role: "viewer", shareRootId: t.shared.id, canUpload: false, via: "link" };
    // A stranger, a signed-out visitor — and the OWNER — all get exactly the link's access.
    for (const caller of [null, t.stranger, t.owner, t.editor]) {
      const seen = await value(caller, async (c) => {
        withLinkScope(c, scope);
        return {
          root: await getAccess(c, t.shared.id),
          inner: await getAccess(c, t.inner.id),
          file: await getAccess(c, t.file.id),
          outside: await getAccess(c, t.secret.id),
          outsideFolder: await getAccess(c, t.privateFolder.id),
          unknown: await getAccess(c, crypto.randomUUID()),
        };
      });
      expect(seen).toEqual({
        root: linkAccess,
        inner: linkAccess,
        file: linkAccess,
        outside: null,
        outsideFolder: null,
        unknown: null,
      });
    }
  });

  it("a link on a file reaches that file only, not its folder or its siblings", async () => {
    const t = await tree();
    const sibling = await makeFile(t.ids.owner, t.inner.id, { scanStatus: "clean" });
    const seen = await value(null, async (c) => {
      withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: t.file.id });
      return [await getAccess(c, t.file.id), await getAccess(c, t.inner.id), await getAccess(c, sibling.id)];
    });
    expect(seen.map((access) => access?.via ?? null)).toEqual(["link", null, null]);
  });

  it("requireRole and requireUpload under a link: viewer passes, more is 403, outside is 404", async () => {
    const t = await tree();
    const scoped = (work: Parameters<typeof invoke>[1]) =>
      outcome(t.owner, async (c) => {
        withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: t.shared.id });
        return work(c);
      });
    expect(await scoped((c) => requireRole(c, t.file.id, "viewer"))).toBe("ok");
    expect(await scoped((c) => requireRole(c, t.file.id, "editor"))).toBe("403 forbidden");
    expect(await scoped((c) => requireRole(c, t.file.id, "owner"))).toBe("403 forbidden");
    expect(await scoped((c) => requireUpload(c, t.inner.id))).toBe("403 forbidden");
    expect(await scoped((c) => requireUpload(c, null))).toBe("404 not_found");
    expect(await scoped((c) => requireRole(c, t.secret.id, "viewer"))).toBe("404 not_found");
  });

  it("setting the scope drops answers that were given for the session", async () => {
    const t = await tree();
    const seen = await value(t.owner, async (c) => {
      const before = await getAccess(c, t.secret.id);
      withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: t.shared.id });
      return { before: before?.via, after: await getAccess(c, t.secret.id) };
    });
    expect(seen).toEqual({ before: "owner", after: null });
  });
});

describe("a node that listings hide does not exist here either", () => {
  /** The tree, with the shared file hidden one of the two ways. */
  async function hidden(how: "taken_down" | "suspected_csam") {
    const t = await tree();
    await testDb()
      .update(nodes)
      .set(
        how === "taken_down"
          ? { takedownAt: new Date(), takedownReason: "dmca" }
          : { scanStatus: "suspected_csam", legalHold: true },
      )
      .where(eq(nodes.id, t.file.id));
    return t;
  }
  const shape = (answer: Awaited<ReturnType<typeof invoke>>) =>
    answer.ok
      ? "ok"
      : {
          status: answer.status,
          error: answer.error,
          message: answer.message,
          details: answer.details ?? null,
        };
  const auditsAbout = async (id: string) =>
    (await testDb().select().from(auditLog).where(eq(auditLog.targetId, id))).length;

  it.each(["taken_down", "suspected_csam"] as const)(
    "%s: owner, editor and viewer get the very 404 an unknown id gets — for every question",
    async (how) => {
      const t = await hidden(how);
      const unknown = crypto.randomUUID();
      const reference = shape(await invoke(t.owner, (c) => requireRole(c, unknown, "viewer")));
      expect(reference).toEqual({ status: 404, error: "not_found", message: "Not found.", details: null });
      const points: { blobs: string[] }[] = [];
      const options = {
        env: { METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) } },
      };

      for (const caller of [t.owner, t.editor, t.editorNoUpload, t.viewer, t.stranger, null]) {
        for (const min of ["viewer", "editor", "owner"] as const) {
          expect(shape(await invoke(caller, (c) => requireRole(c, t.file.id, min), options))).toEqual(
            reference,
          );
        }
        expect(await value(caller, (c) => getAccess(c, t.file.id))).toBeNull();
      }
      // Nothing recorded tells the two apart either: no audit row about the node, and the same
      // metrics for the hidden id as for the unknown one.
      expect(await auditsAbout(t.file.id)).toBe(0);
      const forHidden = points.map((point) => point.blobs.join("|"));
      points.length = 0;
      for (const min of ["viewer", "editor", "owner"] as const) {
        await invoke(t.owner, (c) => requireRole(c, unknown, min), options);
      }
      const perCall = forHidden.length / 18;
      expect(points.map((point) => point.blobs.join("|"))).toEqual(forHidden.slice(0, 3 * perCall));

      // The control: the same people still reach the folder the file is in, and a sibling.
      const sibling = await makeFile(t.ids.owner, t.inner.id, { scanStatus: "clean" });
      expect((await value(t.owner, (c) => getAccess(c, t.inner.id)))?.role).toBe("owner");
      expect((await value(t.viewer, (c) => getAccess(c, sibling.id)))?.role).toBe("viewer");
    },
  );

  it("a hidden FOLDER is not a place to upload into, and is hidden behind a link as well", async () => {
    const t = await tree();
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "abuse" })
      .where(eq(nodes.id, t.inner.id));
    expect(await outcome(t.owner, (c) => requireUpload(c, t.inner.id))).toBe("404 not_found");
    expect(await outcome(t.editor, (c) => requireUpload(c, t.inner.id))).toBe("404 not_found");
    const viaLink = await value(null, async (c) => {
      withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: t.shared.id });
      return { folder: await getAccess(c, t.inner.id), root: await getAccess(c, t.shared.id) };
    });
    expect(viaLink.folder).toBeNull();
    expect(viaLink.root?.via).toBe("link");
    // A link whose own root is hidden shows nothing.
    const t2 = await hidden("suspected_csam");
    const rooted = await value(null, async (c) => {
      withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: t2.file.id });
      return getAccess(c, t2.file.id);
    });
    expect(rooted).toBeNull();
  });

  it("hidden is inherited, like trash: a file in a taken-down folder is the same 404 for everyone, and behind a link rooted above, at and below the folder", async () => {
    const t = await tree();
    const sibling = await makeFile(t.ids.owner, t.shared.id, { scanStatus: "clean" });
    const unknown = crypto.randomUUID();
    const reference = shape(await invoke(t.owner, (c) => requireRole(c, unknown, "viewer")));
    const viaLink = (rootNodeId: string, nodeId: string) =>
      value(null, async (c) => {
        withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId });
        return (await getAccess(c, nodeId))?.via ?? null;
      });
    // Before: everyone with a role reaches the file, and so does each link.
    expect((await value(t.viewer, (c) => getAccess(c, t.file.id)))?.role).toBe("viewer");
    for (const root of [t.shared.id, t.inner.id, t.file.id])
      expect(await viaLink(root, t.file.id)).toBe("link");

    // ONE node is taken down: the folder. Its file is not touched.
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "abuse" })
      .where(eq(nodes.id, t.inner.id));
    for (const caller of [t.owner, t.editor, t.editorNoUpload, t.viewer, t.stranger]) {
      for (const min of ["viewer", "editor", "owner"] as const) {
        expect(shape(await invoke(caller, (c) => requireRole(c, t.file.id, min)))).toEqual(reference);
      }
      expect(await value(caller, (c) => getAccess(c, t.file.id))).toBeNull();
    }
    expect(await outcome(t.owner, (c) => requireUpload(c, t.inner.id))).toBe("404 not_found");
    // A link rooted above the folder, at the folder, and at the file below it.
    for (const root of [t.shared.id, t.inner.id, t.file.id]) {
      expect(await viaLink(root, t.file.id), root).toBeNull();
      const scoped = await invoke(null, async (c) => {
        withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: root });
        return requireRole(c, t.file.id, "viewer");
      });
      expect(shape(scoped)).toEqual(reference);
    }

    // The admin routes' option still sees it — and grants nothing to someone with no role.
    expect((await value(t.owner, (c) => getAccess(c, t.file.id, { includeHidden: true })))?.role).toBe(
      "owner",
    );
    expect(await value(t.stranger, (c) => getAccess(c, t.file.id, { includeHidden: true }))).toBeNull();
    // A sibling outside the folder is unaffected, for a role and through the link above.
    expect((await value(t.owner, (c) => getAccess(c, sibling.id)))?.role).toBe("owner");
    expect((await value(t.viewer, (c) => getAccess(c, sibling.id)))?.role).toBe("viewer");
    expect(await viaLink(t.shared.id, sibling.id)).toBe("link");
    expect(await viaLink(t.shared.id, t.shared.id)).toBe("link");
  });

  it("the same WORK for an unknown id, a hidden node, a node under a hidden ancestor and a node with no access", async () => {
    const t = await tree();
    const taken = await makeFile(t.ids.owner, t.shared.id, { scanStatus: "clean" });
    const locked = await makeFile(t.ids.owner, t.shared.id, { scanStatus: "clean" });
    const folder = await makeFolder(t.ids.owner, t.privateFolder.id);
    const below = await makeFile(t.ids.owner, folder.id, { scanStatus: "clean" });
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "dmca" })
      .where(eq(nodes.id, taken.id));
    await testDb()
      .update(nodes)
      .set({ scanStatus: "suspected_csam", legalHold: true })
      .where(eq(nodes.id, locked.id));
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "abuse" })
      .where(eq(nodes.id, folder.id));
    const ids = {
      unknown: crypto.randomUUID(),
      takenDown: taken.id,
      suspectedCsam: locked.id,
      hiddenAncestor: below.id,
      visible: t.secret.id,
    };
    /** Statements one question costs, per id — each in a request of its own (no cache). */
    const cost = async (caller: Caller, linkRoot?: string) => {
      const out: Record<string, { statements: number; access: boolean }> = {};
      for (const [name, id] of Object.entries(ids)) {
        out[name] = await value(caller, async (c) => {
          if (linkRoot) withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: linkRoot });
          const before = statementsSent(db(c));
          const access = await getAccess(c, id);
          return { statements: statementsSent(db(c)) - before, access: access !== null };
        });
      }
      return out;
    };
    const same = (statements: number, visible: boolean) => ({
      unknown: { statements, access: false },
      takenDown: { statements, access: false },
      suspectedCsam: { statements, access: false },
      hiddenAncestor: { statements, access: false },
      visible: { statements, access: visible },
    });
    // The owner: the access query and the hidden query, every time.
    expect(await cost(t.owner)).toEqual(same(2, true));
    // Someone with no access to any of them ("no access" and "locked" and "never issued").
    expect(await cost(t.stranger)).toEqual(same(2, false));
    // Through a link over the owner's private folder.
    expect(await cost(null, t.privateFolder.id)).toEqual(same(2, true));
    // NOT COVERED HERE — A GRANTEE: the access query reads the owner's state in a second
    // statement whenever the caller has a grant on the chain, so for a sharee a hidden shared
    // node costs one statement more than an unknown id. Equalised by seam pass H1 (in the access
    // query itself), which adds the grantee rows to this test.
    // Signed out and no link: nothing is asked at all, for any id.
    expect(await cost(null)).toEqual(same(0, false));
  });

  it("includeHidden — the admin routes' option — sees the node; the two answers are cached apart", async () => {
    for (const how of ["taken_down", "suspected_csam"] as const) {
      const t = await hidden(how);
      const seen = await value(t.owner, async (c) => ({
        byDefault: await getAccess(c, t.file.id),
        asAdminRoute: await getAccess(c, t.file.id, { includeHidden: true }),
        byDefaultAgain: await getAccess(c, t.file.id),
        required: await requireRole(c, t.file.id, "owner", { includeHidden: true }),
      }));
      expect(seen.byDefault, how).toBeNull();
      expect(seen.asAdminRoute, how).toMatchObject({ role: "owner", via: "owner" });
      expect(seen.byDefaultAgain, how).toBeNull();
      expect(seen.required, how).toMatchObject({ role: "owner" });
      // The option shows hidden nodes; it grants nothing to someone with no role.
      expect(await value(t.stranger, (c) => getAccess(c, t.file.id, { includeHidden: true }))).toBeNull();
      expect(
        await outcome(t.stranger, (c) => requireRole(c, t.file.id, "viewer", { includeHidden: true })),
      ).toBe("404 not_found");
    }
  });

  it("the other scan states and the trash are not 'hidden': the role still answers", async () => {
    const t = await tree();
    for (const scanStatus of ["pending", "infected", "under_review", "skipped", "error"] as const) {
      await testDb().update(nodes).set({ scanStatus }).where(eq(nodes.id, t.file.id));
      expect((await value(t.owner, (c) => getAccess(c, t.file.id)))?.role, scanStatus).toBe("owner");
    }
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true })
      .where(eq(nodes.id, t.file.id));
    expect((await value(t.owner, (c) => getAccess(c, t.file.id)))?.role).toBe("owner");
    expect(await outcome(t.owner, (c) => assertNotTrashed(c, t.file.id))).toBe("404 not_found");
  });
});

describe("assertNotTrashed", () => {
  it("is a 404 for a trashed node, for anything under a trashed folder and for an unknown id", async () => {
    const t = await tree();
    expect(await outcome(t.owner, (c) => assertNotTrashed(c, t.file.id))).toBe("ok");
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true })
      .where(eq(nodes.id, t.shared.id));
    for (const node of [t.shared, t.inner, t.file]) {
      expect(await outcome(t.owner, (c) => assertNotTrashed(c, node.id))).toBe("404 not_found");
    }
    expect(await outcome(t.owner, (c) => assertNotTrashed(c, t.secret.id))).toBe("ok");
    expect(await outcome(t.owner, (c) => assertNotTrashed(c, crypto.randomUUID()))).toBe("404 not_found");
  });
});

describe("assertContentAccess", () => {
  it("throws 403 for an impersonated session and passes for the user's own", async () => {
    const t = await tree();
    const work = async (c: Parameters<typeof assertContentAccess>[0]) => {
      assertContentAccess(c);
      return "minted";
    };
    expect(await value(t.owner, work)).toBe("minted");
    expect(await value(null, work)).toBe("minted");
    const impersonated: Caller = { user: t.owner!.user, impersonatedBy: "a".repeat(32) };
    expect(await invoke(impersonated, work)).toMatchObject({
      ok: false,
      status: 403,
      error: "forbidden",
      details: { reason: "impersonation_read_only" },
    });
    // The role itself is untouched: an impersonating admin sees what the user sees, and mints nothing.
    expect((await value(impersonated, (c) => getAccess(c, t.file.id)))?.role).toBe("owner");
  });
});
