// The permission matrix: owner, editor, viewer, a person whose share was never activated, and a
// stranger — against every endpoint of the nodes API. `404` for the last two on every route that
// names a node: no access and no such node are one answer.
import { describe, expect, it } from "vitest";
import { api, scanQueueSpy, sharedTree, type Answer, type Caller, type SharedTree } from "./helpers";

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
    expected: ["202", "403", "403", "404", "404"],
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
