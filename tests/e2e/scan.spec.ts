// The scan pipeline over real HTTP against `vite dev` (SCAN_STUB=1, T21): upload → the explicit
// scan message → this Worker's real consumer (claim, sniff, server hash, hash check, blocklist,
// verdict, effects) with the stub scanner — then what the verdict means for a download.
// API-level, in the style of uploads-api.spec.ts: nothing is mocked; the parent folder is seeded
// in the database and the node's status is POLLED there (local queue delivery is asynchronous).
//
// Both files declare their bytes' REAL SHA-256 (a made-up one is `error`/`hash_mismatch` now).
// The infected file is EICAR followed by bytes of its own: an infected verdict lists its hash,
// and an upload that DECLARES a listed hash is refused at complete — the bare EICAR file would
// pass only once per database.
//
// The UI badge ("Blocked — flagged by the malware scan") and sharing being refused are
// post-integration checks (T24 is a sibling; the SPA half runs REAL on the integrated tree).
import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { eicarBytes } from "../setup/fixture-bytes";
import { expect, test } from "./fixtures";

type Api = { request: APIRequestContext; headers: Record<string, string> };

async function seedFolder(ownerId: string): Promise<string> {
  const name = `e2e-scan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const inserted = await localDb((db) =>
    db.query<{ id: string }>(
      `INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, ext, scan_status)
       VALUES (gen_random_uuid(), $1, $1, 'folder', $2, $2, '', 'clean') RETURNING id`,
      [ownerId, name],
    ),
  );
  return inserted.rows[0]!.id;
}

const nodeRow = async (nodeId: string) =>
  (
    await localDb((db) =>
      db.query<{ scan_status: string; scan_reason: string | null; sha256: string | null }>(
        "SELECT scan_status, scan_reason, sha256 FROM nodes WHERE id = $1",
        [nodeId],
      ),
    )
  ).rows[0] ?? null;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function upload(api: Api, parentId: string, name: string, bytes: Uint8Array): Promise<string> {
  const init = await api.request.post("/api/uploads", {
    headers: api.headers,
    data: {
      parentId,
      name,
      size: bytes.byteLength,
      mimeDeclared: "application/octet-stream",
      fileLastModified: "2026-10-01T12:00:00.000Z",
      onConflict: "fail",
      purpose: "file",
    },
  });
  expect(init.status(), await init.text()).toBe(201);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const put = await api.request.put(`/api/uploads/${uploadId}/single`, {
    headers: { ...api.headers, "content-type": "application/octet-stream" },
    data: Buffer.from(bytes),
  });
  expect(put.status(), await put.text()).toBe(200);
  const done = await api.request.post(`/api/uploads/${uploadId}/complete`, {
    headers: api.headers,
    data: { sha256: sha256(bytes), parts: [] },
  });
  expect(done.status(), await done.text()).toBe(201);
  return ((await done.json()) as { id: string }).id;
}

test.describe("scan pipeline (stub scanner)", () => {
  test("EICAR → infected and its download is refused; a clean file → clean and downloadable", async ({
    request,
    clientIp,
    origins,
  }) => {
    const user = await signedInUser(request, { clientIp });
    const api: Api = { request, headers: { origin: origins.app, "cf-connecting-ip": clientIp } };
    const folderId = await seedFolder(user.id);

    const clean = new TextEncoder().encode(
      `A harmless file for the scan e2e spec ${randomBytes(8).toString("hex")}\n`,
    );
    const infected = Buffer.concat([
      Buffer.from(eicarBytes()),
      Buffer.from(`\n${randomBytes(16).toString("hex")}\n`),
    ]);
    const cleanId = await upload(api, folderId, "hello.txt", clean);
    const infectedId = await upload(api, folderId, "eicar.com.txt", infected);

    await expect.poll(async () => (await nodeRow(cleanId))?.scan_status, { timeout: 30_000 }).toBe("clean");
    await expect
      .poll(async () => (await nodeRow(infectedId))?.scan_status, { timeout: 30_000 })
      .toBe("infected");
    // The server's hash, after the verdict.
    expect((await nodeRow(cleanId))?.sha256).toBe(sha256(clean));
    expect((await nodeRow(infectedId))?.sha256).toBe(sha256(infected));

    const refused = await request.post(`/api/nodes/${infectedId}/download-url`, {
      headers: { ...api.headers, "content-type": "application/json" },
      data: { kind: "download" },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "scan_blocked" });

    const minted = await request.post(`/api/nodes/${cleanId}/download-url`, {
      headers: { ...api.headers, "content-type": "application/json" },
      data: { kind: "download" },
    });
    expect(minted.status(), await minted.text()).toBe(200);
    const { url } = (await minted.json()) as { url: string };
    expect(url.startsWith(`${origins.files}/`)).toBe(true);
    const got = await request.get(url);
    expect(got.status()).toBe(200);
    expect(Buffer.from(await got.body()).equals(Buffer.from(clean))).toBe(true);
  });
});
