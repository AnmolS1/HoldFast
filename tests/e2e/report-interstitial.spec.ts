// Abuse controls end to end (T22), THROUGH THE REAL DEV SERVER: rows seeded into this checkout's
// database, a real session for the owner, nothing mocked under /api. The Turnstile widget is the
// harness's stand-in (it hands over the published dummy token the server's test secret accepts).
//   - a visitor reports from the public page → the plain confirmation → the link now says it is
//     temporarily unavailable, and the owner sees "Under review" — with no category;
//   - a dangerous file → the interstitial → the acknowledged download works, and a direct
//     download-url call without `dangerousAck` is refused.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { appOrigin, e2ePort } from "../setup/local-env";
import { expect, stubTurnstile, test } from "./fixtures";

/** A clean file of `ownerId` (at their top level, or in `parentId`), as rows only (no object is stored). */
async function seedFile(
  ownerId: string,
  name: string,
  mime: string,
  parentId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const version = randomUUID();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  await localDb(async (db) => {
    await db.query(
      `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status, mime_sniffed, version_id, r2_key)
       VALUES ($1, $2, $2, $8, 'file', $3, $3, $4, 12, 'clean', $5, $6, $7)`,
      [id, ownerId, name, ext, mime, version, `u/${ownerId}/${id}/${version}`, parentId],
    );
  });
  return id;
}

/** A clean folder of `ownerId` at their top level, as a row. */
async function seedFolder(ownerId: string, name: string): Promise<string> {
  const id = randomUUID();
  await localDb(async (db) => {
    await db.query(
      `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
       VALUES ($1, $2, $2, NULL, 'folder', $3, $3, '', 0, 'clean')`,
      [id, ownerId, name],
    );
  });
  return id;
}

async function linkTo(page: Page, clientIp: string, nodeId: string): Promise<string> {
  const made = await page.request.post(`/api/nodes/${nodeId}/links`, {
    headers: { origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp },
    data: { allowPreview: true },
  });
  expect(made.status()).toBe(201);
  const { url } = (await made.json()) as { url: string };
  return url.slice(url.lastIndexOf("/") + 1);
}

test("a visitor's report hides the file: the confirmation, the link 'temporarily unavailable', and the owner sees 'Under review' with no category", async ({
  page,
  clientIp,
}) => {
  const owner = await signedInUser(page, { clientIp });
  const name = `e2e-report-${randomUUID().slice(0, 8)}.txt`;
  const fileId = await seedFile(owner.id, name, "text/plain");
  const token = await linkTo(page, clientIp, fileId);
  await stubTurnstile(page);

  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.locator("[data-report-link]").click();
  const dialog = page.getByRole("dialog", { name: "Report this file" });
  await dialog.getByLabel("Phishing or a scam").check();
  await dialog.getByLabel("Details (optional)").fill("It asks for a bank login.");
  await expect(dialog.locator("[data-turnstile='ready']")).toBeAttached();
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/public/report"));
  await dialog.getByRole("button", { name: "Send report" }).click();
  expect((await sent).status()).toBe(202);
  await expect(dialog.getByText("Thanks. The file is hidden while we review it.")).toBeVisible();

  // The link itself is paused for the report.
  await page.reload();
  await expect(page.getByRole("heading", { name: "This link is temporarily unavailable." })).toBeVisible();

  // The owner, in the app: "Under review" on the file — no category, no reporter, no count.
  await page.goto("/");
  const row = page.locator("[data-item-id]", { hasText: name });
  await expect(row.getByText("Under review", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/phishing|bank login|reporter/i);
});

test("a dangerous file: the interstitial first, the acknowledged download works — and a direct mint without dangerousAck is refused", async ({
  page,
  clientIp,
}) => {
  const owner = await signedInUser(page, { clientIp });
  const name = `e2e-setup-${randomUUID().slice(0, 8)}.exe`;
  const fileId = await seedFile(owner.id, name, "application/x-msdownload");
  const token = await linkTo(page, clientIp, fileId);
  // A download opens the files host in a tab of its own: close each as it opens.
  page.context().on("page", (opened) => void opened.close().catch(() => {}));

  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  let minted = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/download-url")) minted += 1;
  });
  await page.locator("[data-public-download]").click();
  const warning = page.getByRole("dialog", { name: `Download ${name}?` });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Programs like this one can install software");
  // Nothing is minted until the visitor chooses.
  expect(minted).toBe(0);
  const answer = page.waitForResponse((response) => response.url().endsWith("/download-url"));
  await warning.getByRole("button", { name: "Download anyway" }).click();
  const response = await answer;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    nodeId: fileId,
    kind: "download",
    dangerousAck: true,
  });

  // Straight to the API, without the acknowledgement: refused.
  const direct = await page.request.post(`/api/public/links/${token}/download-url`, {
    headers: { origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp },
    data: { nodeId: fileId, kind: "download" },
  });
  expect(direct.status()).toBe(403);
  expect(((await direct.json()) as { details?: { reason?: string } }).details?.reason).toBe("dangerous_ack");
});

test("a folder link: a stranger reports a FILE inside it from its preview — the folder itself offers no Report", async ({
  page,
  clientIp,
}) => {
  const owner = await signedInUser(page, { clientIp });
  const tag = randomUUID().slice(0, 8);
  const folderId = await seedFolder(owner.id, `e2e-folder-${tag}`);
  const name = `e2e-inside-${tag}.txt`;
  const fileId = await seedFile(owner.id, name, "text/plain", folderId);
  const token = await linkTo(page, clientIp, folderId);
  await stubTurnstile(page);

  await page.goto(`/s/${token}`);
  await expect(page.getByRole("button", { name: `Preview ${name}` })).toBeVisible();
  await expect(page.locator("footer [data-report-link]")).toHaveCount(0);
  await page.getByRole("button", { name: `Preview ${name}` }).click();
  await page.locator("[data-report-link]").click();
  const dialog = page.getByRole("dialog", { name: "Report this file" });
  await dialog.getByLabel("Spam").check();
  await expect(dialog.locator("[data-turnstile='ready']")).toBeAttached();
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/public/report"));
  await dialog.getByRole("button", { name: "Send report" }).click();
  const answer = await sent;
  expect(answer.status()).toBe(202);
  expect(answer.request().postDataJSON()).toMatchObject({ nodeId: fileId, linkToken: token });
  await expect(dialog.getByText("Thanks. The file is hidden while we review it.")).toBeVisible();
});
