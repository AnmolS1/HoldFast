// The uploads API over real HTTP against `vite dev` (SCAN_STUB=1): init → the bytes → complete,
// and the scan message that complete sends reaching this same Worker's queue() handler — the
// stub consumer that makes files downloadable in this wave. Nothing is mocked.
//
// Local queue delivery is asynchronous: the node's status is POLLED (bounded), never asserted
// right after complete. The parent folder is seeded straight into the database, and the node is
// read from there — the nodes API is another task's.
import { createHash, randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { eicarBytes } from "../setup/fixture-bytes";
import { expect, test } from "./fixtures";

const PART_BYTES = 67_108_864;

type Api = { request: APIRequestContext; headers: Record<string, string> };

async function seedFolder(ownerId: string): Promise<string> {
  const name = `e2e-uploads-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const inserted = await localDb((db) =>
    db.query<{ id: string }>(
      `INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, ext, scan_status)
       VALUES (gen_random_uuid(), $1, $1, 'folder', $2, $2, '', 'clean') RETURNING id`,
      [ownerId, name],
    ),
  );
  return inserted.rows[0]!.id;
}

const scanStatusOf = async (nodeId: string) =>
  (
    await localDb((db) =>
      db.query<{ scan_status: string }>("SELECT scan_status FROM nodes WHERE id = $1", [nodeId]),
    )
  ).rows[0]?.scan_status ?? null;

async function init(api: Api, parentId: string, name: string, size: number) {
  const response = await api.request.post("/api/uploads", {
    headers: api.headers,
    data: {
      parentId,
      name,
      size,
      mimeDeclared: "application/octet-stream",
      fileLastModified: "2026-10-01T12:00:00.000Z",
      onConflict: "fail",
      purpose: "file",
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { uploadId: string; mode: string; partBytes: number; partCount: number };
}

async function complete(
  api: Api,
  uploadId: string,
  parts: { n: number; etag: string }[] = [],
  sha256 = "0".repeat(64),
) {
  // The hash is the client's word: the scanner computes its own and compares (T21 f.4) — a
  // made-up declaration for clean bytes ends `error`/`hash_mismatch`.
  const response = await api.request.post(`/api/uploads/${uploadId}/complete`, {
    headers: api.headers,
    data: { sha256, parts },
  });
  return response;
}

async function uploadSmall(api: Api, parentId: string, name: string, bytes: Uint8Array, declared?: string) {
  const session = await init(api, parentId, name, bytes.byteLength);
  expect(session.mode).toBe("single");
  const put = await api.request.put(`/api/uploads/${session.uploadId}/single`, {
    headers: { ...api.headers, "content-type": "application/octet-stream" },
    data: Buffer.from(bytes),
  });
  expect(put.status()).toBe(200);
  expect(await put.json()).toEqual({ etag: expect.any(String) });
  const done = await complete(api, session.uploadId, [], declared);
  expect(done.status()).toBe(201);
  return (await done.json()) as { id: string; scanStatus: string; name: string; size: number };
}

test.describe("uploads API", () => {
  test("init → single PUT → complete → the stub consumer turns the node clean; the EICAR file infected", async ({
    request,
    clientIp,
    origins,
  }) => {
    const user = await signedInUser(request, { clientIp });
    const api: Api = { request, headers: { origin: origins.app, "cf-connecting-ip": clientIp } };
    const folderId = await seedFolder(user.id);

    const text = new TextEncoder().encode("Hello from the uploads e2e spec.\n");
    // T21 (f.4): the clean file declares its REAL hash. The EICAR file keeps the made-up one (its
    // real hash is listed after any earlier infected verdict, and a listed declaration is refused).
    const clean = await uploadSmall(
      api,
      folderId,
      "hello.txt",
      text,
      createHash("sha256").update(text).digest("hex"),
    );
    expect(clean).toMatchObject({ name: "hello.txt", size: text.byteLength, scanStatus: "pending" });
    await expect.poll(() => scanStatusOf(clean.id), { timeout: 30_000 }).toBe("clean");

    // Per-run content (Common addendum 3): an infected verdict lists the hash for every spec.
    const infectedBytes = Buffer.concat([Buffer.from(eicarBytes()), Buffer.from(`\n${randomUUID()}\n`)]);
    const infected = await uploadSmall(api, folderId, "eicar.com", infectedBytes);
    await expect.poll(() => scanStatusOf(infected.id), { timeout: 30_000 }).toBe("infected");

    // The same name again fails, and says which file holds it.
    const again = await request.post("/api/uploads", {
      headers: api.headers,
      data: {
        parentId: folderId,
        name: "hello.txt",
        size: 1,
        mimeDeclared: "text/plain",
        fileLastModified: "2026-10-01T12:00:00.000Z",
        onConflict: "fail",
        purpose: "file",
      },
    });
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({ error: "conflict", details: { existingId: clean.id } });
    // The caller's open sessions: none is left.
    const open = await request.get("/api/uploads/open");
    expect(open.status()).toBe(200);
    expect(await open.json()).toEqual([]);
  });

  test("a multipart upload over real HTTP: two parts streamed from the request body, one node", async ({
    request,
    clientIp,
    origins,
  }, testInfo) => {
    // ≈ 64 MiB stays in this checkout's local object store per run: once is enough.
    test.skip(testInfo.project.name !== "chromium", "one project is enough for an API-only case");
    test.slow();
    const user = await signedInUser(request, { clientIp });
    const api: Api = { request, headers: { origin: origins.app, "cf-connecting-ip": clientIp } };
    const folderId = await seedFolder(user.id);
    const size = PART_BYTES + 1;
    const session = await init(api, folderId, "two-parts.bin", size);
    expect(session).toMatchObject({ mode: "multipart", partBytes: PART_BYTES, partCount: 2 });

    const parts: { n: number; etag: string }[] = [];
    for (const [n, length] of [
      [1, PART_BYTES],
      [2, 1],
    ] as const) {
      const response = await request.put(`/api/uploads/${session.uploadId}/parts/${n}`, {
        headers: { ...api.headers, "content-type": "application/octet-stream" },
        data: Buffer.alloc(length),
        timeout: 120_000,
      });
      expect(response.status()).toBe(200);
      parts.push((await response.json()) as { n: number; etag: string });
    }
    // A part of the wrong size is refused before its body is read.
    const wrong = await request.put(`/api/uploads/${session.uploadId}/parts/1`, {
      headers: { ...api.headers, "content-type": "application/octet-stream" },
      data: Buffer.alloc(1024),
    });
    expect(wrong.status()).toBe(400);

    // T21 (f.4, Addendum 3 Q3): the REAL hash of the bytes sent (PART_BYTES + 1 zero bytes).
    const done = await complete(
      api,
      session.uploadId,
      parts,
      createHash("sha256").update(Buffer.alloc(size)).digest("hex"),
    );
    expect(done.status()).toBe(201);
    const node = (await done.json()) as { id: string; size: number };
    expect(node.size).toBe(size);
    await expect.poll(() => scanStatusOf(node.id), { timeout: 60_000 }).toBe("clean");
  });

  test("another signed-in user cannot drive someone's session", async ({
    request,
    playwright,
    clientIp,
    origins,
  }) => {
    const owner = await signedInUser(request, { clientIp });
    const api: Api = { request, headers: { origin: origins.app, "cf-connecting-ip": clientIp } };
    const session = await init(api, await seedFolder(owner.id), "mine.bin", 10);

    const other = await playwright.request.newContext({ baseURL: origins.app });
    try {
      await signedInUser(other, { clientIp });
      const theirs: Api = { request: other, headers: api.headers };
      const put = await other.put(`/api/uploads/${session.uploadId}/single`, {
        headers: theirs.headers,
        data: Buffer.alloc(10),
      });
      expect(put.status()).toBe(404);
      expect((await complete(theirs, session.uploadId)).status()).toBe(404);
      const aborted = await other.delete(`/api/uploads/${session.uploadId}`, { headers: theirs.headers });
      expect(aborted.status()).toBe(404);
    } finally {
      await other.dispose();
    }
    // The uploader's own abort works.
    const mine = await request.delete(`/api/uploads/${session.uploadId}`, { headers: api.headers });
    expect(mine.status()).toBe(204);
  });
});
