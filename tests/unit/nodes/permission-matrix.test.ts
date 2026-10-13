// The permission matrix: owner, editor, viewer, a person whose share was never activated, and a
// stranger — against every endpoint of the nodes API. `404` for the last two on every route that
// names a node: no access and no such node are one answer.
import { describe, expect, it } from "vitest";
import { replaceVersion } from "../../../src/worker/db/queries/nodes";
import { keyFor } from "../../../src/worker/services/storage";
import { BY_ID } from "./by-id-routes";
import {
  api,
  comparable,
  makeFile,
  makeFolder,
  makeShare,
  nodeById,
  person,
  scanQueueSpy,
  setStatus,
  sharedTree,
  takeDown,
  testDb,
  type Answer,
  type Caller,
  type SharedTree,
} from "./helpers";

const CALLERS = ["owner", "editor", "viewer", "invited", "stranger"] as const;
type Who = (typeof CALLERS)[number];

type Row = {
  endpoint: string;
  /** The request `who` makes against tree `t`. */
  call: (t: SharedTree, caller: Caller, who: Who) => Promise<Answer>;
  /** What each caller gets, in the order of CALLERS. */
  expected: [string, string, string, string, string];
  /** What an answer is summarised as; the status alone unless said otherwise. */
  cell?: (answer: Answer) => string;
};

const batchCell = (answer: Answer) =>
  `${answer.status} ${answer.body.items?.[0]?.url ? "url" : (answer.body.items?.[0]?.error ?? answer.body.error)}`;

const ROWS: Row[] = [
  {
    endpoint: "GET /nodes/root",
    call: (_t, caller) => api(caller, "GET", "/nodes/root"),
    expected: ["200", "200", "200", "200", "200"],
  },
  {
    endpoint: "GET /nodes/:id/children",
    call: (t, caller) => api(caller, "GET", `/nodes/${t.inner.id}/children`),
    expected: ["200", "200", "200", "404", "404"],
  },
  {
    endpoint: "GET /nodes/:id",
    call: (t, caller) => api(caller, "GET", `/nodes/${t.notes.id}`),
    expected: ["200", "200", "200", "404", "404"],
  },
  {
    endpoint: "POST /nodes/folder",
    call: (t, caller, who) =>
      api(caller, "POST", "/nodes/folder", { body: { parentId: t.inner.id, name: `made by ${who}` } }),
    expected: ["200", "200", "403", "404", "404"],
  },
  {
    endpoint: "PATCH /nodes/:id {name}",
    call: (t, caller, who) =>
      api(caller, "PATCH", `/nodes/${t.notes.id}`, { body: { name: `renamed by ${who}.txt` } }),
    expected: ["200", "200", "403", "404", "404"],
  },
  {
    endpoint: "PATCH /nodes/:id {starred}",
    call: (t, caller) => api(caller, "PATCH", `/nodes/${t.notes.id}`, { body: { starred: true } }),
    expected: ["200", "403", "403", "404", "404"],
  },
  {
    endpoint: "POST /nodes/:id/move",
    call: (t, caller) => api(caller, "POST", `/nodes/${t.notes.id}/move`, { body: { parentId: t.dest.id } }),
    expected: ["200", "200", "403", "404", "404"],
  },
  {
    endpoint: "POST /nodes/:id/download-url",
    call: (t, caller) =>
      api(caller, "POST", `/nodes/${t.notes.id}/download-url`, { body: { kind: "download" } }),
    expected: ["200", "200", "200", "404", "404"],
  },
  {
    endpoint: "GET /nodes/:id/thumb-url",
    call: (t, caller) => api(caller, "GET", `/nodes/${t.photo.id}/thumb-url?size=320`),
    expected: ["200", "200", "200", "404", "404"],
  },
  {
    endpoint: "POST /nodes/zip-manifest",
    call: (t, caller) => api(caller, "POST", "/nodes/zip-manifest", { body: { nodeIds: [t.inner.id] } }),
    expected: ["200", "200", "200", "404", "404"],
  },
  {
    endpoint: "POST /nodes/download-urls",
    call: (t, caller) => api(caller, "POST", "/nodes/download-urls", { body: { nodeIds: [t.notes.id] } }),
    expected: ["200 url", "200 url", "200 url", "200 not_found", "200 not_found"],
    cell: batchCell,
  },
  {
    endpoint: "POST /nodes/:id/rescan",
    // The queue is a stand-in: no object is stored for the fixture, so nothing could scan it.
    call: (t, caller) => api(caller, "POST", `/nodes/${t.broken.id}/rescan`, { env: scanQueueSpy().env }),
    // The file is in scan `error`: among the partners only its uploader (the editor) still sees it.
    expected: ["202", "403", "404", "404", "404"],
  },
  {
    endpoint: "GET /account/usage",
    call: (_t, caller) => api(caller, "GET", "/account/usage"),
    expected: ["200", "200", "200", "200", "200"],
  },
];

describe("permission matrix", () => {
  it.each(ROWS)("$endpoint", async (row) => {
    const t = await sharedTree();
    const cells: string[] = [];
    for (const who of CALLERS) {
      const answer = await row.call(t, t[who].as, who);
      cells.push(row.cell ? row.cell(answer) : String(answer.status));
      // No access is `not_found` and nothing else; too low a role is `forbidden`.
      if (answer.status === 404) expect(answer.body.error, `${row.endpoint} as ${who}`).toBe("not_found");
      if (answer.status === 403) expect(answer.body.error, `${row.endpoint} as ${who}`).toBe("forbidden");
    }
    expect(cells, row.endpoint).toEqual(row.expected);
  });

  it("signed out: 401 on every route, whatever the id", async () => {
    const t = await sharedTree();
    for (const row of ROWS) {
      const answer = await row.call(t, null, "stranger");
      expect(answer.status, row.endpoint).toBe(401);
      expect(answer.body.error, row.endpoint).toBe("unauthorized");
    }
  });

  it("an unverified address: 403 on every route, before anything is looked up", async () => {
    const t = await sharedTree();
    const unverified: Caller = { user: { ...t.owner.row, emailVerified: false } };
    for (const row of ROWS) {
      const answer = await row.call(t, unverified, "owner");
      expect(answer.status, row.endpoint).toBe(403);
      expect(answer.body.details, row.endpoint).toEqual({ reason: "email_unverified" });
    }
  });

  it("the top level and the usage are the caller's own: nothing of the owner's is in them", async () => {
    const t = await sharedTree();
    for (const who of ["editor", "viewer", "invited", "stranger"] as const) {
      const root = await api(t[who].as, "GET", "/nodes/root");
      expect(root.body.items, who).toEqual([]);
    }
    const own = await api(t.owner.as, "GET", "/nodes/root");
    expect(own.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [t.shared.id, t.privateFolder.id].sort(),
    );
  });

  it("a share on one folder reaches nothing beside it", async () => {
    const t = await sharedTree();
    for (const who of ["editor", "viewer"] as const) {
      for (const [method, path, body] of [
        ["GET", `/nodes/${t.secret.id}`, undefined],
        ["GET", `/nodes/${t.privateFolder.id}/children`, undefined],
        ["PATCH", `/nodes/${t.secret.id}`, { name: "mine now.txt" }],
        ["POST", `/nodes/${t.secret.id}/move`, { parentId: t.dest.id }],
        ["POST", "/nodes/folder", { parentId: t.privateFolder.id, name: "in" }],
        ["POST", `/nodes/${t.secret.id}/download-url`, { kind: "download" }],
        ["POST", "/nodes/zip-manifest", { nodeIds: [t.inner.id, t.privateFolder.id] }],
      ] as const) {
        const answer = await api(t[who].as, method, path, { body });
        expect(answer.status, `${who} ${method} ${path}`).toBe(404);
        expect(answer.body.error).toBe("not_found");
      }
    }
    // A target the editor has no share to is not there for them either.
    const out = await api(t.editor.as, "POST", `/nodes/${t.notes.id}/move`, {
      body: { parentId: t.privateFolder.id },
    });
    expect([out.status, out.body.error]).toEqual([404, "not_found"]);
  });
});

// What a share partner may see of a file BY ID: what their listing would show them — a clean
// file — and, the one exception, a file they uploaded themselves while the scanner has not passed
// it. Never a file under review. Everything else answers as an id that was never issued, on
// every route, and is in neither list of a zip manifest.
describe("a share partner and files that are not clean", () => {
  const STATES = ["clean", "pending", "infected", "under_review", "skipped", "error"] as const;
  type State = (typeof STATES)[number];
  const VIEWERS = ["owner", "uploader", "otherEditor", "viewer"] as const;
  type Viewer = (typeof VIEWERS)[number];

  /** Is the file there for them at all? */
  const partnerSeesOnly = (...states: State[]) =>
    Object.fromEntries(STATES.map((state) => [state, states.includes(state)])) as Record<State, boolean>;
  const SEES: Record<Viewer, Record<State, boolean>> = {
    owner: partnerSeesOnly(...STATES),
    uploader: partnerSeesOnly("clean", "pending", "infected", "skipped", "error"),
    otherEditor: partnerSeesOnly("clean"),
    viewer: partnerSeesOnly("clean"),
  };
  /** For those who see it: what its download answers, and where a manifest puts it. */
  const unscanned = (state: State) => state === "skipped" || state === "error";
  const downloadOf = (viewer: Viewer, state: State) =>
    state === "clean"
      ? "200"
      : state === "pending"
        ? "409 scan_pending"
        : unscanned(state) && viewer === "owner"
          ? "200 unscanned"
          : "403 scan_blocked";
  const inManifestOf = (viewer: Viewer, state: State) =>
    state === "clean"
      ? "entry"
      : state === "pending"
        ? "skipped scan_pending"
        : unscanned(state) && viewer === "owner"
          ? "skipped unscanned"
          : "skipped scan_blocked";

  /** The shared tree, a second editor, and one image per state that the FIRST editor uploaded. */
  async function withUploads() {
    const t = await sharedTree();
    const otherEditor = await person();
    await makeShare(t.shared.id, t.owner.id, otherEditor.id, { role: "editor", canUpload: true });
    const folder = await makeFolder(t.owner.id, t.shared.id);
    const files = {} as Record<State, Awaited<ReturnType<typeof makeFile>>>;
    for (const state of STATES) {
      files[state] = await makeFile(t.owner.id, folder.id, {
        name: `upload-${state}.png`,
        mimeSniffed: "image/png",
        scanStatus: state,
        createdBy: t.editor.id,
      });
    }
    const callers: Record<Viewer, Caller> = {
      owner: t.owner.as,
      uploader: t.editor.as,
      otherEditor: otherEditor.as,
      viewer: t.viewer.as,
    };
    return { t, folder, files, callers };
  }

  it.each(VIEWERS.flatMap((viewer) => STATES.map((state) => ({ viewer, state }))))(
    "$viewer × $state",
    async ({ viewer, state }) => {
      const { t, folder, files, callers } = await withUploads();
      const caller = callers[viewer];
      const file = files[state];
      const detail = await api(caller, "GET", `/nodes/${file.id}`);
      const download = await api(caller, "POST", `/nodes/${file.id}/download-url`, {
        body: { kind: "download" },
      });
      const zip = await api(caller, "POST", "/nodes/zip-manifest", { body: { nodeIds: [folder.id] } });
      expect(zip.status).toBe(200);
      const entry = zip.body.entries.find((item: { nodeId: string }) => item.nodeId === file.id);
      const skipped = zip.body.skipped.find((item: { nodeId: string }) => item.nodeId === file.id);
      const inManifest = entry ? "entry" : skipped ? `skipped ${skipped.reason}` : "absent";

      if (SEES[viewer][state]) {
        expect(detail.status).toBe(200);
        expect(detail.body.node.scanStatus).toBe(state);
        expect(
          download.status === 200
            ? ["200", download.body.warning].filter(Boolean).join(" ")
            : `${download.status} ${download.body.error}`,
        ).toBe(downloadOf(viewer, state));
        expect(inManifest).toBe(inManifestOf(viewer, state));
        return;
      }

      // Not there: every by-id route answers exactly what it answers for an id nobody was issued.
      expect(inManifest).toBe("absent");
      expect(JSON.stringify(zip.body)).not.toContain(file.name);
      for (const route of BY_ID) {
        const unknownId = crypto.randomUUID();
        const unknown = await route.call(caller, unknownId, t);
        const answer = await route.call(caller, file.id, t);
        expect(comparable(answer, { [file.id]: "ID" }), route.name).toEqual(
          comparable(unknown, { [unknownId]: "ID" }),
        );
        // And for the same work: "not visible to you" costs what "never issued" costs.
        expect(answer.statements, `${route.name}: statements`).toBe(unknown.statements);
      }
      const row = (await nodeById(file.id))!;
      expect([row.name, row.parentId, row.starred, row.scanStatus]).toEqual([
        file.name,
        folder.id,
        false,
        state,
      ]);
    },
  );

  it("the uploader sees their own skipped / error upload as blocked; the listings stay clean-only for every partner", async () => {
    const { folder, files, callers } = await withUploads();
    await setStatus(files.pending.id, "error");
    const own = await api(callers.uploader, "POST", `/nodes/${files.pending.id}/download-url`, {
      body: { kind: "download" },
    });
    expect([own.status, own.body.error]).toEqual([403, "scan_blocked"]);
    expect((await api(callers.viewer, "GET", `/nodes/${files.pending.id}`)).status).toBe(404);
    for (const viewer of ["uploader", "otherEditor", "viewer"] as const) {
      const listed = await api(callers[viewer], "GET", `/nodes/${folder.id}/children`);
      expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([files.clean.id]);
    }
    const mine = await api(callers.owner, "GET", `/nodes/${folder.id}/children`);
    expect(mine.body.items).toHaveLength(STATES.length);
  });

  it("'their own upload' is the CURRENT version's: when someone else replaces the file, the previous uploader no longer has it", async () => {
    const { t, folder, callers } = await withUploads();
    const otherEditorId = callers.otherEditor!.user.id;
    const file = await makeFile(t.owner.id, folder.id, {
      name: "replaced.png",
      mimeSniffed: "image/png",
      scanStatus: "clean",
      createdBy: t.editor.id,
    });
    expect((await api(callers.uploader, "GET", `/nodes/${file.id}`)).status).toBe(200);

    // The other editor replaces it (the query an upload's completion runs): a new version, not yet scanned.
    const versionId = crypto.randomUUID();
    await replaceVersion(testDb(), file.id, {
      r2Key: keyFor(t.owner.id, file.id, versionId),
      versionId,
      size: 321,
      sha256: null,
      createdBy: otherEditorId,
    });
    const row = (await nodeById(file.id))!;
    expect([row.scanStatus, row.createdBy]).toEqual(["pending", otherEditorId]);

    const mine = await api(callers.otherEditor, "GET", `/nodes/${file.id}`);
    expect([mine.status, mine.body.node.scanStatus]).toEqual([200, "pending"]);
    expect((await api(callers.owner, "GET", `/nodes/${file.id}`)).status).toBe(200);
    // For the editor who uploaded the PREVIOUS version it is gone, on every route.
    for (const route of BY_ID) {
      const unknownId = crypto.randomUUID();
      const unknown = await route.call(callers.uploader, unknownId, t);
      const answer = await route.call(callers.uploader, file.id, t);
      expect(comparable(answer, { [file.id]: "ID" }), route.name).toEqual(
        comparable(unknown, { [unknownId]: "ID" }),
      );
      expect(answer.statements, `${route.name}: statements`).toBe(unknown.statements);
    }
    const zip = await api(callers.uploader, "POST", "/nodes/zip-manifest", {
      body: { nodeIds: [folder.id] },
    });
    expect(JSON.stringify(zip.body)).not.toContain(file.id);
    const theirs = await api(callers.otherEditor, "POST", "/nodes/zip-manifest", {
      body: { nodeIds: [folder.id] },
    });
    expect(theirs.body.skipped.find((item: { nodeId: string }) => item.nodeId === file.id)?.reason).toBe(
      "scan_pending",
    );
  });

  it("folders are unaffected, and so is a partner's clean file that someone else uploaded", async () => {
    const { t, folder, files, callers } = await withUploads();
    for (const viewer of ["uploader", "otherEditor", "viewer"] as const) {
      expect((await api(callers[viewer], "GET", `/nodes/${folder.id}`)).status).toBe(200);
      expect((await api(callers[viewer], "GET", `/nodes/${files.clean.id}`)).status).toBe(200);
      expect((await api(callers[viewer], "GET", `/nodes/${t.notes.id}`)).status).toBe(200);
    }
  });

  it("every kind of 404 costs one number of statements on a route: unknown, no share, hidden, trashed, not visible", async () => {
    const { t, folder, files, callers } = await withUploads();
    const down = await makeFile(t.owner.id, folder.id, { scanStatus: "clean" });
    await takeDown(down.id);
    const locked = await makeFile(t.owner.id, folder.id, {});
    await setStatus(locked.id, "suspected_csam");
    const trashed = await makeFile(t.owner.id, folder.id, {
      scanStatus: "clean",
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const kinds: [string, string][] = [
      ["no share to it", t.secret.id],
      ["taken down", down.id],
      ["locked", locked.id],
      ["in the trash", trashed.id],
      ["under review", files.under_review.id],
      ["pending, someone else's", files.pending.id],
      ["infected, someone else's", files.infected.id],
    ];
    for (const viewer of ["otherEditor", "viewer"] as const) {
      for (const route of BY_ID) {
        const unknown = await route.call(callers[viewer], crypto.randomUUID(), t);
        const counts = new Map<string, number>([["unknown", unknown.statements]]);
        for (const [label, id] of kinds) {
          const answer = await route.call(callers[viewer], id, t);
          expect(answer.status, `${viewer} ${route.name} ${label}`).toBe(unknown.status);
          counts.set(label, answer.statements);
        }
        expect(new Set(counts.values()).size, `${viewer} ${route.name}: ${JSON.stringify([...counts])}`).toBe(
          1,
        );
      }
    }
    // The stranger, who has no share at all: the same number for a real id and a made-up one.
    for (const route of BY_ID) {
      const unknown = await route.call(t.stranger.as, crypto.randomUUID(), t);
      const real = await route.call(t.stranger.as, files.clean.id, t);
      expect(real.statements, route.name).toBe(unknown.statements);
    }
  });
});
