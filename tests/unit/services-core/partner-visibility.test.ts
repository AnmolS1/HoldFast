// What anyone but the owner may see of a FILE by id: what their listing shows (`clean`), and —
// for the partner who uploaded its current version — their own upload while the scanner has not
// passed it. Never a file under review. Not visible = the unknown id's `404`, for the same work.
// Run inside real requests.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { statementsSent } from "../../../src/worker/db/client";
import {
  listChildren,
  OWNER_VISIBLE_STATUSES,
  partnerSees,
  replaceVersion,
  SHARED_VISIBLE_STATUSES,
  UPLOADER_VISIBLE_STATUSES,
} from "../../../src/worker/db/queries/nodes";
import { effectiveHidden, effectiveTrashed, nodeVisibility } from "../../../src/worker/db/queries/tree";
import { nodes, scanStatus, type ScanStatus } from "../../../src/worker/db/schema";
import {
  assertNotTrashed,
  getAccess,
  requireRole,
  requireUpload,
  withLinkScope,
} from "../../../src/worker/services/permissions";
import { db } from "../../../src/worker/services/request-context";
import { keyFor } from "../../../src/worker/services/storage";
import { makeFile, makeFolder, makeShare, makeUser, testDb } from "./helpers";
import { invoke, value, type Caller } from "./request";

const STATUSES = scanStatus.enumValues;

/**
 * owner's tree:   shared/      ← shared with the uploader (editor), another editor and a viewer
 *                   one file per scan status, each uploaded by the uploader
 */
async function tree() {
  const owner = await makeUser();
  const uploader = await makeUser();
  const otherEditor = await makeUser();
  const viewer = await makeUser();
  const shared = await makeFolder(owner.id);
  await makeShare(shared.id, owner.id, uploader.id, { role: "editor", canUpload: true });
  await makeShare(shared.id, owner.id, otherEditor.id, { role: "editor", canUpload: true });
  await makeShare(shared.id, owner.id, viewer.id, { role: "viewer" });
  const files = {} as Record<ScanStatus, string>;
  for (const status of STATUSES) {
    const file = await makeFile(owner.id, shared.id, {
      createdBy: uploader.id,
      scanStatus: status,
      ...(status === "suspected_csam" ? { legalHold: true } : {}),
    });
    files[status] = file.id;
  }
  const as = (row: typeof owner): Caller => ({ user: row });
  return {
    ids: { owner: owner.id, uploader: uploader.id, otherEditor: otherEditor.id, viewer: viewer.id },
    owner: as(owner),
    uploader: as(uploader),
    otherEditor: as(otherEditor),
    viewer: as(viewer),
    shared,
    files,
  };
}

/** The statuses whose file the caller reaches by id — each asked in a request of its own. */
async function seenById(caller: Caller, files: Record<ScanStatus, string>, linkRoot?: string) {
  const seen: ScanStatus[] = [];
  for (const status of STATUSES) {
    const access = await value(caller, async (c) => {
      if (linkRoot) withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: linkRoot });
      return getAccess(c, files[status]);
    });
    if (access) seen.push(status);
  }
  return seen;
}

/** The statuses whose file the folder's listing shows, given the listing's status list. */
async function listed(
  t: Awaited<ReturnType<typeof tree>>,
  visibleStatuses: readonly ScanStatus[],
): Promise<ScanStatus[]> {
  const page = await listChildren(testDb(), {
    scope: { ownerId: t.ids.owner },
    parentId: t.shared.id,
    sort: "name",
    dir: "asc",
    limit: 200,
    visibleStatuses,
  });
  const ids = new Set(page.items.map((row) => row.id));
  return STATUSES.filter((status) => ids.has(t.files[status]));
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

describe("the one definition", () => {
  it("partnerSees: a folder always; a file when clean, or the viewer's own upload not under review", () => {
    const uploader = "the-uploader";
    for (const status of STATUSES) {
      const file = { kind: "file" as const, scanStatus: status, createdBy: uploader };
      expect(partnerSees({ ...file, kind: "folder" }, null), status).toBe(true);
      expect(partnerSees(file, "somebody-else"), status).toBe(status === "clean");
      expect(partnerSees(file, null), status).toBe(status === "clean");
      // A file whose uploader's account is gone is nobody's upload.
      expect(partnerSees({ ...file, createdBy: null }, null), status).toBe(status === "clean");
      expect(partnerSees(file, uploader), status).toBe(
        status === "clean" || ["pending", "infected", "skipped", "error"].includes(status),
      );
    }
    expect([...SHARED_VISIBLE_STATUSES]).toEqual(["clean"]);
    expect([...UPLOADER_VISIBLE_STATUSES].sort()).toEqual(["error", "infected", "pending", "skipped"]);
    // The two states nobody but the owner (or nobody at all) may learn of are in neither list.
    for (const never of ["under_review", "suspected_csam"] as const) {
      expect(SHARED_VISIBLE_STATUSES).not.toContain(never);
      expect(UPLOADER_VISIBLE_STATUSES).not.toContain(never);
    }
  });

  it("nodeVisibility is effectiveHidden + effectiveTrashed + the row, in one statement, for every id", async () => {
    const t = await tree();
    const down = await makeFolder(t.ids.owner, t.shared.id);
    const underDown = await makeFile(t.ids.owner, down.id, { scanStatus: "clean" });
    const trashed = await makeFolder(t.ids.owner, t.shared.id, { deletedAt: new Date(), trashedRoot: true });
    const underTrashed = await makeFile(t.ids.owner, trashed.id, { scanStatus: "infected" });
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "abuse" })
      .where(eq(nodes.id, down.id));
    const ids = [
      ...Object.values(t.files),
      t.shared.id,
      down.id,
      underDown.id,
      trashed.id,
      underTrashed.id,
      crypto.randomUUID(),
      "not-an-id",
    ];
    for (const id of ids) {
      const seen = await nodeVisibility(testDb(), id);
      expect(seen.hidden, id).toBe(await effectiveHidden(testDb(), id));
      expect(seen.trashed, id).toBe(await effectiveTrashed(testDb(), id));
    }
    expect(await nodeVisibility(testDb(), underDown.id)).toEqual({
      hidden: true,
      trashed: false,
      kind: "file",
      scanStatus: "clean",
      createdBy: t.ids.owner,
    });
    expect(await nodeVisibility(testDb(), underTrashed.id)).toMatchObject({ hidden: false, trashed: true });
    expect(await nodeVisibility(testDb(), t.files.pending)).toEqual({
      hidden: false,
      trashed: false,
      kind: "file",
      scanStatus: "pending",
      createdBy: t.ids.uploader,
    });
    expect(await nodeVisibility(testDb(), crypto.randomUUID())).toEqual({
      hidden: true,
      trashed: true,
      kind: null,
      scanStatus: null,
      createdBy: null,
    });
  });
});

describe("a file by id, for someone who is not its owner", () => {
  it("by id and listed agree file by file over every status — but for the uploader's own unpassed uploads", async () => {
    const t = await tree();
    const ownersListing = await listed(t, OWNER_VISIBLE_STATUSES);
    const partnersListing = await listed(t, SHARED_VISIBLE_STATUSES);
    expect(partnersListing).toEqual(["clean"]);

    // The owner's view is unchanged: everything but the locked file, by id as in the listing.
    expect(await seenById(t.owner, t.files)).toEqual(ownersListing);
    expect(ownersListing).toEqual(STATUSES.filter((status) => status !== "suspected_csam"));
    // A partner who did not upload them, of either role: exactly what the listing shows.
    expect(await seenById(t.otherEditor, t.files)).toEqual(partnersListing);
    expect(await seenById(t.viewer, t.files)).toEqual(partnersListing);
    // A link visitor — signed out, or signed in as the uploader — likewise: nobody's upload.
    expect(await seenById(null, t.files, t.shared.id)).toEqual(partnersListing);
    expect(await seenById(t.uploader, t.files, t.shared.id)).toEqual(partnersListing);
    // The uploader: the listing, plus by id their own uploads the scanner has not passed.
    expect(await seenById(t.uploader, t.files)).toEqual(
      STATUSES.filter(
        (status) => partnersListing.includes(status) || UPLOADER_VISIBLE_STATUSES.includes(status),
      ),
    );
    expect(await seenById(t.uploader, t.files)).not.toContain("under_review");
  });

  it("not visible is the very 404 an unknown id gets, for every question and every role asked", async () => {
    const t = await tree();
    const cells: [Caller, ScanStatus[]][] = [
      [t.viewer, ["pending", "infected", "skipped", "error", "under_review"]],
      [t.otherEditor, ["pending", "infected", "skipped", "error", "under_review"]],
      [t.uploader, ["under_review"]],
    ];
    for (const [caller, statuses] of cells) {
      const unknown = shape(await invoke(caller, (c) => requireRole(c, crypto.randomUUID(), "viewer")));
      expect(unknown).toEqual({ status: 404, error: "not_found", message: "Not found.", details: null });
      for (const status of statuses) {
        const id = t.files[status];
        for (const min of ["viewer", "editor", "owner"] as const) {
          expect(shape(await invoke(caller, (c) => requireRole(c, id, min))), `${status} ${min}`).toEqual(
            unknown,
          );
        }
        expect(await value(caller, (c) => getAccess(c, id)), status).toBeNull();
        // A file is no place to upload into for anybody; the answer must not differ either.
        expect(shape(await invoke(caller, (c) => requireUpload(c, id))), status).toEqual(unknown);
      }
    }
    // What a role is asked of a file they DO see is still the role's answer.
    expect(shape(await invoke(t.viewer, (c) => requireRole(c, t.files.clean, "editor")))).toMatchObject({
      status: 403,
      error: "forbidden",
    });
    expect(await value(t.uploader, (c) => requireRole(c, t.files.infected, "editor"))).toMatchObject({
      role: "editor",
      via: "share",
    });
  });

  it("folders are unaffected, whatever status the row carries", async () => {
    const t = await tree();
    for (const status of ["pending", "infected", "under_review", "skipped", "error"] as const) {
      const folder = await makeFolder(t.ids.owner, t.shared.id, { scanStatus: status });
      for (const caller of [t.viewer, t.otherEditor, t.uploader]) {
        expect(await value(caller, (c) => getAccess(c, folder.id)), status).not.toBeNull();
      }
      expect(
        await value(null, async (c) => {
          withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: t.shared.id });
          return getAccess(c, folder.id);
        }),
      ).toMatchObject({ via: "link" });
    }
  });

  it("'their own upload' is the uploader of the CURRENT version: a replace hands the view over", async () => {
    const t = await tree();
    const file = await makeFile(t.ids.owner, t.shared.id, { createdBy: t.ids.uploader, scanStatus: "clean" });
    for (const caller of [t.uploader, t.otherEditor, t.viewer]) {
      expect(await value(caller, (c) => getAccess(c, file.id))).not.toBeNull();
    }
    // The other editor replaces it, through the real writer: the new version is pending.
    const versionId = crypto.randomUUID();
    await testDb().transaction((tx) =>
      replaceVersion(tx, file.id, {
        r2Key: keyFor(t.ids.owner, file.id, versionId),
        versionId,
        size: 7,
        sha256: null,
        createdBy: t.ids.otherEditor,
      }),
    );
    const [row] = await testDb().select().from(nodes).where(eq(nodes.id, file.id));
    expect(row).toMatchObject({ scanStatus: "pending", createdBy: t.ids.otherEditor });
    expect(await value(t.otherEditor, (c) => getAccess(c, file.id))).toMatchObject({ role: "editor" });
    expect(await value(t.uploader, (c) => getAccess(c, file.id))).toBeNull();
    expect(await value(t.viewer, (c) => getAccess(c, file.id))).toBeNull();
    expect(await value(t.owner, (c) => getAccess(c, file.id))).toMatchObject({ role: "owner" });
  });

  it("an admin's includeHidden is not subject to it; passed by anyone else it changes nothing", async () => {
    const t = await tree();
    const admin: Caller = {
      user: { ...t.viewer!.user, role: "admin", twoFactorEnabled: true },
      secondFactor: true,
    };
    const flag = { includeHidden: true } as const;
    expect(await value(admin, (c) => getAccess(c, t.files.under_review))).toBeNull();
    expect(await value(admin, (c) => getAccess(c, t.files.under_review, flag))).toMatchObject({
      role: "viewer",
    });
    expect(await value(t.viewer, (c) => getAccess(c, t.files.under_review, flag))).toBeNull();
    expect(await value(t.otherEditor, (c) => getAccess(c, t.files.pending, flag))).toBeNull();
  });
});

describe("the same WORK, whatever makes it a 404", () => {
  it("unknown, foreign, hidden, trashed (where asked) and not shown to a partner cost the same statements", async () => {
    const t = await tree();
    const stranger: Caller = { user: await makeUser() };
    const foreign = await makeFile(t.ids.owner, null, { scanStatus: "clean" });
    const takenDown = await makeFile(t.ids.owner, t.shared.id, { scanStatus: "clean" });
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "dmca" })
      .where(eq(nodes.id, takenDown.id));
    const trashedFolder = await makeFolder(t.ids.owner, t.shared.id, {
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const underTrashed = await makeFile(t.ids.owner, trashedFolder.id, { scanStatus: "clean" });
    const trashedFile = await makeFile(t.ids.owner, t.shared.id, {
      scanStatus: "clean",
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const about: Record<string, string> = {
      unknown: crypto.randomUUID(),
      foreign: foreign.id,
      takenDown: takenDown.id,
      suspectedCsam: t.files.suspected_csam,
      trashed: trashedFile.id,
      underTrashed: underTrashed.id,
      underReview: t.files.under_review,
      pending: t.files.pending,
      infected: t.files.infected,
      skipped: t.files.skipped,
      error: t.files.error,
      clean: t.files.clean,
    };
    /** Statements `requireRole` costs per id, each in a request of its own, and what it answered. */
    const cost = async (caller: Caller, opts: { notTrashed?: true; link?: string } = {}) => {
      const out: Record<string, string> = {};
      for (const [name, id] of Object.entries(about)) {
        out[name] = await value(caller, async (c) => {
          if (opts.link) withLinkScope(c, { linkId: crypto.randomUUID(), rootNodeId: opts.link });
          const before = statementsSent(db(c));
          const answer = await requireRole(c, id, "viewer", opts.notTrashed ? { notTrashed: true } : {}).then(
            () => "ok",
            () => "404",
          );
          return `${answer}/${statementsSent(db(c)) - before}`;
        });
      }
      return out;
    };
    const all = (statements: number, ok: string[]) =>
      Object.fromEntries(
        Object.keys(about).map((name) => [name, `${ok.includes(name) ? "ok" : "404"}/${statements}`]),
      );
    const unpassed = ["pending", "infected", "skipped", "error"];

    // Where the route asks for "not in the trash": every 404 of the list, and every answer, 3.
    const asked = { notTrashed: true } as const;
    expect(await cost(t.viewer, asked)).toEqual(all(3, ["clean"]));
    expect(await cost(t.otherEditor, asked)).toEqual(all(3, ["clean"]));
    expect(await cost(t.uploader, asked)).toEqual(all(3, ["clean", ...unpassed]));
    expect(await cost(stranger, asked)).toEqual(all(3, []));
    expect(await cost(t.owner, asked)).toEqual(all(3, ["foreign", "clean", "underReview", ...unpassed]));
    // Without it the trash is not this function's question — for the same three statements.
    const inTrash = ["trashed", "underTrashed"];
    expect(await cost(t.viewer)).toEqual(all(3, ["clean", ...inTrash]));
    expect(await cost(t.uploader)).toEqual(all(3, ["clean", ...unpassed, ...inTrash]));
    expect(await cost(stranger)).toEqual(all(3, []));
    expect(await cost(t.owner)).toEqual(all(3, ["foreign", "clean", "underReview", ...unpassed, ...inTrash]));
    // Behind a link over the shared folder: two, for every answer — signed in or not.
    expect(await cost(null, { link: t.shared.id })).toEqual(all(2, ["clean", ...inTrash]));
    expect(await cost(null, { link: t.shared.id, notTrashed: true })).toEqual(all(2, ["clean"]));
    expect(await cost(t.uploader, { link: t.shared.id, notTrashed: true })).toEqual(all(2, ["clean"]));
    // Signed out and no link: nothing is asked at all.
    expect(await cost(null, asked)).toEqual(all(0, []));
  });

  it("notTrashed: in the trash is the unknown id's 404 too — the owner's own included, from the statements already sent", async () => {
    const t = await tree();
    const folder = await makeFolder(t.ids.owner, t.shared.id, { deletedAt: new Date(), trashedRoot: true });
    const below = await makeFile(t.ids.owner, folder.id, { scanStatus: "clean" });
    for (const caller of [t.owner, t.uploader, t.viewer]) {
      const unknown = shape(
        await invoke(caller, (c) => requireRole(c, crypto.randomUUID(), "viewer", { notTrashed: true })),
      );
      for (const id of [folder.id, below.id]) {
        expect(
          shape(await invoke(caller, (c) => requireRole(c, id, "viewer", { notTrashed: true }))),
        ).toEqual(unknown);
        // One request, both questions: the second is answered from what the first read.
        const both = await value(caller, async (c) => {
          const plain = await getAccess(c, id);
          const sent = statementsSent(db(c));
          const live = await getAccess(c, id, { notTrashed: true });
          const again = await getAccess(c, id);
          return { plain: plain !== null, live, again: again !== null, extra: statementsSent(db(c)) - sent };
        });
        expect(both).toEqual({ plain: true, live: null, again: true, extra: 0 });
        // It is `assertNotTrashed`'s answer, without its statement.
        expect(shape(await invoke(caller, (c) => assertNotTrashed(c, id)))).toEqual(unknown);
      }
      expect(await value(caller, (c) => getAccess(c, t.files.clean, { notTrashed: true }))).not.toBeNull();
    }
    // An admin route that asks both: sees a hidden node, not a trashed one.
    const admin: Caller = {
      user: { ...t.owner!.user, role: "admin", twoFactorEnabled: true },
      secondFactor: true,
    };
    const flags = { includeHidden: true, notTrashed: true } as const;
    expect(await value(admin, (c) => getAccess(c, t.files.suspected_csam, flags))).toMatchObject({
      role: "owner",
    });
    expect(await value(admin, (c) => getAccess(c, below.id, flags))).toBeNull();
    expect(await value(admin, (c) => getAccess(c, below.id, { includeHidden: true }))).not.toBeNull();
  });
});
