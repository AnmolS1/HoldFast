// Every call of the nodes API that names a node — in its path or in its body. The tests that say
// "on every by-id route" run this list.
import { api, scanQueueSpy, type Answer, type Caller, type SharedTree } from "./helpers";

/** Every route of the nodes API that takes a node id, asked about `id` (`t` is a visible tree). */
export const BY_ID: { name: string; call: (caller: Caller, id: string, t: SharedTree) => Promise<Answer> }[] =
  [
    { name: "GET /nodes/:id", call: (caller, id) => api(caller, "GET", `/nodes/${id}`) },
    { name: "GET /nodes/:id/children", call: (caller, id) => api(caller, "GET", `/nodes/${id}/children`) },
    {
      name: "PATCH /nodes/:id {name}",
      call: (caller, id) => api(caller, "PATCH", `/nodes/${id}`, { body: { name: "seen.txt" } }),
    },
    {
      name: "PATCH /nodes/:id {starred}",
      call: (caller, id) => api(caller, "PATCH", `/nodes/${id}`, { body: { starred: true } }),
    },
    {
      name: "POST /nodes/:id/move",
      call: (caller, id, t) => api(caller, "POST", `/nodes/${id}/move`, { body: { parentId: t.dest.id } }),
    },
    {
      name: "POST /nodes/:id/move (as the target)",
      call: (caller, id, t) => api(caller, "POST", `/nodes/${t.notes.id}/move`, { body: { parentId: id } }),
    },
    {
      name: "POST /nodes/folder (as the parent)",
      call: (caller, id) => api(caller, "POST", "/nodes/folder", { body: { parentId: id, name: "inside" } }),
    },
    {
      name: "POST /nodes/:id/download-url (download)",
      call: (caller, id) => api(caller, "POST", `/nodes/${id}/download-url`, { body: { kind: "download" } }),
    },
    {
      name: "POST /nodes/:id/download-url (inline)",
      call: (caller, id) => api(caller, "POST", `/nodes/${id}/download-url`, { body: { kind: "inline" } }),
    },
    {
      name: "GET /nodes/:id/thumb-url",
      call: (caller, id) => api(caller, "GET", `/nodes/${id}/thumb-url?size=320`),
    },
    {
      name: "POST /nodes/:id/rescan",
      call: (caller, id) => api(caller, "POST", `/nodes/${id}/rescan`, { env: scanQueueSpy().env }),
    },
    {
      name: "POST /nodes/zip-manifest",
      call: (caller, id) => api(caller, "POST", "/nodes/zip-manifest", { body: { nodeIds: [id] } }),
    },
    {
      name: "POST /nodes/zip-manifest (among others)",
      call: (caller, id, t) =>
        api(caller, "POST", "/nodes/zip-manifest", { body: { nodeIds: [t.dest.id, id] } }),
    },
    {
      name: "POST /nodes/download-urls",
      call: (caller, id) => api(caller, "POST", "/nodes/download-urls", { body: { nodeIds: [id] } }),
    },
  ];
