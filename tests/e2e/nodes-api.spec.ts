// The nodes API end to end: `vite dev`, the real database, a real sign-up and its session cookie
// — no mock anywhere. Folders only, on purpose: nothing here needs an upload.
//
// Playwright's `request` context is not a browser: it sends neither `Origin` nor `Sec-Fetch-Site`
// by itself, so every state change names the app's own origin, as the SPA's requests do.
import type { APIRequestContext } from "@playwright/test";
import { NodeDetailDto, NodeDto, NodePage } from "../../src/shared/schemas/node";
import { signedInUser } from "../setup/auth-fixtures";
import { expect, test } from "./fixtures";

type Send = (method: "POST" | "PATCH", path: string, data: unknown) => ReturnType<APIRequestContext["post"]>;

const sender =
  (request: APIRequestContext, origin: string): Send =>
  (method, path, data) =>
    request.fetch(path, { method, data, headers: { origin, "content-type": "application/json" } });

test("folders: create, rename, move, star, list with each sort, breadcrumbs", async ({
  request,
  origins,
  clientIp,
}) => {
  // Before there is a session, the API says so — and nothing else.
  const signedOut = await request.get("/api/nodes/root");
  expect(signedOut.status()).toBe(401);
  expect(await signedOut.json()).toMatchObject({ error: "unauthorized" });

  const user = await signedInUser(request, { clientIp });
  const send = sender(request, origins.app);

  // Create.
  const made: Record<string, NodeDto> = {};
  for (const [key, parent, name] of [
    ["alpha", null, "Alpha"],
    ["beta", null, "beta"],
    ["child", "alpha", "Drafts"],
  ] as const) {
    const response = await send("POST", "/api/nodes/folder", {
      parentId: parent ? made[parent]!.id : null,
      name,
    });
    expect(response.status(), name).toBe(200);
    made[key] = NodeDto.parse(await response.json());
    expect(made[key]).toMatchObject({ kind: "folder", name, role: "owner", owner: { id: user.id } });
  }
  expect(made.child!.parentId).toBe(made.alpha!.id);
  // A user reference carries a display name, never an address.
  expect(JSON.stringify(made.alpha)).not.toContain(user.email);

  // A name that is taken: 409, with the id of the folder that holds it.
  const taken = await send("POST", "/api/nodes/folder", { parentId: null, name: "ALPHA" });
  expect(taken.status()).toBe(409);
  expect(await taken.json()).toMatchObject({ error: "conflict", details: { existingId: made.alpha!.id } });

  // Rename.
  const renamed = await send("PATCH", `/api/nodes/${made.child!.id}`, { name: "Drafts 2026" });
  expect(renamed.status()).toBe(200);
  expect(NodeDto.parse(await renamed.json())).toMatchObject({ id: made.child!.id, name: "Drafts 2026" });

  // Move — and a move that would put a folder inside itself.
  const moved = await send("POST", `/api/nodes/${made.child!.id}/move`, { parentId: made.beta!.id });
  expect(moved.status()).toBe(200);
  expect(NodeDto.parse(await moved.json()).parentId).toBe(made.beta!.id);
  const cycle = await send("POST", `/api/nodes/${made.beta!.id}/move`, { parentId: made.child!.id });
  expect(cycle.status()).toBe(409);
  expect(await cycle.json()).toMatchObject({ error: "conflict" });

  // Star.
  const starred = await send("PATCH", `/api/nodes/${made.child!.id}`, { starred: true });
  expect(starred.status()).toBe(200);
  expect(NodeDto.parse(await starred.json()).starred).toBe(true);

  // List with each sort, both ways; then page through the top level one row at a time.
  for (const sort of ["name", "size", "updated", "kind"]) {
    for (const dir of ["asc", "desc"]) {
      const response = await request.get(`/api/nodes/root?sort=${sort}&dir=${dir}`);
      expect(response.status(), `${sort} ${dir}`).toBe(200);
      const page = NodePage.parse(await response.json());
      expect(page.items.map((item) => item.id).sort(), `${sort} ${dir}`).toEqual(
        [made.alpha!.id, made.beta!.id].sort(),
      );
      expect(page.nextCursor).toBeNull();
    }
  }
  const byName = NodePage.parse(await (await request.get("/api/nodes/root?sort=name&limit=1")).json());
  expect(byName.items.map((item) => item.name)).toEqual(["Alpha"]);
  expect(byName.nextCursor).not.toBeNull();
  const next = await request.get(
    `/api/nodes/root?sort=name&limit=1&cursor=${encodeURIComponent(byName.nextCursor!)}`,
  );
  const rest = NodePage.parse(await next.json());
  expect(rest.items.map((item) => item.name)).toEqual(["beta"]);
  expect(rest.nextCursor).toBeNull();
  const wrongSort = await request.get(
    `/api/nodes/root?sort=size&limit=1&cursor=${encodeURIComponent(byName.nextCursor!)}`,
  );
  expect(wrongSort.status()).toBe(400);

  const inBeta = NodePage.parse(await (await request.get(`/api/nodes/${made.beta!.id}/children`)).json());
  expect(inBeta.items.map((item) => [item.id, item.name, item.starred])).toEqual([
    [made.child!.id, "Drafts 2026", true],
  ]);
  const inAlpha = NodePage.parse(await (await request.get(`/api/nodes/${made.alpha!.id}/children`)).json());
  expect(inAlpha.items).toEqual([]);

  // Details and breadcrumbs.
  const detail = await request.get(`/api/nodes/${made.child!.id}`);
  expect(detail.status()).toBe(200);
  const body = NodeDetailDto.parse(await detail.json());
  expect(body.node).toMatchObject({ id: made.child!.id, role: "owner", starred: true });
  expect(body.breadcrumbs).toEqual([{ id: made.beta!.id, name: "beta" }]);

  // The usage summary answers for the same session.
  const usage = await request.get("/api/account/usage");
  expect(usage.status()).toBe(200);
  expect(await usage.json()).toMatchObject({ usedBytes: 0, filesBytes: 0, trashBytes: 0 });

  // An id nobody was issued, and one that is not an id.
  expect((await request.get("/api/nodes/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e")).status()).toBe(404);
  expect((await request.get("/api/nodes/not-an-id")).status()).toBe(404);
});

test("a cross-site POST is refused, with the session cookie and all — and nothing is created", async ({
  request,
  origins,
  clientIp,
}) => {
  await signedInUser(request, { clientIp });
  const name = "Made from elsewhere";
  for (const headers of [
    { origin: "https://evil.example" },
    { origin: origins.files },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    {},
  ] as Record<string, string>[]) {
    const response = await request.post("/api/nodes/folder", {
      headers: { ...headers, "content-type": "application/json" },
      data: { parentId: null, name },
    });
    expect(response.status(), JSON.stringify(headers)).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden", details: { reason: "csrf" } });
  }
  const top = NodePage.parse(await (await request.get("/api/nodes/root")).json());
  expect(top.items).toEqual([]);

  // The control: the same request from the app's own origin goes through.
  const own = await request.post("/api/nodes/folder", {
    headers: { origin: origins.app, "content-type": "application/json" },
    data: { parentId: null, name },
  });
  expect(own.status()).toBe(200);
});
