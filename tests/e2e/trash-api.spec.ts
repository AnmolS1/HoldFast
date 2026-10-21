// The trash API through the real dev server: a real session, rows seeded straight into this
// checkout's database, nothing mocked. No browser page is needed — the request context holds
// the session.
//
//   trash → listed in /trash → restore → gone from /trash;  trash → DELETE → gone;
//   DELETE of a live node → 409.
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import {
  EmptyTrashResponse,
  RestoreNodeResponse,
  TrashNodeResponse,
  TrashResponse,
} from "../../src/shared/schemas/node";
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { appOrigin, e2ePort } from "../setup/local-env";
import { expect, test } from "./fixtures";

type Seeded = { folder: string; inner: string; loose: string };

/** owner:  folder/ → inner.txt   and   loose.txt   — rows only: no object is stored. */
async function seedTree(ownerId: string): Promise<Seeded> {
  const ids = { folder: randomUUID(), inner: randomUUID(), loose: randomUUID() };
  const tag = randomUUID().slice(0, 8);
  const insert = `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
                  VALUES ($1, $2, $2, $3, $4, $5, $5, $6, $7, 'clean')`;
  await localDb(async (db) => {
    await db.query(insert, [ids.folder, ownerId, null, "folder", `e2e-folder-${tag}`, "", 0]);
    await db.query(insert, [ids.inner, ownerId, ids.folder, "file", `e2e-inner-${tag}.txt`, "txt", 12]);
    await db.query(insert, [ids.loose, ownerId, null, "file", `e2e-loose-${tag}.txt`, "txt", 7]);
  });
  return ids;
}

const rowsLeft = async (ids: string[]) =>
  (
    await localDb((db) => db.query<{ id: string }>("SELECT id FROM nodes WHERE id = ANY($1::uuid[])", [ids]))
  ).rows
    .map((row) => row.id)
    .sort();

// The rollback detector: this environment resets its database on every run while the dev
// server's bucket persists in `.wrangler/state`, and an earlier run's hourly slot (harness.spec.ts)
// leaves the detector's object behind — a database restore, by definition, and "delete forever"
// would take the held path. The e2e global setup deletes that object with the reset
// (tests/setup/e2e-global-setup.ts), so the two agree; the delete below is the proof.

test.describe("the trash API", () => {
  test("trash, list, restore, delete for good — and a live node is not deleted", async ({
    request,
    clientIp,
  }) => {
    const user = await signedInUser(request, { clientIp });
    const tree = await seedTree(user.id);
    // What a browser on the app sends with a write: our own routes refuse one without it.
    const headers = { origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp };
    const post = (path: string) => request.post(`/api${path}`, { headers });
    const remove = (path: string) => request.delete(`/api${path}`, { headers });
    const listed = async (api: APIRequestContext = request) => {
      const response = await api.get("/api/trash", { headers });
      expect(response.status()).toBe(200);
      return TrashResponse.parse(await response.json()).items.map((item) => item.id);
    };

    expect(await listed()).toEqual([]);

    // Trash the folder: it is listed, with both dates; what is inside is not a row of the list.
    const trashed = await post(`/nodes/${tree.folder}/trash`);
    expect(trashed.status()).toBe(200);
    const item = TrashNodeResponse.parse(await trashed.json());
    expect(item).toMatchObject({ id: tree.folder, kind: "folder", role: "owner", parentId: null });
    expect(Date.parse(item.purgeAfter)).toBeGreaterThan(Date.parse(item.deletedAt));
    expect(await listed()).toEqual([tree.folder]);

    // Restore it: where it was, and out of the trash.
    const restored = await post(`/nodes/${tree.folder}/restore`);
    expect(restored.status()).toBe(200);
    expect(RestoreNodeResponse.parse(await restored.json())).toMatchObject({
      id: tree.folder,
      deletedAt: null,
      purgeAfter: null,
    });
    expect(await listed()).toEqual([]);

    // A live node is not deleted for good.
    const live = await remove(`/nodes/${tree.folder}`);
    expect(live.status()).toBe(409);
    expect(await live.json()).toMatchObject({ error: "conflict" });
    expect(await rowsLeft([tree.folder, tree.inner])).toEqual([tree.folder, tree.inner].sort());

    // Trash again, then delete: the folder and what was inside are gone, the other file is not.
    expect((await post(`/nodes/${tree.folder}/trash`)).status()).toBe(200);
    const deleted = await remove(`/nodes/${tree.folder}`);
    expect(deleted.status()).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await listed()).toEqual([]);
    expect(await rowsLeft([tree.folder, tree.inner, tree.loose])).toEqual([tree.loose]);
    // Gone is gone: the id is unknown now.
    expect((await remove(`/nodes/${tree.folder}`)).status()).toBe(404);
    expect((await post(`/nodes/${tree.folder}/restore`)).status()).toBe(404);

    // Empty the trash.
    expect((await post(`/nodes/${tree.loose}/trash`)).status()).toBe(200);
    expect(await listed()).toEqual([tree.loose]);
    const emptied = await remove("/trash");
    // 204 when nothing is left; a 202 would carry what is.
    if (emptied.status() === 202) EmptyTrashResponse.parse(await emptied.json());
    expect(emptied.status()).toBe(204);
    expect(await rowsLeft([tree.loose])).toEqual([]);
  });

  test("needs a session, and a write needs the app's own origin", async ({
    request,
    playwright,
    clientIp,
  }) => {
    const user = await signedInUser(request, { clientIp });
    const tree = await seedTree(user.id);
    const stranger = await playwright.request.newContext({ baseURL: appOrigin(e2ePort()) });
    const headers = { origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp };
    expect((await stranger.get("/api/trash", { headers })).status()).toBe(401);
    expect((await stranger.post(`/api/nodes/${tree.loose}/trash`, { headers })).status()).toBe(401);
    await stranger.dispose();
    // The signed-in context, from another site: refused before anything is looked at.
    const crossSite = await request.post(`/api/nodes/${tree.loose}/trash`, {
      headers: {
        origin: "https://elsewhere.example",
        "sec-fetch-site": "cross-site",
        "cf-connecting-ip": clientIp,
      },
    });
    expect(crossSite.status()).toBe(403);
    expect(await rowsLeft([tree.loose])).toEqual([tree.loose]);
    const row = await localDb((db) =>
      db.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM nodes WHERE id = $1", [tree.loose]),
    );
    expect(row.rows[0]!.deleted_at).toBeNull();
  });
});
