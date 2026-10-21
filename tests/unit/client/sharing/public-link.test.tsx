// The public link page: what it says for each state, the password form and its waits, the link
// session (dropped on the first password_required, never four prompts for four retries), the
// interstitial before a dangerous download, the folder's zip under its grant, and how many
// requests the page makes over five minutes. Every password and token here is made up.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADER_LINK_SESSION } from "../../../../src/shared/constants";
import { LinkClient } from "../../../../src/client/features/public-link/client";
import { preloadRenderers } from "../preview/helpers";
import { deferred } from "../views/helpers";
import {
  envelope,
  FILE_ID,
  FOLDER_ID,
  info,
  json,
  minted,
  mockFetchCalls,
  openPublic,
  publicCalls,
  publicFile,
  publicFolder,
  publicPath,
  setupShell,
  TOKEN,
  type MockCall,
} from "./helpers";

setupShell();

const SESSION = "made-up-link-session";
const unlocked = { linkSession: SESSION, expiresAt: "2099-01-01T00:00:00.000Z" };
const passwordRequired = () => envelope("password_required", 403);

let saved: Blob[] = [];
beforeEach(() => {
  saved = [];
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => (saved.push(blob), "blob:made-up"),
      revokeObjectURL: () => {},
    }),
  );
  // A download is a click on an anchor: jsdom would try to navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

const header = (call: MockCall) => call.headers[HEADER_LINK_SESSION] ?? null;

describe("what the page says", () => {
  it.each([
    ["404 (no such link)", envelope("not_found", 404), "This link is no longer available."],
    [
      "410 revoked",
      envelope("link_expired", 410, { reason: "revoked" }),
      "This link is no longer available.",
    ],
    [
      "410 expired",
      envelope("link_expired", 410, { reason: "expired" }),
      "This link is no longer available.",
    ],
    [
      "410 limit",
      envelope("link_expired", 410, { reason: "limit_reached" }),
      "This link has reached its download limit.",
    ],
    [
      "423 traffic",
      envelope("link_paused", 423, { reason: "traffic" }),
      "This link is temporarily unavailable due to high traffic.",
    ],
    [
      "423 unavailable",
      envelope("link_paused", 423, { reason: "unavailable" }),
      "This link is temporarily unavailable.",
    ],
  ])("%s", async (_name, answer, words) => {
    await openPublic({ [`GET ${publicPath()}`]: answer });
    expect(await screen.findByRole("heading", { name: words })).toBeTruthy();
    expect(document.querySelector("[data-frame]")).toBeNull();
    // Never more than the one sentence: no node, no reason.
    expect(document.querySelector("[data-public-file], [data-public-folder]")).toBeNull();
  });

  it("is marked noindex and no-referrer while it is shown", async () => {
    const { unmount } = await openPublic({ [`GET ${publicPath()}`]: info(publicFile()) });
    await screen.findByRole("heading", { name: "report.txt" });
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
    // The token is in the address: nothing this page loads or opens is sent it as a Referer.
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    unmount();
    expect(document.head.querySelector("meta[data-public-link-noindex]")).toBeNull();
  });

  it("a file: its card with the scan line; no Preview when the owner turned previews off", async () => {
    await openPublic({ [`GET ${publicPath()}`]: info(publicFile(), { allowPreview: false }) });
    expect(await screen.findByRole("heading", { name: "report.txt" })).toBeTruthy();
    expect(screen.getByText("Scanned for viruses — nothing found.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });
});

describe("the password", () => {
  it("the form; a wrong one says so; the right one opens the link and the session goes with every call after", async () => {
    let open = false;
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: () =>
        json(open ? info(publicFile(), { requiresPassword: true }) : info(null, { requiresPassword: true })),
      [`POST ${publicPath("/unlock")}`]: (call) => {
        if ((call.body as { password: string }).password !== "made-up right one") {
          return envelope("password_required", 403, { wrongPassword: true, retryAfterSec: 0 });
        }
        open = true;
        return json(unlocked);
      },
      [`POST ${publicPath("/download-url")}`]: json(minted()),
    });
    expect(await screen.findByRole("heading", { name: "This link is protected" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "made-up wrong one" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("That password isn't right.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "made-up right one" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: "report.txt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(publicCalls(calls)).toContain("POST /download-url"));
    const mint = calls.find((call) => call.path === publicPath("/download-url"))!;
    expect(header(mint)).toBe(SESSION);
    // No cookie is ever the proof: the request names no credentials of its own.
    expect(Object.keys(mint.headers).map((name) => name.toLowerCase())).not.toContain("cookie");
  });

  it("locked out (429): the wait is said and Open stays off until it has passed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openPublic({
      [`GET ${publicPath()}`]: info(null, { requiresPassword: true }),
      [`POST ${publicPath("/unlock")}`]: envelope("rate_limited", 429, undefined, { "Retry-After": "5" }),
    });
    await screen.findByRole("heading", { name: "This link is protected" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "made-up guess" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText(/Too many tries\. Try again in [1-5] s\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(false),
    );
  });

  it("a password change while the page is open: the next call answers password_required → the form, the session dropped", async () => {
    let locked = false;
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: () =>
        json(
          locked ? info(null, { requiresPassword: true }) : info(publicFile(), { requiresPassword: true }),
        ),
      [`POST ${publicPath("/download-url")}`]: () => {
        locked = true;
        return passwordRequired();
      },
    });
    await screen.findByRole("heading", { name: "report.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("heading", { name: "This link is protected" })).toBeTruthy();
    // Exactly one refused mint; the page did not ask again.
    expect(publicCalls(calls).filter((call) => call === "POST /download-url")).toHaveLength(1);
  });
});

describe("the preview's source while locked", () => {
  it("four rejected proactive getUrl calls (15, 30, 60 s apart): one request, the page told once", async () => {
    vi.useFakeTimers();
    const calls = mockFetchCalls(() => passwordRequired());
    const client = new LinkClient(TOKEN);
    const told = vi.fn();
    client.subscribe(told);
    const source = client.source();
    const results: unknown[] = [];
    for (const wait of [0, 15_000, 30_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(wait);
      results.push(await source.getUrl(FILE_ID, "inline").catch((error: unknown) => error));
    }
    expect(results).toHaveLength(4);
    for (const result of results) expect(result).toMatchObject({ code: "password_required", status: 403 });
    expect(calls.filter((call) => call.path === publicPath("/download-url"))).toHaveLength(1);
    expect(told).toHaveBeenCalledTimes(1);
    expect(client.isLocked()).toBe(true);
  });

  it("control: without the lock every retry would be a request", async () => {
    const calls = mockFetchCalls(() => json(minted("i")));
    const source = new LinkClient(TOKEN).source();
    for (let i = 0; i < 4; i++) await source.getUrl(FILE_ID, "inline");
    expect(calls.filter((call) => call.path === publicPath("/download-url"))).toHaveLength(4);
  });

  it("the preview asks inline (never download) and sends the session; getItem answers from the page's own listing", async () => {
    const calls = mockFetchCalls((call) => {
      if (call.path === publicPath())
        return json(info(publicFile({ mimeCategory: "image", ext: "png", name: "p.png" })));
      if (call.path === publicPath("/unlock")) return json(unlocked);
      return json(minted("i"));
    });
    const client = new LinkClient(TOKEN);
    await client.info();
    await client.unlock("made-up");
    const source = client.source();
    expect(await source.getItem(FILE_ID)).toMatchObject({
      id: FILE_ID,
      name: "p.png",
      mimeCategory: "image",
    });
    await expect(source.getItem("0199d3c2-7a10-7000-8000-00000000eeee")).rejects.toMatchObject({
      status: 404,
    });
    await source.getUrl(FILE_ID, "thumb", 320);
    const mints = calls.filter((call) => call.path === publicPath("/download-url"));
    expect(mints.map((call) => call.body)).toEqual([{ nodeId: FILE_ID, kind: "thumb", size: 320 }]);
    expect(header(mints[0]!)).toBe(SESSION);
  });
});

describe("the preview", () => {
  it("a public PNG previews in the image viewer (the detected type travels with the node)", async () => {
    await preloadRenderers();
    const png = publicFile({ name: "p.png", mimeCategory: "image", ext: "png", mimeSniffed: "image/png" });
    await openPublic({
      [`GET ${publicPath()}`]: info(png),
      [`POST ${publicPath("/download-url")}`]: json(minted("i")),
    });
    await screen.findByRole("heading", { name: "p.png" });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(document.querySelector("[data-preview-renderer]")?.getAttribute("data-preview-renderer")).toBe(
        "image",
      ),
    );
  });
});

describe("downloads", () => {
  it("a dangerous type: the interstitial first (T22's stub passes through), and the one mint carries dangerousAck", async () => {
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFile({ name: "setup.exe", ext: "exe" }), { dangerous: true }),
      [`POST ${publicPath("/download-url")}`]: json(minted()),
    });
    await screen.findByRole("heading", { name: "setup.exe" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(publicCalls(calls)).toContain("POST /download-url"));
    const mints = calls.filter((call) => call.path === publicPath("/download-url"));
    expect(mints.map((call) => call.body)).toEqual([
      { nodeId: FILE_ID, kind: "download", dangerousAck: true },
    ]);
  });

  it("at today's limit (429 ceiling_exceeded): 'try again tomorrow', nothing paused-looking", async () => {
    await openPublic({
      [`GET ${publicPath()}`]: info(publicFile()),
      [`POST ${publicPath("/download-url")}`]: envelope(
        "ceiling_exceeded",
        429,
        { kind: "download_link", dimension: "count" },
        { "Retry-After": "3600" },
      ),
    });
    await screen.findByRole("heading", { name: "report.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(
      await screen.findByText("This link has reached today's download limit. Try again tomorrow."),
    ).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
  });
});

describe("a folder", () => {
  const children = (items: unknown[]) => ({ items, nextCursor: null });
  const files = [
    publicFile({ id: "0199d3c2-7a10-7000-8000-0000000000a1", name: "a.txt" }),
    publicFile({ id: "0199d3c2-7a10-7000-8000-0000000000a2", name: "b.txt" }),
  ];
  const manifest = {
    entries: files.map((file) => ({
      nodeId: file.id,
      path: `Holiday/${file.name}`,
      size: 3,
      etag: "e",
      modifiedAt: "2099-01-01T00:00:00.000Z",
    })),
    totalBytes: 6,
    skipped: [
      { nodeId: "0199d3c2-7a10-7000-8000-0000000000a3", path: "Holiday/held.bin", reason: "unavailable" },
    ],
    truncated: false,
    zipGrant: "made-up-grant",
  };

  /** `POST …/download-urls`: a URL for every node asked, under the grant. */
  const batchOk = (call: MockCall) => {
    const body = call.body as { nodeIds: string[]; zipGrant: string };
    expect(body.zipGrant).toBe("made-up-grant");
    return json({ items: body.nodeIds.map((nodeId) => ({ nodeId, ...minted("d", nodeId) })) });
  };
  const cleanManifest = { ...manifest, skipped: [] };

  it("lists its files; Download all mints the window in ONE request under the grant, and saves one zip", async () => {
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFolder()),
      [`GET ${publicPath("/children")}`]: children(files),
      [`POST ${publicPath("/zip-manifest")}`]: cleanManifest,
      [`POST ${publicPath("/download-urls")}`]: batchOk,
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a1/made-up-token": () => new Response("aaa"),
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a2/made-up-token": () => new Response("bbb"),
    });
    const list = await screen.findByRole("list", { name: "Files in Holiday" });
    expect(await within(list).findByText("a.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    expect(await screen.findByText("Zip saved.")).toBeTruthy();
    expect(saved).toHaveLength(1);
    expect(publicCalls(calls)).toEqual([
      "GET /",
      "GET /children",
      "POST /zip-manifest",
      "POST /download-urls",
    ]);
    const batch = calls.find((call) => call.path === publicPath("/download-urls"))!;
    expect(batch.body).toEqual({ zipGrant: "made-up-grant", nodeIds: files.map((file) => file.id) });
  });

  it("a 120-file folder zips without meeting the per-address limit: 1 manifest + 3 batches, no single mint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const many = Array.from({ length: 120 }, (_, i) =>
      publicFile({ id: `0199d3c2-7a10-7000-8001-${String(i).padStart(12, "0")}`, name: `f${i}.txt` }),
    );
    // RL_LINKS as the Worker applies it: 30 public requests a minute from this address, then 429.
    let used = 0;
    const limited = (answer: (call: MockCall) => Response) => (call: MockCall) =>
      ++used > 30 ? envelope("rate_limited", 429, undefined, { "Retry-After": "60" }) : answer(call);
    const files: Record<string, (call: MockCall) => Response> = {};
    for (const file of many) files[`GET /d/${file.id}/made-up-token`] = () => new Response("abc");
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: limited(() => json(info(publicFolder()))),
      [`GET ${publicPath("/children")}`]: limited(() => json(children(many.slice(0, 2)))),
      [`POST ${publicPath("/zip-manifest")}`]: limited(() =>
        json({
          ...cleanManifest,
          entries: many.map((file) => ({
            nodeId: file.id,
            path: `Holiday/${file.name}`,
            size: 3,
            etag: "e",
            modifiedAt: "2099-01-01T00:00:00.000Z",
          })),
          totalBytes: 360,
        }),
      ),
      [`POST ${publicPath("/download-urls")}`]: limited(batchOk),
      [`POST ${publicPath("/download-url")}`]: limited((call) =>
        json(minted("d", (call.body as { nodeId: string }).nodeId)),
      ),
      ...files,
    });
    await screen.findByRole("button", { name: "Download all as zip" });
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    // Well inside a minute: no limiter wait at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("Zip saved.")).toBeTruthy();
    const seen = publicCalls(calls);
    expect(seen.filter((call) => call === "POST /download-urls")).toHaveLength(3);
    expect(seen.filter((call) => call === "POST /download-url")).toHaveLength(0);
    expect(used).toBeLessThanOrEqual(30);
  });

  it("progress re-renders while the files arrive do not cancel the zip", async () => {
    const first = deferred<Response>();
    await openPublic({
      [`GET ${publicPath()}`]: info(publicFolder()),
      [`GET ${publicPath("/children")}`]: children(files),
      [`POST ${publicPath("/zip-manifest")}`]: cleanManifest,
      [`POST ${publicPath("/download-urls")}`]: batchOk,
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a1/made-up-token": () => first.promise,
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a2/made-up-token": () => new Response("bbb"),
    });
    await screen.findByRole("button", { name: "Download a.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    // The page draws its progress while the first file is still on its way.
    expect(await screen.findByText(/Making the zip… [0-9]+ of 2/)).toBeTruthy();
    await act(async () => first.resolve(new Response("aaa")));
    expect(await screen.findByText(/^Zip saved\./)).toBeTruthy();
    expect(saved).toHaveLength(1);
  });

  it("the per-address limit (429 rate_limited) on a batch: the zip waits as told and saves complete", async () => {
    let refused = 0;
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFolder()),
      [`GET ${publicPath("/children")}`]: children(files),
      [`POST ${publicPath("/zip-manifest")}`]: cleanManifest,
      [`POST ${publicPath("/download-urls")}`]: (call) => {
        if (refused === 0) {
          refused += 1;
          return envelope("rate_limited", 429, undefined, { "Retry-After": "1" });
        }
        return batchOk(call);
      },
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a1/made-up-token": () => new Response("aaa"),
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a2/made-up-token": () => new Response("bbb"),
    });
    await screen.findByRole("button", { name: "Download a.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    expect(await screen.findByText("Zip saved.", undefined, { timeout: 5_000 })).toBeTruthy();
    expect(refused).toBe(1);
    expect(calls.filter((call) => call.path === publicPath("/download-urls"))).toHaveLength(2);
  });

  it("a dangerous file in the window: the interstitial first, then its URL is asked again with the ack", async () => {
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFolder()),
      [`GET ${publicPath("/children")}`]: children(files),
      [`POST ${publicPath("/zip-manifest")}`]: cleanManifest,
      [`POST ${publicPath("/download-urls")}`]: (call) => {
        const body = call.body as { nodeIds: string[]; dangerousAck?: boolean };
        return json({
          items: body.nodeIds.map((nodeId) =>
            nodeId === files[1]!.id && !body.dangerousAck
              ? { nodeId, error: "forbidden" }
              : { nodeId, ...minted("d", nodeId) },
          ),
        });
      },
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a1/made-up-token": () => new Response("aaa"),
      "GET /d/0199d3c2-7a10-7000-8000-0000000000a2/made-up-token": () => new Response("bbb"),
    });
    await screen.findByRole("button", { name: "Download a.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    expect(await screen.findByText("Zip saved.")).toBeTruthy();
    const batches = calls
      .filter((call) => call.path === publicPath("/download-urls"))
      .map((call) => call.body);
    expect(batches).toEqual([
      { zipGrant: "made-up-grant", nodeIds: files.map((file) => file.id) },
      { zipGrant: "made-up-grant", nodeIds: [files[1]!.id], dangerousAck: true },
    ]);
  });

  it("a password change while the zip runs: it stops at the next batch, saves NOTHING, and the form shows", async () => {
    let batches = 0;
    await openPublic({
      [`GET ${publicPath()}`]: () =>
        json(batches > 0 ? info(null, { requiresPassword: true }) : info(publicFolder())),
      [`GET ${publicPath("/children")}`]: children(files),
      [`POST ${publicPath("/zip-manifest")}`]: cleanManifest,
      [`POST ${publicPath("/download-urls")}`]: () => {
        batches += 1;
        return passwordRequired();
      },
    });
    await screen.findByRole("button", { name: "Download a.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    expect(await screen.findByRole("heading", { name: "This link is protected" })).toBeTruthy();
    expect(saved).toHaveLength(0);
    expect(batches).toBe(1);
  });

  it("five simulated minutes with a preview open and a zip in progress: no polling, one window of mints, no retry storm", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await preloadRenderers();
    const image = publicFile({
      id: "0199d3c2-7a10-7000-8000-0000000000b1",
      name: "p.png",
      mimeCategory: "image",
      ext: "png",
      mimeSniffed: "image/png",
    });
    const many = Array.from({ length: 70 }, (_, i) =>
      publicFile({ id: `0199d3c2-7a10-7000-8000-${String(i).padStart(12, "0")}`, name: `f${i}.txt` }),
    );
    const { calls } = await openPublic({
      [`GET ${publicPath()}`]: info(publicFolder()),
      [`GET ${publicPath("/children")}`]: children([image, ...many]),
      [`POST ${publicPath("/zip-manifest")}`]: {
        ...manifest,
        entries: many.map((file) => ({
          nodeId: file.id,
          path: `Holiday/${file.name}`,
          size: 3,
          etag: "e",
          modifiedAt: "2099-01-01T00:00:00.000Z",
        })),
        skipped: [],
      },
      [`POST ${publicPath("/download-urls")}`]: batchOk,
      [`POST ${publicPath("/download-url")}`]: (call) =>
        json(minted("i", (call.body as { nodeId: string }).nodeId)),
      // The files host never answers the first file: the zip is in progress for the whole time.
      [`GET /d/${many[0]!.id}/made-up-token`]: () => new Promise<Response>(() => {}),
    });
    await screen.findByRole("button", { name: "Preview p.png" });
    // The zip first: the preview is a modal dialog, and the page under it is hidden from then on.
    fireEvent.click(screen.getByRole("button", { name: "Download all as zip" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview p.png" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    const seen = publicCalls(calls);
    expect(seen.filter((call) => call === "GET /")).toHaveLength(1);
    expect(seen.filter((call) => call === "GET /children")).toHaveLength(1);
    expect(seen.filter((call) => call === "POST /zip-manifest")).toHaveLength(1);
    const previewMints = calls.filter((call) => call.path === publicPath("/download-url"));
    const zipBatches = calls.filter((call) => call.path === publicPath("/download-urls"));
    // One window (ZIP_URL_BATCH = 50) minted in one request, the next not before the first file arrived.
    expect(zipBatches).toHaveLength(1);
    expect((zipBatches[0]!.body as { nodeIds: string[] }).nodeIds).toHaveLength(50);
    // The preview's URL is minted once and not refreshed within five minutes (80 % of 15 min).
    // The one URL of the open preview: its proactive refresh is due only at 80 % of 15 min.
    expect(previewMints.map((call) => call.body)).toEqual([
      { nodeId: "0199d3c2-7a10-7000-8000-0000000000b1", kind: "inline" },
    ]);
    expect(seen.length).toBeLessThanOrEqual(3 + 1 + 1);
    void FOLDER_ID;
  });
});
