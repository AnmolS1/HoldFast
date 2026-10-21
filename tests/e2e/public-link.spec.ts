// Sharing end to end. Every password here is made up.
//
// THROUGH THE REAL DEV SERVER (rows seeded into this checkout's database, a real session, nothing
// mocked under /api): a viewer share — the grantee browses and downloads and may not rename; a
// password + 2-download link opened in the browser — the third download shows the limit message;
// revoke → "no longer available"; Copy link from Shared by me opens the same link.
// MOCKED (the SPA against the contract): a folder link's "Download all as zip".
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { appOrigin, e2ePort } from "../setup/local-env";
import { expect, expectNoA11yViolations, mockShell, test } from "./fixtures";
import { navigateInApp } from "./fixtures/navigate";

const PASSWORD = "made-up e2e link password";

/** A clean file (and a folder around it) of `ownerId`, as rows only: no object is stored. */
async function seedFile(ownerId: string): Promise<{ folder: string; file: string; name: string }> {
  const ids = { folder: randomUUID(), file: randomUUID() };
  const tag = randomUUID().slice(0, 8);
  const name = `e2e-shared-${tag}.txt`;
  const insert = `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status, mime_sniffed, version_id, r2_key)
                  VALUES ($1, $2, $2, $3, $4, $5, $5, $6, $7, 'clean', $8, $9, $10)`;
  await localDb(async (db) => {
    await db.query(insert, [
      ids.folder,
      ownerId,
      null,
      "folder",
      `e2e-folder-${tag}`,
      "",
      0,
      null,
      null,
      null,
    ]);
    const version = randomUUID();
    await db.query(insert, [
      ids.file,
      ownerId,
      ids.folder,
      "file",
      name,
      "txt",
      12,
      "text/plain",
      version,
      `u/${ownerId}/${ids.file}/${version}`,
    ]);
  });
  return { ...ids, name };
}

function writes(request: APIRequestContext, clientIp: string) {
  const headers = { origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp };
  return {
    get: (path: string) => request.get(`/api${path}`, { headers }),
    post: (path: string, data: unknown) => request.post(`/api${path}`, { headers, data }),
    patch: (path: string, data: unknown) => request.patch(`/api${path}`, { headers, data }),
    remove: (path: string) => request.delete(`/api${path}`, { headers }),
  };
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

test.describe("sharing, through the real API", () => {
  test("a viewer share: the grantee browses and downloads, and may not rename", async ({
    playwright,
    request,
    clientIp,
  }) => {
    const owner = await signedInUser(request, { clientIp });
    const seeded = await seedFile(owner.id);
    const granteeContext = await playwright.request.newContext({ baseURL: appOrigin(e2ePort()) });
    try {
      const grantee = await signedInUser(granteeContext, { clientIp });
      const asOwner = writes(request, clientIp);
      const asGrantee = writes(granteeContext, clientIp);
      const shared = await asOwner.post(`/nodes/${seeded.folder}/shares`, {
        email: grantee.email,
        role: "viewer",
      });
      expect(shared.status()).toBe(201);
      const listed = await asGrantee.get("/shared-with-me");
      expect((await listed.json()).map((item: { node: { id: string } }) => item.node.id)).toContain(
        seeded.folder,
      );
      const children = await asGrantee.get(`/nodes/${seeded.folder}/children`);
      expect((await children.json()).items.map((item: { id: string }) => item.id)).toEqual([seeded.file]);
      expect(
        (await asGrantee.post(`/nodes/${seeded.file}/download-url`, { kind: "download" })).status(),
      ).toBe(200);
      const rename = await asGrantee.patch(`/nodes/${seeded.file}`, { name: "renamed.txt" });
      expect(rename.status()).toBe(403);
    } finally {
      await granteeContext.dispose();
    }
  });

  test("a password + 2-download link in the browser: two downloads, then the limit message", async ({
    page,
    request,
    clientIp,
  }) => {
    const owner = await signedInUser(request, { clientIp });
    const seeded = await seedFile(owner.id);
    const made = await writes(request, clientIp).post(`/nodes/${seeded.file}/links`, {
      allowPreview: true,
      password: PASSWORD,
      maxDownloads: 2,
    });
    expect(made.status()).toBe(201);
    const { url } = (await made.json()) as { url: string };
    // A download opens the files host in a tab of its own: close each as it opens.
    page.context().on("page", (opened) => void opened.close().catch(() => {}));
    await page.goto(`/s/${tokenOf(url)}`);
    await expect(page.getByRole("heading", { name: "This link is protected" })).toBeVisible();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("heading", { name: seeded.name })).toBeVisible();
    const download = page.locator("[data-public-download]");
    for (let i = 0; i < 2; i++) {
      const minted = page.waitForResponse((response) => response.url().endsWith("/download-url"));
      await download.click();
      expect((await minted).status()).toBe(200);
      await expect(download).toBeEnabled();
    }
    await download.click();
    await expect(page.getByText("This link has reached its download limit.")).toBeVisible();
  });

  test("revoke: the open link says it is no longer available", async ({ page, request, clientIp }) => {
    const owner = await signedInUser(request, { clientIp });
    const seeded = await seedFile(owner.id);
    const api = writes(request, clientIp);
    const made = (await (await api.post(`/nodes/${seeded.folder}/links`, { allowPreview: true })).json()) as {
      id: string;
      url: string;
    };
    await page.goto(`/s/${tokenOf(made.url)}`);
    await expect(page.getByRole("list", { name: /^Files in / })).toBeVisible();
    expect((await api.remove(`/links/${made.id}`)).status()).toBe(204);
    await page.reload();
    await expect(page.getByRole("heading", { name: "This link is no longer available." })).toBeVisible();
  });

  test("Copy link in Shared by me copies the link that opens the same item", async ({ page, clientIp }) => {
    const owner = await signedInUser(page, { clientIp });
    const seeded = await seedFile(owner.id);
    const made = await writes(page.request, clientIp).post(`/nodes/${seeded.file}/links`, {
      allowPreview: false,
    });
    expect(made.status()).toBe(201);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await navigateInApp(page, "/shared-by-me?tab=links");
    const row = page.locator("[data-by-me-link]", { hasText: seeded.name });
    await row.getByRole("button", { name: "Copy link" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe((await made.json()).url);
    await page.goto(new URL(copied).pathname);
    await expect(page.getByRole("heading", { name: seeded.name })).toBeVisible();
  });
});

test.describe("a folder link's zip (mocked API)", () => {
  async function mockFolderLink(page: Page, port: number) {
    const token = "AbCdEfGhIjKlMnOpQrStUv";
    const files = ["a.txt", "b.txt"].map((name, index) => ({
      id: `0199d3c2-7a10-7000-8000-0000000000a${index + 1}`,
      name,
      kind: "file",
      size: 3,
      mimeCategory: "document",
      ext: "txt",
      mimeSniffed: "text/plain",
      thumb: false,
    }));
    const folder = {
      ...files[0]!,
      id: "0199d3c2-7a10-7000-8000-0000000000d1",
      name: "Holiday",
      kind: "folder",
      ext: "",
    };
    const base = `/api/public/links/${token}`;
    await mockShell(page, port, {
      user: null,
      api: async (route, path) => {
        const json = (body: unknown) => route.fulfill({ json: body }).then(() => true);
        if (path === base)
          return json({ requiresPassword: false, node: folder, allowPreview: true, dangerous: false });
        if (path === `${base}/children`) return json({ items: files, nextCursor: null });
        if (path === `${base}/zip-manifest`) {
          return json({
            entries: files.map((file) => ({
              nodeId: file.id,
              path: `Holiday/${file.name}`,
              size: 3,
              etag: "e",
              modifiedAt: "2099-01-01T00:00:00.000Z",
            })),
            totalBytes: 6,
            skipped: [],
            truncated: false,
            zipGrant: "made-up-grant",
          });
        }
        if (path === `${base}/download-urls`) {
          const body = route.request().postDataJSON() as { nodeIds: string[]; zipGrant: string };
          expect(body.zipGrant).toBe("made-up-grant");
          return json({
            items: body.nodeIds.map((nodeId) => ({
              nodeId,
              url: `http://files.localhost:${port}/d/${nodeId}/made-up-token`,
              expiresAt: "2099-01-01T00:00:00.000Z",
            })),
          });
        }
        return false;
      },
    });
    await page.route(`http://files.localhost:${port}/d/**`, (route) =>
      route.fulfill({ body: "abc", headers: { "access-control-allow-origin": "*" } }),
    );
    return token;
  }

  test("Download all as zip: one archive, the window minted in one batch under the grant", async ({
    page,
    origins,
  }) => {
    const token = await mockFolderLink(page, origins.port);
    await page.goto(`/s/${token}`);
    await expect(page.getByRole("list", { name: "Files in Holiday" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download all as zip" }).click();
    expect((await download).suggestedFilename()).toBe("Holiday.zip");
    await expect(page.getByText("Zip saved.")).toBeVisible();
  });
});

test.describe("accessibility of the sharing pages (mocked API)", () => {
  const AT = "2099-01-01T00:00:00.000Z";
  const node = {
    id: "0199d3c2-7a10-7000-8000-0000000000f1",
    name: "report.txt",
    kind: "file",
    size: 1234,
    mimeCategory: "document",
    ext: "txt",
    mimeSniffed: "text/plain",
    thumb: false,
  };
  const linkDto = {
    id: "0199d3c2-7a10-7000-8000-00000000011a",
    nodeId: node.id,
    node: { name: node.name, kind: "file" },
    url: "http://localhost/s/AbCdEfGhIjKlMnOpQrStUv",
    state: "paused",
    pausedReasons: ["owner"],
    canUnpause: true,
    expiresAt: null,
    hasPassword: true,
    maxDownloads: 5,
    downloadCount: 2,
    bytesServed: 10,
    allowPreview: true,
    createdAt: AT,
    lastAccessAt: AT,
    limitedToday: true,
  };

  test("the public file card and the password form have no axe violations", async ({ page, origins }) => {
    let locked = true;
    await mockShell(page, origins.port, {
      user: null,
      api: async (route, path) => {
        if (path !== "/api/public/links/AbCdEfGhIjKlMnOpQrStUv") return false;
        await route.fulfill({
          json: { requiresPassword: true, node: locked ? null : node, allowPreview: true, dangerous: false },
        });
        return true;
      },
    });
    await page.goto("/s/AbCdEfGhIjKlMnOpQrStUv");
    await expect(page.getByRole("heading", { name: "This link is protected" })).toBeVisible();
    await expectNoA11yViolations(page);
    locked = false;
    await page.reload();
    await expect(page.getByRole("heading", { name: "report.txt" })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("Shared by me (links) has no axe violations", async ({ page, origins }) => {
    await mockShell(page, origins.port, {
      api: async (route, path) => {
        if (path === "/api/links/mine") return route.fulfill({ json: [linkDto] }).then(() => true);
        if (path.startsWith("/api/links/")) {
          return route.fulfill({ json: { days: [], countries: [], outcomes: {} } }).then(() => true);
        }
        return false;
      },
    });
    await page.goto("/shared-by-me?tab=links");
    await expect(page.getByText("Limit reached today — comes back on its own")).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
