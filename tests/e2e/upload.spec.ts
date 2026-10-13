// The uploader on /uploads, in a real browser: the hashing worker, XMLHttpRequest bodies, the
// browser's own database for the resume list, the transfer ribbon and its panel.
//
//   npm run e2e -- tests/e2e/upload.spec.ts
//
// MOCKED by default (fixtures/mode.ts): `mockShell` signs a user in, and a small stand-in for the
// upload API — written against the contract's schemas — answers /api/uploads*, /api/nodes* and
// /api/account/usage. It keeps sessions, parts and reserved bytes, so a reload meets the state
// the page left behind. The last block is REAL mode (HOLDFAST_E2E_REAL=1): post-integration.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import type { Locator, Page, Request, Route } from "@playwright/test";
import { signedInUser } from "../setup/auth-fixtures";
import { fixtureFiles } from "../setup/fixture-files";
import {
  errorBody,
  EXISTING_ID,
  FOLDER_ID,
  folderDto,
  initResponse,
  nodeDetail,
  nodeDto,
  openUploadsResponse,
  partResponse,
  rowId,
  singleResponse,
  uploadSession,
  usageDto,
} from "../unit/client/upload/fixtures";
import { expect, expectNoA11yViolations, mockedOnly, mockShell, realOnly, test } from "./fixtures";

const DESKTOP_MIN = 1024;
const PART = 67_108_864;
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;

const files = fixtureFiles();
const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** SHA-256 of `size` zero bytes, without holding them. */
function sha256Zeros(size: number): string {
  const hash = createHash("sha256");
  const block = Buffer.alloc(8 * 1024 * 1024);
  for (let left = size; left > 0; left -= block.length)
    hash.update(block.subarray(0, Math.min(left, block.length)));
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------
// The stand-in upload API.

interface InitBody {
  parentId: string | null;
  name: string;
  size: number;
  mimeDeclared: string;
  fileLastModified: string;
  onConflict: "fail" | "rename" | "replace";
  replaceNodeId?: string;
  purpose: string;
}

interface Session {
  uploadId: string;
  body: InitBody;
  finalName: string;
  mode: "single" | "multipart";
  partBytes: number;
  partCount: number;
  parts: Map<number, string>;
}

interface PutSeen {
  uploadId: string;
  n: number | "single";
  contentLength: string | undefined;
}

type Answer = { status: number; json: unknown };

interface UploadApi {
  /** The part size init hands out (the client must follow it, whatever it is). */
  partBytes: number;
  sessions: Map<string, Session>;
  inits: InitBody[];
  completes: Array<{ uploadId: string; sha256: string; parts: Array<{ n: number; etag: string }> }>;
  /** Every body request that reached the API, in order. */
  puts: PutSeen[];
  /** The ones that were answered. */
  stored: PutSeen[];
  deletes: string[];
  /** What the scan says once the file is read back; "clean" is answered at complete. */
  scan: "clean" | "infected" | "error";
  /** Hold a body request until `release()` (answer it) or `abandon()` (the page that sent it is gone). */
  hold: (n: number | "single") => boolean;
  release(): void;
  abandon(): void;
  onInit?: (body: InitBody, nth: number) => Answer | undefined;
  onComplete?: (nth: number) => Answer | undefined;
  usedBytes(): number;
}

const STARTING_BYTES = 1_000_000_000;

async function mockUploadApi(page: Page, port: number): Promise<UploadApi> {
  let open!: (answer: boolean) => void;
  let gate = new Promise<boolean>((resolve) => (open = resolve));
  const reopen = (answer: boolean) => {
    api.hold = () => false;
    open(answer);
    gate = new Promise<boolean>((resolve) => (open = resolve));
  };
  let created = 0;
  let landedBytes = 0;
  const landed = new Map<string, { name: string; polls: number }>();
  const api: UploadApi = {
    partBytes: PART,
    sessions: new Map(),
    inits: [],
    completes: [],
    puts: [],
    stored: [],
    deletes: [],
    scan: "clean",
    hold: () => false,
    release: () => reopen(true),
    abandon: () => reopen(false),
    usedBytes: () =>
      STARTING_BYTES +
      landedBytes +
      Array.from(api.sessions.values()).reduce((sum, s) => sum + s.body.size, 0),
  };

  const answer = (route: Route, status: number, json: unknown) => route.fulfill({ status, json });

  await mockShell(page, port);
  // Registered after mockShell, so asked first; what it does not name falls through to mockShell.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    try {
      if (path === "/api/account/usage") {
        const reserved = api.usedBytes() - STARTING_BYTES - landedBytes;
        return await answer(
          route,
          200,
          usageDto({
            usedBytes: api.usedBytes(),
            filesBytes: STARTING_BYTES + landedBytes,
            reservedBytes: reserved,
          }),
        );
      }
      if (path === "/api/uploads/open") {
        return await answer(
          route,
          200,
          openUploadsResponse(
            Array.from(api.sessions.values(), (s) =>
              uploadSession({
                uploadId: s.uploadId,
                parentId: s.body.parentId,
                name: s.finalName,
                size: s.body.size,
                partBytes: s.partBytes,
                partCount: s.partCount,
                uploadedParts: s.parts.size,
                fileLastModified: s.body.fileLastModified,
              }),
            ),
          ),
        );
      }
      if (method === "POST" && path === "/api/uploads") {
        const body = request.postDataJSON() as InitBody;
        api.inits.push(body);
        const custom = api.onInit?.(body, api.inits.length);
        if (custom) return await answer(route, custom.status, custom.json);
        // The resume lookup comes first: the same file for the same place is the same session.
        let session = Array.from(api.sessions.values()).find(
          (s) =>
            s.body.name === body.name &&
            s.body.size === body.size &&
            s.body.parentId === body.parentId &&
            s.body.fileLastModified === body.fileLastModified,
        );
        if (!session) {
          created += 1;
          const multipart = body.size > api.partBytes;
          session = {
            uploadId: rowId(0x5000 + created),
            body,
            finalName: body.onConflict === "rename" ? body.name.replace(/(\.[^.]*)?$/, " (1)$1") : body.name,
            mode: multipart ? "multipart" : "single",
            partBytes: api.partBytes,
            partCount: multipart ? Math.ceil(body.size / api.partBytes) : 1,
            parts: new Map(),
          };
          api.sessions.set(session.uploadId, session);
        }
        return await answer(
          route,
          200,
          initResponse(body.size, {
            uploadId: session.uploadId,
            mode: session.mode,
            partBytes: session.partBytes,
            partCount: session.partCount,
            finalName: session.finalName,
            resumedParts: Array.from(session.parts, ([n, etag]) => ({ n, etag })),
          }),
        );
      }
      const body = /^\/api\/uploads\/([^/]+)\/(?:parts\/(\d+)|single)$/.exec(path);
      if (method === "PUT" && body) {
        // The body is never read here: a 64 MiB part stays in the browser.
        const session = api.sessions.get(body[1]!);
        const n = body[2] ? Number(body[2]) : ("single" as const);
        const seen: PutSeen = { uploadId: body[1]!, n, contentLength: request.headers()["content-length"] };
        api.puts.push(seen);
        if (!session) return await answer(route, 404, errorBody("not_found", "Not found."));
        // A held request whose page was reloaded never arrived: nothing is stored for it.
        if (api.hold(n) && !(await gate)) return await route.abort();
        if (!api.sessions.has(session.uploadId))
          return await answer(route, 404, errorBody("not_found", "Not found."));
        api.stored.push(seen);
        if (n === "single") return await answer(route, 200, singleResponse());
        session.parts.set(n, `etag-${n}`);
        return await answer(route, 200, partResponse(n));
      }
      const complete = /^\/api\/uploads\/([^/]+)\/complete$/.exec(path);
      if (method === "POST" && complete) {
        const session = api.sessions.get(complete[1]!);
        if (!session) return await answer(route, 404, errorBody("not_found", "Not found."));
        const sent = request.postDataJSON() as { sha256: string; parts: Array<{ n: number; etag: string }> };
        api.completes.push({ uploadId: session.uploadId, ...sent });
        const custom = api.onComplete?.(api.completes.length);
        if (custom) {
          if (custom.status === 403) api.sessions.delete(session.uploadId);
          return await answer(route, custom.status, custom.json);
        }
        api.sessions.delete(session.uploadId);
        landedBytes += session.body.size;
        const id = rowId(0x6000 + api.completes.length);
        landed.set(id, { name: session.finalName, polls: 0 });
        return await answer(
          route,
          200,
          nodeDto({
            id,
            name: session.finalName,
            parentId: session.body.parentId,
            size: session.body.size,
            sha256: sent.sha256,
            scanStatus: api.scan === "clean" ? "clean" : "pending",
          }),
        );
      }
      const session = /^\/api\/uploads\/([^/]+)$/.exec(path);
      if (method === "DELETE" && session) {
        api.deletes.push(session[1]!);
        api.sessions.delete(session[1]!);
        return await route.fulfill({ status: 204, body: "" });
      }
      if (method === "POST" && path === "/api/nodes/folder") {
        const sent = request.postDataJSON() as { parentId: string | null; name: string };
        created += 1;
        return await answer(route, 200, folderDto({ id: rowId(0x7000 + created), ...sent }));
      }
      const node = /^\/api\/nodes\/([^/]+)$/.exec(path);
      if (method === "GET" && node) {
        if (node[1] === FOLDER_ID) return await answer(route, 200, nodeDetail({ ...folderDto() }));
        const file = landed.get(node[1]!);
        if (!file) return await answer(route, 404, errorBody("not_found", "Not found."));
        file.polls += 1;
        // Still pending on the first read, so "Scanning" is seen.
        const scanStatus = file.polls < 2 ? "pending" : api.scan;
        return await answer(route, 200, nodeDetail({ id: node[1]!, name: file.name, scanStatus }));
      }
      return await route.fallback();
    } catch {
      // The page went away (a reload) while a request was being held.
    }
  });
  return api;
}

// ---------------------------------------------------------------------------------------------
// The page.

const ribbon = (page: Page) => page.locator("[data-transfer-ribbon]");
const sentence = (page: Page) => page.locator("[data-ribbon-sentence]");
const rows = (page: Page) => page.locator("[data-ribbon-panel] [data-upload-row]");
const row = (page: Page, name: string) => page.locator(`[data-ribbon-panel] [data-upload-name="${name}"]`);
const live = (page: Page) => page.locator("[data-upload-live]");
const filesInput = (page: Page) => page.locator('input[data-upload-input="files"]');

async function openUploads(page: Page, search = ""): Promise<void> {
  await page.goto(`/uploads${search}`);
  await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
}

async function openPanel(page: Page): Promise<Locator> {
  const toggle = ribbon(page).locator("button[aria-expanded]");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const panel = page.locator("[data-ribbon-panel]");
  await expect(panel).toBeVisible();
  return panel;
}

/** Fail the test on anything the page throws, and on a refused script, worker or WASM. */
function watchPage(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (
      /content security policy|refused to (load|execute|apply|connect|frame|create|compile)/i.test(
        message.text(),
      )
    ) {
      problems.push(message.text());
    }
  });
  return problems;
}

/** `PUT` body requests the browser made, as "<n>" or "single". */
function watchPuts(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request: Request) => {
    const match = /\/api\/uploads\/[^/]+\/(?:parts\/(\d+)|(single))$/.exec(new URL(request.url()).pathname);
    if (request.method() === "PUT" && match) seen.push(match[1] ?? match[2]!);
  });
  return seen;
}

test.describe("uploads (mocked API)", () => {
  test.beforeEach(() => mockedOnly());

  test("a 1 KB file: one PUT, the worker's digest at complete, announced from start to finish", async ({
    page,
    origins,
  }) => {
    const problems = watchPage(page);
    const api = await mockUploadApi(page, origins.port);
    api.scan = "clean";
    await openUploads(page);
    await expect(page.locator("[data-uploads-free]")).toHaveText("4 GB free of 5 GB");
    await filesInput(page).setInputFiles(files.text);

    await expect.poll(() => api.completes.length).toBe(1);
    expect(api.inits).toEqual([
      {
        parentId: null,
        name: "hello.txt",
        size: 1024,
        mimeDeclared: "text/plain",
        fileLastModified: new Date(Math.floor(statSync(files.text).mtimeMs)).toISOString(),
        onConflict: "fail",
        purpose: "file",
      },
    ]);
    expect(api.puts.map((put) => put.n)).toEqual(["single"]);
    // Hashed in the Web Worker (WASM, under the page's CSP): the digest is the file's.
    expect(api.completes[0]).toMatchObject({ sha256: sha256File(files.text), parts: [] });
    await expect(live(page)).toContainText("Uploading hello.txt");
    await expect(live(page)).toContainText("hello.txt uploaded");
    // Safe = nothing shown: the ribbon is idle again.
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");
    expect(problems).toEqual([]);
  });

  test("a 2 MB PNG into a folder: Scanning, and then what the scan said", async ({ page, origins }) => {
    const problems = watchPage(page);
    const api = await mockUploadApi(page, origins.port);
    // Complete answers `pending`; the poll of the node then reads `.node.scanStatus`.
    api.scan = "error";
    await openUploads(page, `?parent=${FOLDER_ID}`);
    await filesInput(page).setInputFiles(files.png);

    await expect(sentence(page)).toHaveText("Scanning 1 file");
    expect(api.completes.length).toBe(1);
    expect(api.inits[0]).toMatchObject({
      parentId: FOLDER_ID,
      name: "noise-2mb.png",
      mimeDeclared: "image/png",
    });
    expect(api.inits[0]!.size).toBe(statSync(files.png).size);
    expect(api.puts.map((put) => put.n)).toEqual(["single"]);
    expect(api.completes[0]).toMatchObject({ sha256: sha256File(files.png), parts: [] });
    // The scan could not read it: the row stays and says so.
    await expect(sentence(page)).toHaveText("Couldn't scan 1 file");
    const panel = await openPanel(page);
    await expect(panel.locator('[data-status="error"]')).toContainText("Couldn't scan");
    await expect(live(page)).toContainText("Couldn't scan noise-2mb.png");
    expect(problems).toEqual([]);
  });

  test("the 140,000,000-byte file: three parts of the server's size, progress never moves back", async ({
    page,
    origins,
  }) => {
    test.slow();
    const problems = watchPage(page);
    const api = await mockUploadApi(page, origins.port);
    await openUploads(page);
    // Every value the ribbon's progress bar takes, in order.
    await page.evaluate(() => {
      const samples: number[] = [];
      (window as unknown as { samples: number[] }).samples = samples;
      new MutationObserver(() => {
        const bar = document.querySelector('[data-transfer-ribbon] > [role="progressbar"]');
        const now = bar?.getAttribute("aria-valuenow");
        if (now !== null && now !== undefined) samples.push(Number(now));
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    const puts = watchPuts(page);
    await filesInput(page).setInputFiles(files.sparse140MB);

    await expect.poll(() => api.completes.length, { timeout: 90_000 }).toBe(1);
    expect(api.inits[0]).toMatchObject({ name: basename(files.sparse140MB), size: 140_000_000 });
    expect([...puts].sort()).toEqual(["1", "2", "3"]);
    expect(api.completes[0]!.parts).toEqual([
      { n: 1, etag: "etag-1" },
      { n: 2, etag: "etag-2" },
      { n: 3, etag: "etag-3" },
    ]);
    expect(api.completes[0]!.sha256).toBe(sha256Zeros(140_000_000));
    const samples = await page.evaluate(() => (window as unknown as { samples: number[] }).samples);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples).toEqual([...samples].sort((a, b) => a - b));
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");
    expect(problems).toEqual([]);
  });

  test("pause and resume: what arrived is not sent again, and no new session is asked for", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    // The server's part size, far below anything a client would choose: the client follows.
    api.partBytes = 512 * 1024;
    api.hold = (n) => n !== 1;
    await openUploads(page);
    const puts = watchPuts(page);
    await filesInput(page).setInputFiles(files.png);
    await expect.poll(() => api.stored.map((put) => put.n)).toEqual([1]);
    const partCount = Math.ceil(statSync(files.png).size / api.partBytes);
    expect(partCount).toBeGreaterThanOrEqual(4);

    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "Pause noise-2mb.png" }).click();
    await expect(row(page, "noise-2mb.png")).toHaveAttribute("data-upload-row", "paused");
    await expect(sentence(page)).toContainText("Paused · 1 of 1");
    // The same button is now Resume, and it kept the focus.
    const resume = panel.getByRole("button", { name: "Resume noise-2mb.png" });
    await expect(resume).toBeFocused();
    const before = puts.length;
    api.release();
    await resume.click();

    await expect.poll(() => api.completes.length).toBe(1);
    expect(puts.slice(before)).not.toContain("1");
    expect(puts.filter((n) => n === "1").length).toBe(1);
    expect(api.inits.length).toBe(1);
    expect(api.completes[0]!.parts.map((part) => part.n)).toEqual(
      Array.from({ length: partCount }, (_, i) => i + 1),
    );
    expect(api.completes[0]!.sha256).toBe(sha256File(files.png));
  });

  test("cancel: the session is aborted and the usage is back at its starting value", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    api.hold = () => true;
    await openUploads(page);
    const usage = () =>
      page.evaluate(async () => {
        const response = await fetch("/api/account/usage");
        return ((await response.json()) as { usedBytes: number }).usedBytes;
      });
    const start = await usage();
    await filesInput(page).setInputFiles(files.png);
    await expect.poll(() => api.puts.length).toBe(1);
    expect(await usage()).toBe(start + statSync(files.png).size);

    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "Cancel noise-2mb.png" }).click();
    await expect.poll(() => api.deletes.length).toBe(1);
    expect(await usage()).toBe(start);
    expect(api.completes).toEqual([]);
    await expect(live(page)).toContainText("Cancelled noise-2mb.png");
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");
    api.release();
  });

  test("reload mid-upload, select the file again: no PUT for the parts that had arrived", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    api.partBytes = 512 * 1024;
    api.hold = (n) => n !== 1 && n !== 2;
    await openUploads(page, `?parent=${FOLDER_ID}`);
    const puts = watchPuts(page);
    await filesInput(page).setInputFiles(files.png);
    await expect.poll(() => api.stored.map((put) => put.n).sort()).toEqual([1, 2]);
    const [session] = Array.from(api.sessions.values());

    await page.reload();
    api.abandon();
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    // The queue is back from the browser's own database, asking for the file.
    await expect(sentence(page)).toHaveText("1 upload to resume — select the file again");
    const panel = await openPanel(page);
    await expect(panel).toContainText("Select noise-2mb.png again to resume");
    const before = puts.length;
    // Selected on a page that names no folder: the upload still knows where it was going.
    await page.goto("/uploads");
    await expect(sentence(page)).toHaveText("1 upload to resume — select the file again");
    await filesInput(page).setInputFiles(files.png);

    await expect.poll(() => api.completes.length).toBe(1);
    const after = puts.slice(before);
    expect(after).not.toContain("1");
    expect(after).not.toContain("2");
    expect(after.length).toBe(session!.partCount - 2);
    expect(puts.filter((n) => n === "1").length).toBe(1);
    expect(puts.filter((n) => n === "2").length).toBe(1);
    // The same session, found by the same init.
    expect(api.inits.length).toBe(2);
    expect(api.inits[1]).toEqual(api.inits[0]);
    expect(api.completes[0]!.uploadId).toBe(session!.uploadId);
    expect(api.completes[0]!.sha256).toBe(sha256File(files.png));
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");

    // Nothing is left for the next load.
    await page.reload();
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");
  });

  test.describe("a name that is taken", () => {
    const taken = {
      status: 409,
      json: errorBody("conflict", "A file with this name already exists.", { existingId: EXISTING_ID }),
    };

    test("Replace sends the id of the file that is there", async ({ page, origins }) => {
      const api = await mockUploadApi(page, origins.port);
      api.onInit = (body) => (body.onConflict === "fail" ? taken : undefined);
      await openUploads(page);
      await filesInput(page).setInputFiles(files.text);
      const dialog = page.getByRole("dialog", { name: "hello.txt is already here" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Skip" })).toBeFocused();
      await expectNoA11yViolations(page);
      await dialog.getByRole("button", { name: "Replace" }).click();
      await expect.poll(() => api.completes.length).toBe(1);
      expect(api.inits[1]).toMatchObject({ onConflict: "replace", replaceNodeId: EXISTING_ID });
      await expect(dialog).toHaveCount(0);
    });

    test("Keep both lets the server pick a free name", async ({ page, origins }) => {
      const api = await mockUploadApi(page, origins.port);
      api.onInit = (body) => (body.onConflict === "fail" ? taken : undefined);
      await openUploads(page);
      await filesInput(page).setInputFiles(files.text);
      await page.getByRole("dialog").getByRole("button", { name: "Keep both" }).click();
      await expect.poll(() => api.completes.length).toBe(1);
      expect(api.inits[1]).toMatchObject({ onConflict: "rename" });
      await expect(live(page)).toContainText("hello (1).txt uploaded");
    });

    test("Skip uploads nothing", async ({ page, origins }) => {
      const api = await mockUploadApi(page, origins.port);
      api.onInit = () => taken;
      await openUploads(page);
      await filesInput(page).setInputFiles(files.text);
      await page.getByRole("dialog").getByRole("button", { name: "Skip" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");
      expect(api.inits.length).toBe(1);
      expect(api.puts).toEqual([]);
    });
  });

  test("the live region announces start, complete, blocked and error; the open panel has no axe violations", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    api.scan = "infected";
    api.onInit = (body) =>
      body.name === "page.html"
        ? { status: 400, json: errorBody("validation", "That name can't be used.") }
        : undefined;
    await openUploads(page);
    await expect(live(page)).toHaveAttribute("aria-live", "polite");
    await filesInput(page).setInputFiles([files.text, files.html]);

    await expect(live(page)).toContainText("Uploading hello.txt");
    await expect(live(page)).toContainText("hello.txt uploaded");
    await expect(live(page)).toContainText("hello.txt was blocked — flagged by the malware scan");
    await expect(live(page)).toContainText("page.html didn't finish");

    const panel = await openPanel(page);
    await expect(rows(page)).toHaveCount(2);
    // Blocked: the scan's sentence, and nothing that invites another upload.
    const blocked = row(page, "hello.txt");
    await expect(blocked.locator('[data-status="infected"]')).toHaveText(
      "Blocked — flagged by the malware scan",
    );
    await expect(blocked.getByRole("button")).toHaveCount(1);
    await expect(blocked.getByRole("button", { name: "Remove hello.txt from the list" })).toBeVisible();
    await expect(row(page, "page.html")).toContainText("That name can't be used.");
    await expect(row(page, "page.html")).toContainText("req req-upload");
    await expectNoA11yViolations(page);

    // Keyboard: the rows' controls are reachable and removing a row keeps the focus in the panel.
    await blocked.getByRole("button", { name: "Remove hello.txt from the list" }).focus();
    await page.keyboard.press("Enter");
    await expect(rows(page)).toHaveCount(1);
    await expect(panel.getByRole("heading", { name: "Uploads" })).toBeFocused();
    // The last row takes the panel with it: the focus goes to the page, not to nowhere.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Try page.html again" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Remove page.html from the list" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(page.locator("[data-main]")).toBeFocused();
  });

  test("blocked content is refused for good: Remove is the only control, and nothing more is sent", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    api.onComplete = () => ({
      status: 403,
      json: errorBody("forbidden", "This file can't be stored here.", { reason: "blocked_content" }),
    });
    await openUploads(page);
    await filesInput(page).setInputFiles(files.text);
    await expect(sentence(page)).toHaveText("1 file was refused");
    await expect(live(page)).toContainText("hello.txt was refused. This file can't be stored here.");
    const panel = await openPanel(page);
    const refused = row(page, "hello.txt");
    await expect(refused).toHaveAttribute("data-upload-row", "refused");
    await expect(refused).toContainText("Refused — this file can't be stored here.");
    await expect(panel.getByRole("button", { name: /again|retry|resume/i })).toHaveCount(0);
    await expect(refused.getByRole("button")).toHaveCount(1);

    // Not on the resume list, and selecting the same file again sends nothing.
    const requests = api.inits.length + api.puts.length + api.completes.length;
    await filesInput(page).setInputFiles(files.text);
    await page.reload();
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle");
    expect(api.inits.length + api.puts.length + api.completes.length).toBe(requests);
  });

  for (const width of [1280, 390]) {
    test(`at ${width} px the only progress surfaces are the ribbon and its panel — no floating tray`, async ({
      page,
      origins,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const api = await mockUploadApi(page, origins.port);
      api.hold = () => true;
      await openUploads(page);
      await filesInput(page).setInputFiles([files.text, files.png]);
      await expect.poll(() => api.puts.length).toBe(2);
      await expect(page.locator("[data-frame]")).toHaveAttribute(
        "data-frame",
        width >= DESKTOP_MIN ? "desktop" : "mobile",
      );
      await openPanel(page);
      await expect(rows(page)).toHaveCount(2);

      const surfaces = await page.evaluate(() => {
        const inRibbon = (element: Element) => element.closest("[data-transfer-ribbon]") !== null;
        const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
        const uploadRows = Array.from(document.querySelectorAll("[data-upload-row]"));
        // Anything that floats above the page (fixed or sticky) and speaks of an upload.
        const floating = Array.from(document.querySelectorAll("body *")).filter((element) => {
          const position = getComputedStyle(element).position;
          if (position !== "fixed" && position !== "sticky") return false;
          return /hello\.txt|noise-2mb\.png|Uploading/.test(element.textContent ?? "");
        });
        return {
          ribbons: document.querySelectorAll("[data-transfer-ribbon]").length,
          bars: bars.length,
          barsOutside: bars.filter((bar) => !inRibbon(bar)).length,
          rowsOutside: uploadRows.filter((element) => element.closest("[data-ribbon-panel]") === null).length,
          floating: floating.length,
        };
      });
      expect(surfaces).toEqual({ ribbons: 1, bars: 3, barsOutside: 0, rowsOutside: 0, floating: 0 });
      // The page itself draws no progress.
      await expect(page.locator("[data-uploads-page] [role='progressbar']")).toHaveCount(0);
      api.release();
    });
  }

  test("the ribbon's place: above the bottom nav on mobile, along the top of the content pane on desktop", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    api.hold = () => true;
    await openUploads(page);
    await filesInput(page).setInputFiles(files.png);
    await expect(sentence(page)).toContainText("Uploading 1 of 1");
    const box = (await ribbon(page).boundingBox())!;
    if (isMobile(page)) {
      const nav = (await page.locator("[data-bottom-nav]").boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(nav.y + 1);
      expect(box.y).toBeGreaterThan(nav.y - 200);
      // The panel opens upward from there, still above the nav.
      const panel = (await (await openPanel(page)).boundingBox())!;
      expect(panel.y + panel.height).toBeLessThanOrEqual(nav.y + 1);
      // 44 px targets on a touch layout.
      const pause = (await page.getByRole("button", { name: "Pause noise-2mb.png" }).boundingBox())!;
      expect(Math.min(pause.width, pause.height)).toBeGreaterThanOrEqual(44);
    } else {
      const main = (await page.locator("[data-main]").boundingBox())!;
      expect(box.y).toBe(0);
      expect(box.y + box.height).toBeLessThanOrEqual(main.y + 1);
    }
    api.release();
  });

  test("a body goes out with Content-Length, never chunked — as a server on the wire sees it", async ({
    page,
    origins,
  }) => {
    const api = await mockUploadApi(page, origins.port);
    // The browser's own request, body and all, is sent on to a plain HTTP server that writes
    // down what arrived. (The page does not see the detour.)
    const seen: Array<{ headers: IncomingHttpHeaders; bytes: number }> = [];
    const server = createServer((request, response) => {
      let bytes = 0;
      request.on("data", (chunk: Buffer) => (bytes += chunk.length));
      request.on("end", () => {
        seen.push({ headers: request.headers, bytes });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(partResponse(Number(request.url!.split("/").pop()))));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      api.partBytes = 512 * 1024;
      await page.route("**/api/uploads/*/parts/*", (route) => {
        const path = new URL(route.request().url()).pathname;
        const match = /^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path)!;
        api.sessions.get(match[1]!)?.parts.set(Number(match[2]), `etag-${match[2]}`);
        return route.continue({ url: `http://127.0.0.1:${port}/parts/${match[2]}` });
      });
      await openUploads(page);
      await filesInput(page).setInputFiles(files.png);
      await expect.poll(() => api.completes.length).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const size = statSync(files.png).size;
    const partCount = Math.ceil(size / (512 * 1024));
    expect(seen.length).toBe(partCount);
    for (const { headers, bytes } of seen) {
      expect(headers["transfer-encoding"]).toBeUndefined();
      expect(Number(headers["content-length"])).toBe(bytes);
      expect(headers["content-type"]).toBe("application/octet-stream");
    }
    // Every part but the last is exactly the server's part size; together they are the file.
    const lengths = seen.map((entry) => Number(entry.headers["content-length"])).sort((a, b) => b - a);
    expect(lengths.slice(0, partCount - 1).every((length) => length === 512 * 1024)).toBe(true);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(size);
  });

  for (const status of [404, 500]) {
    test(`with every API request answered ${status}, /uploads shows its error state and nothing throws`, async ({
      page,
      origins,
    }) => {
      const problems = watchPage(page);
      await mockShell(page, origins.port, {
        api: async (route, path) => {
          if (status === 404) return false; // mockShell's own answer for everything nobody names
          if (
            ["/api/public/config", "/api/auth/get-session", "/api/account/deletion-status"].includes(path)
          ) {
            return false;
          }
          await route.fulfill({
            status: 500,
            json: { error: "internal", message: "Internal error.", requestId: "req-e2e" },
          });
          return true;
        },
      });
      await page.goto("/uploads");
      await expect(page.locator("[data-frame]")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Couldn't load uploads" })).toBeVisible();
      await expect(page.locator('[data-empty-state="unavailable"]')).toContainText("req req-e2e");
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose files" })).toHaveCount(0);
      await expect(page.locator("[data-placeholder-page]")).toHaveCount(0);
      await expectNoA11yViolations(page);
      expect(problems).toEqual([]);
    });
  }

  test("/uploads has no axe violations, idle and with a drop pending", async ({ page, origins }) => {
    await mockUploadApi(page, origins.port);
    await openUploads(page);
    await expectNoA11yViolations(page);
    // Dragging a file over the app says where it will go.
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "dragged.txt", { type: "text/plain" }));
      window.dispatchEvent(
        new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator("[data-upload-drop]")).toHaveText("Drop to upload to Files");
    await expectNoA11yViolations(page);
  });

  test("dropping files on the app uploads them to the folder in the address", async ({ page, origins }) => {
    const api = await mockUploadApi(page, origins.port);
    await openUploads(page, `?parent=${FOLDER_ID}`);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
      const init = { dataTransfer: transfer, bubbles: true, cancelable: true };
      window.dispatchEvent(new DragEvent("dragenter", init));
      window.dispatchEvent(new DragEvent("drop", init));
    });
    await expect.poll(() => api.completes.length).toBe(1);
    expect(api.inits[0]).toMatchObject({ name: "dropped.txt", parentId: FOLDER_ID, size: 7 });
    await expect(page.locator("[data-upload-drop]")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// REAL mode — post-integration (HOLDFAST_E2E_REAL=1, on the integrated branch). Not run in the
// uploader's own worktree, where the upload API is still a placeholder.

test.describe("uploads (real API)", () => {
  test.beforeEach(() => realOnly());

  test("a file uploads, is shown as Scanning, and completes once the scan has cleared it", async ({
    page,
    clientIp,
  }) => {
    await signedInUser(page, { clientIp });
    await openUploads(page);
    await filesInput(page).setInputFiles(files.text);
    await expect(live(page)).toContainText("Uploading hello.txt");
    await expect(live(page)).toContainText("hello.txt uploaded");
    // Clean = nothing shown: the row goes and the ribbon is idle.
    await expect(ribbon(page)).toHaveAttribute("data-transfer-ribbon", "idle", { timeout: 30_000 });
  });

  test("the 140,000,000-byte file goes up in three parts", async ({ page, clientIp }) => {
    test.slow();
    await signedInUser(page, { clientIp });
    await openUploads(page);
    const puts = watchPuts(page);
    await filesInput(page).setInputFiles(files.sparse140MB);
    await expect(live(page)).toContainText(`${basename(files.sparse140MB)} uploaded`, { timeout: 120_000 });
    expect([...puts].sort()).toEqual(["1", "2", "3"]);
  });

  test("the antivirus test file ends Blocked", async ({ page, clientIp }) => {
    await signedInUser(page, { clientIp });
    await openUploads(page);
    await filesInput(page).setInputFiles(files.eicar);
    await expect(live(page)).toContainText("was blocked — flagged by the malware scan", { timeout: 30_000 });
    await openPanel(page);
    await expect(rows(page).locator('[data-status="infected"]')).toHaveText(
      "Blocked — flagged by the malware scan",
    );
  });
});
