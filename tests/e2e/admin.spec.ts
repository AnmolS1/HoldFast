// The admin console end to end (T25), against `vite dev`: the real screens, the real Worker, the
// real Better Auth handler, this checkout's local database. The admin is T06's `signedInAdmin2fa`
// (a real sign-up, TOTP enrolment and a password + code sign-in); files, links and reports are
// seeded straight into the database. No settings flip here (brief R-d: the e2e database is shared
// by every spec of the run) — `readOnly` is proven by the table-wide unit test.
//
//   npm run e2e -- tests/e2e/admin.spec.ts
//
// Desktop only: the console is the operator's desktop tool, and these are journeys through it; its
// narrow layout is not part of this task's acceptance (each mobile-chrome case is skipped, with this
// reason). At most four loads of the app per test; other pages are reached with navigateInApp.
import { randomBytes, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { localDb, signedInAdmin2fa, signedInUser } from "../setup/auth-fixtures";
import { appOrigin, e2ePort, filesOrigin } from "../setup/local-env";
import { expect, navigateInApp, test } from "./fixtures";

const COUNSEL_NOTICE =
  "Adjudication rule pending counsel (T29 §C.5 / §F). Until it is written, follow the interim operator practice in the CSAM procedure; the file itself cannot be opened from this console.";

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "the admin console is a desktop operator tool; its journeys run on desktop only");
});

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A file of `ownerId`, uploaded by them, as the upload route would leave it (no object needed). */
async function seedFile(ownerId: string, extra: { scanStatus?: string; scanStatusPrev?: string } = {}) {
  const id = randomUUID();
  const name = `e2e-${hex(4)}.txt`;
  await localDb((db) =>
    db.query(
      `INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, ext, size, version_id,
                          sha256, scan_status, scan_status_prev, mime_sniffed)
       VALUES ($1, $2, $2, 'file', $3, $3, 'txt', 10, $4, $5, $6, $7, 'text/plain')`,
      [id, ownerId, name, randomUUID(), hex(32), extra.scanStatus ?? "clean", extra.scanStatusPrev ?? null],
    ),
  );
  return { id, name };
}

/** A public link on the node, as the link route writes it: only a hash and a sealed token are stored. */
async function seedLink(nodeId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await localDb((db) =>
    db.query(
      `INSERT INTO share_links (id, node_id, created_by, token_hash, token_enc, token_iv)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, nodeId, ownerId, hex(32), randomBytes(48), randomBytes(12)],
    ),
  );
  return id;
}

async function pauseReasons(linkId: string): Promise<string[]> {
  const found = await localDb((db) =>
    db.query<{ pause_reasons: string[] }>("SELECT pause_reasons FROM share_links WHERE id = $1", [linkId]),
  );
  return found.rows[0]!.pause_reasons;
}

/** Another client address in this test's own range (its sign-up limit is not the admin's). */
const otherIp = (ip: string) => ip.replace(/\.(\d+)$/, (_m, last: string) => `.${(Number(last) + 1) % 250}`);

/** The open dialog's own button (the page has a button of the same name behind it). */
const dialogButton = (page: Page, name: string) =>
  page.locator("[data-admin-dialog]").getByRole("button", { name, exact: true });

async function confirmWithReason(page: Page, button: string, reason: string) {
  const dialog = page.locator("[data-admin-dialog]");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason (recorded in the audit log)").fill(reason);
  await dialogButton(page, button).click();
  await expect(dialog).toBeHidden();
}

test.describe("users and links", () => {
  test("search a user → suspend → their other browser is signed out and the Links screen shows owner_suspended → lift → live again", async ({
    page,
    browser,
    clientIp,
    origins,
  }) => {
    await signedInAdmin2fa(page, { clientIp });
    // The user, signed in in a browser of their own.
    const userIp = otherIp(clientIp);
    const userContext = await browser.newContext({ baseURL: origins.app });
    const userPage = await userContext.newPage();
    const user = await signedInUser(userPage, { clientIp: userIp });
    const sessionOfUser = async () => {
      const answer = await userContext.request.get("/api/auth/get-session?disableCookieCache=true", {
        headers: { "cf-connecting-ip": userIp },
      });
      expect(answer.status()).toBe(200);
      return (await answer.json()) as { user: { id: string } } | null;
    };
    expect((await sessionOfUser())?.user.id).toBe(user.id);
    const file = await seedFile(user.id);
    const linkId = await seedLink(file.id, user.id);

    await page.goto("/admin/users");
    await page.getByLabel("Email, name or id").fill(user.email);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("gridcell", { name: user.email }).click();
    await expect(page.locator(`[data-admin-user="${user.id}"]`)).toBeVisible();
    await page.getByRole("button", { name: "Suspend", exact: true }).click();
    await confirmWithReason(page, "Suspend", "Repeated abuse, made up for the e2e test.");
    await expect(page.getByRole("button", { name: "Lift suspension", exact: true })).toBeVisible();

    // Every session of the account ended: the other browser is signed out.
    expect(await sessionOfUser()).toBeNull();
    await userContext.close();

    const state = page.locator(`[data-admin-link="${linkId}"] [data-admin-link-state]`);
    await navigateInApp(page, `/admin/links?owner=${user.id}`);
    await expect(state).toHaveAttribute("data-admin-link-state", "paused");
    await expect(state).toContainText("Owner suspended");
    expect(await pauseReasons(linkId)).toEqual(["owner_suspended"]);

    await navigateInApp(page, `/admin/users/${user.id}`);
    await page.getByRole("button", { name: "Lift suspension", exact: true }).click();
    await confirmWithReason(page, "Lift suspension", "Resolved with the account holder.");
    await expect(page.getByRole("button", { name: "Suspend", exact: true })).toBeVisible();

    await navigateInApp(page, `/admin/links?owner=${user.id}`);
    await expect(state).toHaveAttribute("data-admin-link-state", "live");
    expect(await pauseReasons(linkId)).toEqual([]);
  });
});

test.describe("copyright notices", () => {
  test("a full DMCA cycle — notice, takedown, counter-notice, forward, refused before and after the window, restore inside it — with the Worker's clock moved", async ({
    page,
    browser,
    clientIp,
    origins,
  }) => {
    const admin = await signedInAdmin2fa(page, { clientIp });
    const uploaderIp = otherIp(clientIp);
    const uploaderContext = await browser.newContext({ baseURL: origins.app });
    const uploader = await signedInUser(await uploaderContext.newPage(), { clientIp: uploaderIp });
    await uploaderContext.close();
    const file = await seedFile(uploader.id);
    const linkId = await seedLink(file.id, uploader.id);

    // Intake through the form; one uploader, so one notice, and the page lands on it.
    await page.goto("/admin/dmca");
    await page.getByLabel("Complainant name").fill("A. Rights-Holder");
    await page.getByLabel("Email", { exact: true }).fill("legal@example.test");
    await page.getByLabel("The copyrighted work").fill("A photograph (made up for the test).");
    await page.getByLabel("The material and where it is").fill("The file named below.");
    await page.getByLabel("Signature", { exact: true }).fill("A. Rights-Holder");
    await page.getByLabel("File ids (comma or space separated)").fill(file.id);
    await page.getByLabel("Good-faith statement present").check();
    await page.getByLabel("Accuracy and authority statement present").check();
    await page.getByRole("button", { name: "Record notice" }).click();
    const notice = page.locator("[data-admin-notice]");
    await expect(notice).toBeVisible();
    const noticeId = (await notice.getAttribute("data-admin-notice"))!;

    // Take down: the file goes, its link is PAUSED (moderation), one strike for the uploader.
    await page.getByRole("button", { name: "Take down", exact: true }).click();
    const dialog = page.locator("[data-admin-dialog]");
    await dialog.getByLabel("Note (recorded in the audit log)").fill("A complete notice.");
    await dialogButton(page, "Take down").click();
    await expect(dialog).toBeHidden();
    await expect(notice).toContainText("Taken down");
    expect(await pauseReasons(linkId)).toEqual(["moderation"]);
    const strikesOf = () =>
      localDb((db) =>
        db.query<{ lifted_at: Date | null }>(
          "SELECT lifted_at FROM strikes WHERE user_id = $1 AND kind = 'dmca'",
          [uploader.id],
        ),
      ).then((result) => result.rows);
    expect(await strikesOf()).toHaveLength(1);

    // The counter-notice (received now), then forwarded: the window runs from the RECEIPT, 10 to the
    // end of 14 business days (weekends and US federal holidays skipped).
    await page.getByLabel("Name", { exact: true }).fill("The Uploader");
    await page.getByLabel("Address", { exact: true }).fill("2 Example Road");
    await page.getByLabel("Email", { exact: true }).fill("uploader@example.test");
    await page.getByLabel("Statement", { exact: true }).fill("Removed by mistake, in good faith.");
    await page.getByLabel("Signature", { exact: true }).fill("The Uploader");
    await page.getByLabel("Consents to jurisdiction").check();
    await page.getByRole("button", { name: "Record counter-notice" }).click();
    await expect(notice).toContainText("Counter-notice received");
    await page.getByRole("button", { name: "Forward counter-notice", exact: true }).click();
    await dialog.getByLabel("Note (recorded in the audit log)").fill("Forwarded to the complainant.");
    await dialogButton(page, "Forward counter-notice").click();
    await expect(dialog).toBeHidden();
    const row = await localDb((db) =>
      db.query<{ restore_not_before: Date; restore_not_after: Date }>(
        "SELECT restore_not_before, restore_not_after FROM dmca_notices WHERE id = $1",
        [noticeId],
      ),
    );
    const notBefore = row.rows[0]!.restore_not_before.getTime();
    const notAfter = row.rows[0]!.restore_not_after.getTime();
    expect(notAfter).toBeGreaterThan(notBefore);
    // The detail shows the receipt and the window; Forward is not offered a second time.
    await expect(notice).toContainText("Counter-notice received on");
    await expect(notice).toContainText(/From .+ to .+/);
    await expect(page.getByRole("button", { name: "Forward counter-notice", exact: true })).toHaveCount(0);
    expect(notBefore).toBeGreaterThan(Date.now() + 9 * 86_400_000);

    // THE WORKER'S CLOCK: `restoreNotBefore` is compared with `clock.now(c)`, which only the
    // X-Holdfast-Test-Now header moves (test mode only). `requireAdmin` measures the session's
    // second factor against the SAME clock (fresh = at most 12 h old, never in the future), so the
    // admin's sessions are given a second factor at the moved time for the phase it is moved to.
    const atClock = async (at: number) => {
      const stamp = new Date(at).toISOString();
      await page.unroute("**/api/**");
      await page.route("**/api/**", (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            "cf-connecting-ip": clientIp,
            "x-holdfast-test-now": stamp,
          },
        }),
      );
      await localDb((db) =>
        db.query(
          `UPDATE session SET second_factor_at = $1 WHERE user_id = $2 AND second_factor_at IS NOT NULL`,
          [new Date(at), admin.id],
        ),
      );
    };
    const restore = async () => {
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await dialog.getByLabel("Note (recorded in the audit log)").fill("Inside the window.");
      await dialogButton(page, "Restore").click();
    };

    // An hour before the window opens: refused, nothing changes.
    await atClock(notBefore - 3_600_000);
    await restore();
    await expect(dialog).toContainText("Restore is possible only from the start of the window.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const takenDown = () =>
      localDb((db) =>
        db.query<{ takedown_at: Date | null }>("SELECT takedown_at FROM nodes WHERE id = $1", [file.id]),
      ).then((result) => result.rows[0]!.takedown_at);
    expect(await takenDown()).not.toBeNull();

    // An hour after the window closed: refused too (the statute's "not more than 14").
    await atClock(notAfter + 3_600_000);
    await restore();
    await expect(dialog).toContainText("Restore is possible only until the end of the window.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await takenDown()).not.toBeNull();

    // An hour into the window: restored — the file back, its link live, the strike lifted.
    await atClock(notBefore + 3_600_000);
    await restore();
    await expect(dialog).toBeHidden();
    await expect(notice).toContainText("Restored");
    expect(await takenDown()).toBeNull();
    expect(await pauseReasons(linkId)).toEqual([]);
    const strikes = await strikesOf();
    expect(strikes).toHaveLength(1);
    expect(strikes[0]!.lifted_at).not.toBeNull();
    await page.unroute("**/api/**");
  });
});

test.describe("reports", () => {
  test("a report detail requests no /t/, /i/ or /d/ URL and can be dismissed", async ({ page, clientIp }) => {
    await signedInAdmin2fa(page, { clientIp });
    const ownerId = (
      await localDb((db) =>
        db.query<{ id: string }>(
          `INSERT INTO "user" (id, name, email, email_verified)
           VALUES ($1, 'E2E Owner', $2, true) RETURNING id`,
          [hex(16), `owner-${hex(6)}@example.test`],
        ),
      )
    ).rows[0]!.id;
    // As the intake leaves it: the node under review (its earlier status saved), an open report.
    const file = await seedFile(ownerId, { scanStatus: "under_review", scanStatusPrev: "clean" });
    const reportId = (
      await localDb((db) =>
        db.query<{ id: string }>(
          `INSERT INTO reports (id, node_id, owner_id, category, source, details, reporter_ip_hash_stable)
           VALUES ($1, $2, $3, 'spam', 'user', 'Made up for the e2e test.', $4) RETURNING id`,
          [randomUUID(), file.id, ownerId, hex(16)],
        ),
      )
    ).rows[0]!.id;

    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.goto("/admin/reports");
    await expect(page.locator("[data-admin-page]")).toBeVisible();
    await navigateInApp(page, `/admin/reports/${reportId}`);
    await expect(page.locator("[data-admin-counsel-notice]")).toHaveText(COUNSEL_NOTICE);
    await expect(page.getByText(file.name)).toBeVisible();

    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await confirmWithReason(page, "Dismiss", "Not spam: the owner's own notes.");
    await expect(page.locator("[data-admin-report-page]")).toContainText("Dismissed");

    const files = filesOrigin(e2ePort());
    expect(requested.filter((url) => /\/(t|i|d)\/[0-9a-f-]{36}/.test(url))).toEqual([]);
    expect(requested.filter((url) => url.startsWith(files))).toEqual([]);
    expect(requested.some((url) => url.startsWith(appOrigin(e2ePort())))).toBe(true);
    const node = await localDb((db) =>
      db.query<{ scan_status: string; scan_status_prev: string | null }>(
        "SELECT scan_status, scan_status_prev FROM nodes WHERE id = $1",
        [file.id],
      ),
    );
    expect(node.rows[0]).toEqual({ scan_status: "clean", scan_status_prev: null });
  });
});
