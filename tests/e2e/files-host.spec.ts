// The files host as a browser meets it, against `vite dev`.
//
// Without a stored object (every run): what a token that does not verify, an unknown path, a
// method this host does not have are answered with — status, body and the hardened header set
// — and that the app's page may ask this origin at all.
//
// With a stored object (REAL mode only — it needs the upload and download-url routes as built):
// a small real mp4 is uploaded, becomes clean, and a <video> that seeks to its middle makes the
// browser send a Range request this host answers with a 206.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signedInUser } from "../setup/auth-fixtures";
import { expect, realOnly, test } from "./fixtures";

const HARDENED: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  vary: "Origin",
};

function expectHardened(headers: Record<string, string>, appOrigin: string, label: string) {
  for (const [name, value] of Object.entries(HARDENED)) expect(headers[name], `${label} ${name}`).toBe(value);
  expect(headers["access-control-allow-origin"], label).toBe(appOrigin);
  expect(headers["set-cookie"], label).toBeUndefined();
  expect(headers["content-type"] ?? "", label).not.toMatch(/html|json/);
}

test.describe("files host: answers that need no stored object", () => {
  test("a token that does not verify is 403 text on /d/, /i/ and /t/ — GET and HEAD — with the hardened headers and no cookie", async ({
    request,
    origins,
  }) => {
    for (const path of [
      "/d/0190a1b2-0000-7000-8000-000000000001/not-a-token",
      "/i/0190a1b2-0000-7000-8000-000000000001/not-a-token",
      "/t/0190a1b2-0000-7000-8000-000000000001/320/not-a-token",
      "/d/only-one-segment",
    ]) {
      const got = await request.get(`${origins.files}${path}`, {
        headers: { cookie: "made-up=for-this-test" },
      });
      expect(got.status(), path).toBe(403);
      expect(await got.text(), path).toBe("The link is not valid.\n");
      expect(got.headers()["content-type"], path).toBe("text/plain; charset=utf-8");
      expectHardened(got.headers(), origins.app, path);

      const head = await request.head(`${origins.files}${path}`);
      expect(head.status(), path).toBe(403);
      expect(await head.text(), path).toBe("");
      expectHardened(head.headers(), origins.app, `HEAD ${path}`);
    }
  });

  test("anything else is a 404 text; a method this host does not have is one too", async ({
    request,
    origins,
  }) => {
    for (const path of ["/", "/index.html", "/api/health", "/s/some-link-token", "/x/y/z"]) {
      const answer = await request.get(`${origins.files}${path}`);
      expect(answer.status(), path).toBe(404);
      expect(await answer.text(), path).toBe("Not found\n");
      expectHardened(answer.headers(), origins.app, path);
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const answer = await request.fetch(`${origins.files}/d/0190a1b2-0000-7000-8000-000000000001/token`, {
        method,
        data: "x",
      });
      expect(answer.status(), method).toBe(404);
      expectHardened(answer.headers(), origins.app, method);
    }
  });

  // (The preflight is not asserted here: under `vite dev` the dev server's own CORS middleware
  // answers every OPTIONS before the Worker sees it. tests/unit/files-host/headers.test.ts and
  // tests/unit/worker-core/hosts.test.ts hold this host's own answer.)

  test("from the app's page: a ranged, conditional fetch reaches this host across origins and reads its 403 — no policy violation, no cookie", async ({
    page,
    origins,
  }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy|refused to (load|connect)/i.test(message.text()))
        violations.push(message.text());
    });
    await page.goto("/");
    const target = `${origins.files}/i/0190a1b2-0000-7000-8000-000000000001/not-a-token`;

    // A ranged, conditional fetch is not a "simple" request: the browser preflights it first.
    const fetched = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: "bytes=0-9", "If-None-Match": '"x"' } });
      return {
        status: response.status,
        text: await response.text(),
        type: response.headers.get("content-type"),
      };
    }, target);
    expect(fetched).toEqual({
      status: 403,
      text: "The link is not valid.\n",
      type: "text/plain; charset=utf-8",
    });

    expect(violations).toEqual([]);
    expect(await page.context().cookies(origins.files)).toEqual([]);
  });
});

// ── with a stored object: REAL mode, after integration ──────────────────────────────────────

const CLIP = fileURLToPath(new URL("../unit/files-host/fixtures/clip.mp4", import.meta.url));

test.describe("files host: a real file (REAL mode)", () => {
  test("a <video> seeking to its middle gets a 206 with a Content-Range and no cookie", async ({
    page,
    origins,
    clientIp,
  }) => {
    realOnly("needs the upload routes and the download-url route as built");
    await signedInUser(page, { clientIp });
    const bytes = readFileSync(CLIP);
    const api = page.request;
    const json = { origin: origins.app, "content-type": "application/json" };

    const init = await api.post("/api/uploads", {
      headers: json,
      data: {
        parentId: null,
        name: "clip.mp4",
        size: bytes.byteLength,
        mimeDeclared: "video/mp4",
        fileLastModified: new Date().toISOString(),
        onConflict: "rename",
        purpose: "file",
      },
    });
    expect(init.status(), await init.text()).toBe(200);
    const { uploadId, mode } = (await init.json()) as { uploadId: string; mode: string };
    expect(mode).toBe("single");
    const put = await api.put(`/api/uploads/${uploadId}/single`, {
      headers: { origin: origins.app, "content-type": "application/octet-stream" },
      data: bytes,
    });
    expect(put.status(), await put.text()).toBe(200);
    const complete = await api.post(`/api/uploads/${uploadId}/complete`, {
      headers: json,
      data: { sha256: createHash("sha256").update(bytes).digest("hex"), parts: [] },
    });
    expect(complete.status(), await complete.text()).toBe(200);
    const node = (await complete.json()) as { id: string };

    // The file leaves `pending` when the scan consumer has seen it.
    await expect
      .poll(
        async () =>
          ((await (await api.get(`/api/nodes/${node.id}`)).json()) as { scanStatus?: string }).scanStatus,
        {
          timeout: 30_000,
        },
      )
      .toBe("clean");

    const minted = await api.post(`/api/nodes/${node.id}/download-url`, {
      headers: json,
      data: { kind: "inline" },
    });
    expect(minted.status(), await minted.text()).toBe(200);
    const { url } = (await minted.json()) as { url: string };
    expect(url.startsWith(`${origins.files}/i/${node.id}/`)).toBe(true);

    const partial: Array<{
      status: number;
      range: string | null;
      cookie: string | null;
      length: string | null;
    }> = [];
    page.on("response", (response) => {
      if (!response.url().startsWith(`${origins.files}/i/`)) return;
      void Promise.all([
        response.headerValue("content-range"),
        response.headerValue("set-cookie"),
        response.headerValue("content-length"),
      ]).then(([range, cookie, length]) =>
        partial.push({ status: response.status(), range, cookie, length }),
      );
    });
    await page.goto("/");
    const duration = await page.evaluate(
      (src) =>
        new Promise<number>((resolve, reject) => {
          const video = document.createElement("video");
          video.muted = true;
          video.preload = "auto";
          video.addEventListener("error", () => reject(new Error("the video did not load")));
          video.addEventListener("loadedmetadata", () => {
            video.addEventListener("seeked", () => resolve(video.duration), { once: true });
            video.currentTime = video.duration / 2;
          });
          video.src = src;
          document.body.appendChild(video);
        }),
      url,
    );
    expect(duration).toBeGreaterThan(1);
    await expect.poll(() => partial.some((seen) => seen.status === 206)).toBe(true);
    for (const seen of partial) {
      expect([200, 206]).toContain(seen.status);
      expect(seen.cookie).toBeNull();
      if (seen.status === 206) {
        expect(seen.range).toMatch(new RegExp(`^bytes \\d+-\\d+/${bytes.byteLength}$`));
        const [, first, last] = /^bytes (\d+)-(\d+)\//.exec(seen.range!)!;
        expect(Number(seen.length)).toBe(Number(last) - Number(first) + 1);
      }
    }

    // The download URL of the same file: an attachment, with a ranged read of exactly ten bytes.
    const forDownload = await api.post(`/api/nodes/${node.id}/download-url`, {
      headers: json,
      data: { kind: "download" },
    });
    const download = ((await forDownload.json()) as { url: string }).url;
    const ranged = await api.get(download, { headers: { range: "bytes=0-9" } });
    expect(ranged.status()).toBe(206);
    expect((await ranged.body()).byteLength).toBe(10);
    expect(ranged.headers()["content-disposition"]).toMatch(/^attachment; /);
    expect(ranged.headers()["set-cookie"]).toBeUndefined();
    const forged = await api.get(`${download.slice(0, -1)}${download.endsWith("A") ? "B" : "A"}`);
    expect(forged.status()).toBe(403);
  });
});
