// Minting files-host URLs: the download matrix row by row, the tokens, the timestamps, the audit
// rows, thumbnails, and the owner's "last opened" mark.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PREVIEW_TEXT_MAX_BYTES, THUMB_INPUT_MAX_BYTES, TOKEN_TTL } from "../../../src/shared/constants";
import { Timestamp } from "../../../src/shared/schemas/common";
import {
  BatchDownloadUrlsResponse,
  DownloadUrlResponse,
  ThumbUrlResponse,
} from "../../../src/shared/schemas/node";
import { nodes, type ScanStatus } from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import { verifyDownloadToken, type TokenKind } from "../../../src/worker/services/tokens";
import { TEST_FILES_ORIGIN, testVars } from "../../setup/test-vars";
import {
  api,
  auditFor,
  auditRows,
  impersonated,
  makeFile,
  makeFolder,
  manyFiles,
  nodeById,
  person,
  setStatus,
  sharedTree,
  takeDown,
  testDb,
  type Caller,
} from "./helpers";

const keys = () => createKeys(testVars.FILES_TOKEN_SECRET);
const mint = (caller: Caller, nodeId: string, kind: "download" | "inline") =>
  api(caller, "POST", `/nodes/${nodeId}/download-url`, { body: { kind } });

/** The claims of the token in a files-host URL, verified for the route the URL names. */
async function claimsOf(url: string) {
  const [, letter, nodeId, ...rest] = new URL(url).pathname.split("/");
  expect(new URL(url).origin).toBe(TEST_FILES_ORIGIN);
  const kind = ({ d: "download", i: "inline", t: "thumb" } as Record<string, TokenKind>)[letter!]!;
  const size = kind === "thumb" ? Number(rest[0]) : undefined;
  const token = rest[rest.length - 1]!;
  return verifyDownloadToken(keys(), token, { kind, nodeId: nodeId!, size });
}

const STATUSES: ScanStatus[] = [
  "pending",
  "clean",
  "infected",
  "under_review",
  "skipped",
  "error",
  "suspected_csam",
];

describe("the download-url matrix", () => {
  it("row 1 — an impersonated session: 403 forbidden on download-url, download-urls, zip-manifest and thumb-url", async () => {
    const t = await sharedTree();
    const admin = impersonated(t.owner);
    const answers = [
      await mint(admin, t.notes.id, "download"),
      await mint(admin, t.notes.id, "inline"),
      await api(admin, "POST", "/nodes/download-urls", { body: { nodeIds: [t.notes.id] } }),
      await api(admin, "POST", "/nodes/zip-manifest", { body: { nodeIds: [t.inner.id] } }),
      await api(admin, "POST", "/nodes/zip-manifest", { body: { allOwned: true } }),
      await api(admin, "GET", `/nodes/${t.photo.id}/thumb-url?size=320`),
    ];
    for (const answer of answers) {
      expect([answer.status, answer.body.error]).toEqual([403, "forbidden"]);
      expect(answer.body.details).toEqual({ reason: "impersonation_read_only" });
      expect(JSON.stringify(answer.body)).not.toContain(TEST_FILES_ORIGIN);
    }
    expect(await auditFor("file.download", t.notes.id)).toEqual([]);
    // Reading the tree is still allowed through that session; and the same person, signed in
    // themselves, gets the thumbnail URL.
    expect((await api(admin, "GET", `/nodes/${t.notes.id}`)).status).toBe(200);
    expect((await api(t.owner.as, "GET", `/nodes/${t.photo.id}/thumb-url?size=320`)).status).toBe(200);
  });

  it("row 2 — no role, a missing node, a folder, a trashed node, a system node: 404 not_found", async () => {
    const t = await sharedTree();
    const trashedFolder = await makeFolder(t.owner.id, t.shared.id, {
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const inTrash = await makeFile(t.owner.id, trashedFolder.id, { scanStatus: "clean" });
    const trashed = await makeFile(t.owner.id, t.inner.id, {
      scanStatus: "clean",
      deletedAt: new Date(),
      trashedRoot: true,
    });
    const avatar = await makeFile(t.owner.id, null, { scanStatus: "clean", system: "avatar" });
    const cases: [string, Caller, string][] = [
      ["no role", t.stranger.as, t.notes.id],
      ["a share never activated", t.invited.as, t.notes.id],
      ["missing", t.owner.as, crypto.randomUUID()],
      ["a folder", t.owner.as, t.inner.id],
      ["trashed", t.owner.as, trashed.id],
      ["under a trashed folder", t.owner.as, inTrash.id],
      ["under a trashed folder, as the editor", t.editor.as, inTrash.id],
      ["a system node", t.owner.as, avatar.id],
    ];
    for (const [label, caller, id] of cases) {
      for (const kind of ["download", "inline"] as const) {
        const answer = await mint(caller, id, kind);
        expect([answer.status, answer.body.error], label).toEqual([404, "not_found"]);
      }
    }
  });

  it("row 2/3 — taken down or suspected_csam: 404 for the owner too (from the permission lookup)", async () => {
    const t = await sharedTree();
    await takeDown(t.notes.id);
    await setStatus(t.photo.id, "suspected_csam");
    for (const caller of [t.owner.as, t.editor.as, t.viewer.as]) {
      for (const id of [t.notes.id, t.photo.id]) {
        const answer = await mint(caller, id, "download");
        expect([answer.status, answer.body.error]).toEqual([404, "not_found"]);
      }
    }
  });

  it("row 4 — pending: 409 scan_pending", async () => {
    const t = await sharedTree();
    await setStatus(t.notes.id, "pending");
    for (const caller of [t.owner.as, t.viewer.as]) {
      for (const kind of ["download", "inline"] as const) {
        const answer = await mint(caller, t.notes.id, kind);
        expect([answer.status, answer.body.error]).toEqual([409, "scan_pending"]);
      }
    }
  });

  it("row 5 — infected / under_review: 403 scan_blocked", async () => {
    const t = await sharedTree();
    for (const status of ["infected", "under_review"] as const) {
      await setStatus(t.notes.id, status);
      for (const caller of [t.owner.as, t.viewer.as]) {
        for (const kind of ["download", "inline"] as const) {
          const answer = await mint(caller, t.notes.id, kind);
          expect([answer.status, answer.body.error], status).toEqual([403, "scan_blocked"]);
        }
      }
    }
  });

  it("row 6 — skipped / error: the owner's download is minted with warning 'unscanned'; inline and anyone else: 403 scan_blocked", async () => {
    const t = await sharedTree();
    for (const status of ["skipped", "error"] as const) {
      await setStatus(t.notes.id, status);
      const mine = await mint(t.owner.as, t.notes.id, "download");
      expect(mine.status).toBe(200);
      expect(DownloadUrlResponse.parse(mine.body).warning).toBe("unscanned");
      expect((await claimsOf(mine.body.url)).k).toBe("download");
      for (const [caller, kind] of [
        [t.owner.as, "inline"],
        [t.editor.as, "download"],
        [t.viewer.as, "download"],
        [t.viewer.as, "inline"],
      ] as const) {
        const answer = await mint(caller, t.notes.id, kind);
        expect([answer.status, answer.body.error], `${status} ${kind}`).toEqual([403, "scan_blocked"]);
      }
    }
  });

  it("row 7 — inline for a type that may not be shown inline: 403 forbidden; minted for a PDF and a small text file", async () => {
    const owner = await person();
    const file = (name: string, mimeSniffed: string | null, size = 1_000) =>
      makeFile(owner.id, null, { name, mimeSniffed, size, scanStatus: "clean" });
    const allowed = [
      await file("paper.pdf", "application/pdf", 40_000_000),
      await file("notes.txt", "text/plain"),
      await file("exactly at the limit.txt", "text/plain", PREVIEW_TEXT_MAX_BYTES),
      await file("photo.jpg", "image/jpeg"),
      await file("clip.mp4", "video/mp4", 900_000_000),
    ];
    const refused = [
      await file("page.html", "text/html"),
      await file("drawing.svg", "image/svg+xml"),
      await file("feed.xml", "application/xml"),
      await file("too long.txt", "text/plain", PREVIEW_TEXT_MAX_BYTES + 1),
      await file("unknown.bin", null),
      await file("program.exe", "application/x-msdownload"),
    ];
    for (const node of allowed) {
      const answer = await mint(owner.as, node.id, "inline");
      expect(answer.status, node.name).toBe(200);
      expect(new URL(answer.body.url).pathname.startsWith(`/i/${node.id}/`)).toBe(true);
      expect("warning" in answer.body).toBe(false);
    }
    for (const node of refused) {
      const answer = await mint(owner.as, node.id, "inline");
      expect([answer.status, answer.body.error], node.name).toEqual([403, "forbidden"]);
      // The same file as a download is fine.
      expect((await mint(owner.as, node.id, "download")).status, node.name).toBe(200);
    }
  });

  it("row 8 — clean: minted, for the owner and for anyone it is shared with", async () => {
    const t = await sharedTree();
    for (const who of [t.owner, t.editor, t.viewer]) {
      for (const kind of ["download", "inline"] as const) {
        const answer = await mint(who.as, t.notes.id, kind);
        expect(answer.status).toBe(200);
        const body = DownloadUrlResponse.parse(answer.body);
        expect("warning" in body).toBe(false);
        const claims = await claimsOf(body.url);
        expect(claims).toMatchObject({
          k: kind,
          n: t.notes.id,
          ver: t.notes.versionId,
          st: "u",
          sub: who.id,
        });
      }
    }
  });

  it.each(["owner", "viewer"] as const)("all seven statuses × both kinds, as the %s", async (who) => {
    const t = await sharedTree();
    const expected = (status: ScanStatus, kind: "download" | "inline") => {
      if (status === "suspected_csam") return "404 not_found";
      if (status === "pending") return "409 scan_pending";
      if (status === "clean") return "200";
      if ((status === "skipped" || status === "error") && who === "owner" && kind === "download")
        return "200 unscanned";
      return "403 scan_blocked";
    };
    for (const status of STATUSES) {
      await setStatus(t.notes.id, status);
      for (const kind of ["download", "inline"] as const) {
        const answer = await mint(t[who].as, t.notes.id, kind);
        const got =
          answer.status === 200
            ? ["200", answer.body.warning].filter(Boolean).join(" ")
            : `${answer.status} ${answer.body.error}`;
        expect(got, `${status} ${kind}`).toBe(expected(status, kind));
      }
    }
  });

  it("refuses a body it does not know", async () => {
    const t = await sharedTree();
    for (const body of [{}, { kind: "thumb" }, { kind: "download", ttl: 9999 }]) {
      const answer = await api(t.owner.as, "POST", `/nodes/${t.notes.id}/download-url`, { body });
      expect([answer.status, answer.body.error], JSON.stringify(body)).toEqual([400, "validation"]);
    }
  });
});

describe("what a mint answers", () => {
  it("expiresAt is an ISO timestamp, and it is the token's own expiry — download, inline, thumb and each batch item", async () => {
    const t = await sharedTree();
    const before = Math.floor(Date.now() / 1000);
    const download = await mint(t.owner.as, t.notes.id, "download");
    const inline = await mint(t.owner.as, t.notes.id, "inline");
    const thumb = await api(t.owner.as, "GET", `/nodes/${t.photo.id}/thumb-url?size=160`);
    const batch = await api(t.owner.as, "POST", "/nodes/download-urls", {
      body: { nodeIds: [t.notes.id, t.photo.id] },
    });
    const after = Math.floor(Date.now() / 1000);

    DownloadUrlResponse.parse(download.body);
    DownloadUrlResponse.parse(inline.body);
    ThumbUrlResponse.parse(thumb.body);
    BatchDownloadUrlsResponse.parse(batch.body);
    const minted: { url: string; expiresAt: string }[] = [
      download.body,
      inline.body,
      thumb.body,
      ...batch.body.items,
    ];
    for (const item of minted) {
      expect(typeof item.expiresAt).toBe("string");
      Timestamp.parse(item.expiresAt);
      expect(Date.parse(item.expiresAt)).toBe((await claimsOf(item.url)).exp * 1000);
    }
    const lifetime = async (url: string) => (await claimsOf(url)).exp;
    expect(await lifetime(download.body.url)).toBeGreaterThanOrEqual(before + TOKEN_TTL.download);
    expect(await lifetime(download.body.url)).toBeLessThanOrEqual(after + TOKEN_TTL.download);
    expect(await lifetime(inline.body.url)).toBeGreaterThanOrEqual(before + TOKEN_TTL.inline);
    expect(await lifetime(inline.body.url)).toBeLessThanOrEqual(after + TOKEN_TTL.inline);
    // The batch is for a zip: its own lifetime, not the single download's.
    for (const item of batch.body.items) {
      expect(await lifetime(item.url)).toBeGreaterThanOrEqual(before + TOKEN_TTL.zip);
      expect(await lifetime(item.url)).toBeLessThanOrEqual(after + TOKEN_TTL.zip);
    }
  });

  it("a token is for one node, one kind and one version: it does not verify as anything else", async () => {
    const t = await sharedTree();
    const { url } = (await mint(t.viewer.as, t.notes.id, "download")).body;
    const token = url.split("/").pop()!;
    await expect(
      verifyDownloadToken(keys(), token, { kind: "inline", nodeId: t.notes.id }),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      verifyDownloadToken(keys(), token, { kind: "download", nodeId: t.photo.id }),
    ).rejects.toMatchObject({ code: "invalid_token" });
    expect(url).not.toContain(t.notes.r2Key!);
  });
});

describe("file.download: one audit row per download that was authorised", () => {
  it("two download mints → two rows (the user, the node, the size); an inline mint and a thumb mint → none", async () => {
    const t = await sharedTree();
    await mint(t.viewer.as, t.notes.id, "download");
    await mint(t.viewer.as, t.notes.id, "download");
    const rows = await auditFor("file.download", t.notes.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([row.actorUserId, row.actorType, row.targetType, row.meta]).toEqual([
        t.viewer.id,
        "user",
        "node",
        { size: t.notes.size },
      ]);
    }

    expect((await mint(t.owner.as, t.photo.id, "inline")).status).toBe(200);
    expect((await api(t.owner.as, "GET", `/nodes/${t.photo.id}/thumb-url?size=320`)).status).toBe(200);
    for (const action of ["file.download", "node.download_url", "file.inline", "file.thumb"]) {
      expect(await auditFor(action, t.photo.id), action).toEqual([]);
    }
    // Nothing at all was written about the photo by those two requests.
    const all = await testDb().query.auditLog.findMany({
      where: (log, { eq: is }) => is(log.targetId, t.photo.id),
    });
    expect(all).toEqual([]);
  });

  it("download-urls for three nodes → three rows with zip: true", async () => {
    const t = await sharedTree();
    const third = await makeFile(t.owner.id, t.inner.id, { scanStatus: "clean" });
    const ids = [t.notes.id, t.photo.id, third.id];
    const answer = await api(t.editor.as, "POST", "/nodes/download-urls", { body: { nodeIds: ids } });
    expect(answer.body.items.map((item: { nodeId: string }) => item.nodeId)).toEqual(ids);
    for (const node of [t.notes, t.photo, third]) {
      const rows = await auditFor("file.download", node.id);
      expect(rows.map((row) => [row.actorUserId, row.meta])).toEqual([
        [t.editor.id, { size: node.size, zip: true }],
      ]);
    }
  });

  it("a refused mint writes none: scan_pending, scan_blocked, no role, impersonation", async () => {
    const t = await sharedTree();
    await setStatus(t.notes.id, "pending");
    await setStatus(t.photo.id, "infected");
    expect((await mint(t.owner.as, t.notes.id, "download")).status).toBe(409);
    expect((await mint(t.owner.as, t.photo.id, "download")).status).toBe(403);
    expect((await mint(t.stranger.as, t.secret.id, "download")).status).toBe(404);
    expect((await mint(impersonated(t.owner), t.secret.id, "download")).status).toBe(403);
    const batch = await api(t.owner.as, "POST", "/nodes/download-urls", {
      body: { nodeIds: [t.notes.id, t.photo.id] },
    });
    expect(batch.body.items).toEqual([
      { nodeId: t.notes.id, error: "scan_pending" },
      { nodeId: t.photo.id, error: "scan_blocked" },
    ]);
    for (const node of [t.notes, t.photo, t.secret])
      expect(await auditFor("file.download", node.id)).toEqual([]);
  });

  it("no row with the retired action is ever written", async () => {
    const t = await sharedTree();
    await mint(t.owner.as, t.notes.id, "download");
    expect(await auditRows({ action: "node.download_url", actorUserId: t.owner.id })).toEqual([]);
  });
});

describe("download-urls (the zip batch)", () => {
  it("answers per node, in the order asked: a URL, or the code its download would be refused with", async () => {
    const t = await sharedTree();
    const pending = await makeFile(t.owner.id, t.inner.id, { scanStatus: "pending" });
    const unknown = crypto.randomUUID();
    const ids = [t.notes.id, pending.id, t.inner.id, unknown, t.broken.id, t.secret.id];
    const mine = await api(t.owner.as, "POST", "/nodes/download-urls", { body: { nodeIds: ids } });
    expect(mine.status).toBe(200);
    BatchDownloadUrlsResponse.parse(mine.body);
    const summary = (items: { nodeId: string; url?: string; error?: string }[]) =>
      items.map((item) => [item.nodeId, item.url ? "url" : item.error]);
    expect(summary(mine.body.items)).toEqual([
      [t.notes.id, "url"],
      [pending.id, "scan_pending"],
      [t.inner.id, "not_found"],
      [unknown, "not_found"],
      // The owner's own unscanned file: the same rule as a single download.
      [t.broken.id, "url"],
      [t.secret.id, "url"],
    ]);
    const theirs = await api(t.viewer.as, "POST", "/nodes/download-urls", { body: { nodeIds: ids } });
    expect(summary(theirs.body.items)).toEqual([
      [t.notes.id, "url"],
      [pending.id, "scan_pending"],
      [t.inner.id, "not_found"],
      [unknown, "not_found"],
      [t.broken.id, "scan_blocked"],
      [t.secret.id, "not_found"],
    ]);
    for (const item of [...mine.body.items, ...theirs.body.items]) {
      if (!item.url) continue;
      expect(new URL(item.url).pathname.startsWith(`/d/${item.nodeId}/`)).toBe(true);
      expect(await claimsOf(item.url)).toMatchObject({ k: "download", st: "u" });
    }
  });

  it("a full window of 50 files: 50 URLs and 50 audit rows (none is dropped by the request's own bounds)", async () => {
    const owner = await person();
    const folder = await makeFolder(owner.id);
    await manyFiles(owner.id, folder.id, 50);
    const listed = await api(owner.as, "GET", `/nodes/${folder.id}/children?limit=50`);
    const ids: string[] = listed.body.items.map((item: { id: string }) => item.id);
    expect(ids).toHaveLength(50);
    const answer = await api(owner.as, "POST", "/nodes/download-urls", { body: { nodeIds: ids } });
    expect(
      answer.body.items.map((item: { nodeId: string; url?: string }) => [item.nodeId, typeof item.url]),
    ).toEqual(ids.map((id) => [id, "string"]));
    const rows = (await auditRows({ action: "file.download", actorUserId: owner.id })).filter((row) =>
      ids.includes(row.targetId!),
    );
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((row) => row.targetId)).size).toBe(50);
  });

  it("takes 1 to 50 ids", async () => {
    const t = await sharedTree();
    const ids = (count: number) => Array.from({ length: count }, () => crypto.randomUUID());
    for (const body of [
      { nodeIds: [] },
      { nodeIds: ids(51) },
      { nodeIds: ["x"] },
      {},
      { nodeIds: ids(1), kind: "inline" },
    ]) {
      const answer = await api(t.owner.as, "POST", "/nodes/download-urls", { body });
      expect([answer.status, answer.body.error]).toEqual([400, "validation"]);
    }
    const full = await api(t.owner.as, "POST", "/nodes/download-urls", { body: { nodeIds: ids(50) } });
    expect(full.status).toBe(200);
    expect(full.body.items).toHaveLength(50);
  });
});

describe("thumb-url", () => {
  it("a clean image: the URL names node and size, and the token carries the size and the user", async () => {
    const t = await sharedTree();
    for (const size of [160, 320, 1280]) {
      const answer = await api(t.viewer.as, "GET", `/nodes/${t.photo.id}/thumb-url?size=${size}`);
      expect(answer.status).toBe(200);
      const { url } = ThumbUrlResponse.parse(answer.body);
      expect(new URL(url).pathname.startsWith(`/t/${t.photo.id}/${size}/`)).toBe(true);
      expect(await claimsOf(url)).toMatchObject({
        k: "thumb",
        n: t.photo.id,
        ver: t.photo.versionId,
        st: "u",
        sub: t.viewer.id,
        sz: size,
      });
    }
    // The same viewer, node, version and size give the same URL: a browser cache keyed on it works.
    const again = async () =>
      (await api(t.viewer.as, "GET", `/nodes/${t.photo.id}/thumb-url?size=320`)).body.url;
    expect(await again()).toBe(await again());
  });

  it("only the three sizes", async () => {
    const t = await sharedTree();
    for (const query of ["", "?size=", "?size=100", "?size=320px", "?size=320&w=1", "?size=-320"]) {
      const answer = await api(t.owner.as, "GET", `/nodes/${t.photo.id}/thumb-url${query}`);
      expect([answer.status, answer.body.error], query).toEqual([400, "validation"]);
    }
  });

  it("pending → 409, infected / under_review → 403, anything without a thumbnail → 404", async () => {
    const owner = await person();
    const image = (overrides: Parameters<typeof makeFile>[2]) =>
      makeFile(owner.id, null, { mimeSniffed: "image/png", scanStatus: "clean", ...overrides });
    const ask = async (id: string) => {
      const answer = await api(owner.as, "GET", `/nodes/${id}/thumb-url?size=320`);
      return answer.status === 200 ? "200" : `${answer.status} ${answer.body.error}`;
    };
    expect(await ask((await image({})).id)).toBe("200");
    expect(await ask((await image({ size: THUMB_INPUT_MAX_BYTES })).id)).toBe("200");
    expect(await ask((await image({ scanStatus: "pending" })).id)).toBe("409 scan_pending");
    expect(await ask((await image({ scanStatus: "infected" })).id)).toBe("403 scan_blocked");
    expect(await ask((await image({ scanStatus: "under_review" })).id)).toBe("403 scan_blocked");
    expect(await ask((await image({ scanStatus: "skipped" })).id)).toBe("404 not_found");
    expect(await ask((await image({ scanStatus: "error" })).id)).toBe("404 not_found");
    expect(await ask((await image({ size: THUMB_INPUT_MAX_BYTES + 1 })).id)).toBe("404 not_found");
    expect(await ask((await image({ mimeSniffed: "text/plain" })).id)).toBe("404 not_found");
    expect(await ask((await image({ mimeSniffed: "image/svg+xml" })).id)).toBe("404 not_found");
    expect(await ask((await makeFolder(owner.id)).id)).toBe("404 not_found");
    expect(await ask(crypto.randomUUID())).toBe("404 not_found");
  });
});

describe("lastAccessedAt: what Recent orders by", () => {
  const openedAt = async (id: string) => (await nodeById(id))!.lastAccessedAt;

  it("set by the owner's download or inline mint, at most once per ten minutes", async () => {
    const t = await sharedTree();
    expect(await openedAt(t.notes.id)).toBeNull();
    await mint(t.owner.as, t.notes.id, "download");
    const first = await openedAt(t.notes.id);
    expect(first).not.toBeNull();
    await mint(t.owner.as, t.notes.id, "inline");
    await mint(t.owner.as, t.notes.id, "download");
    expect(await openedAt(t.notes.id)).toEqual(first);

    // Eleven minutes later (this test's own row is moved back; the statement's clock is the
    // database's): the next mint writes again.
    const earlier = new Date(Date.now() - 11 * 60_000);
    await testDb().update(nodes).set({ lastAccessedAt: earlier }).where(eq(nodes.id, t.notes.id));
    await mint(t.owner.as, t.notes.id, "inline");
    expect((await openedAt(t.notes.id))!.getTime()).toBeGreaterThan(earlier.getTime() + 10 * 60_000);

    // Nine minutes: not yet.
    const recent = new Date(Date.now() - 9 * 60_000);
    await testDb().update(nodes).set({ lastAccessedAt: recent }).where(eq(nodes.id, t.notes.id));
    await mint(t.owner.as, t.notes.id, "download");
    expect(await openedAt(t.notes.id)).toEqual(recent);
  });

  it("not by a share partner's mint, a thumbnail, a zip batch or a refused mint", async () => {
    const t = await sharedTree();
    await mint(t.editor.as, t.notes.id, "download");
    await mint(t.viewer.as, t.notes.id, "inline");
    await api(t.owner.as, "POST", "/nodes/download-urls", { body: { nodeIds: [t.notes.id, t.photo.id] } });
    await api(t.owner.as, "GET", `/nodes/${t.photo.id}/thumb-url?size=320`);
    await setStatus(t.broken.id, "infected");
    await mint(t.owner.as, t.broken.id, "download");
    for (const node of [t.notes, t.photo, t.broken]) expect(await openedAt(node.id)).toBeNull();
  });
});
