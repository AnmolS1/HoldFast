// Public mints: what is counted (the link's daily count, maxDownloads), the owner-cap preview, the
// password version on everything minted, zip grants and their binding, the audit row at mint,
// folder scoping, inherited takedown, the zip manifest. Every password here is made up.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pauseLinks } from "../../../src/worker/db/queries/links";
import { addUsage } from "../../../src/worker/db/queries/ledger";
import { nodes, shareLinks } from "../../../src/worker/db/schema";
import { ipHashStable } from "../../../src/worker/services/ip-hash";
import { linkPwv, mintZipGrant, NO_PASSWORD_PWV } from "../../../src/worker/services/tokens";
import { ask, storedFile } from "../files-host/harness";
import {
  api,
  asCaller,
  auditRows,
  envelope,
  errorOf,
  ledgerOf,
  linkById,
  mailTo,
  makeFile,
  makeFolder,
  makeShare,
  member,
  settingsWith,
  testDb,
  testKeys,
  utcDayOf,
} from "./helpers";
import { claimsOf, linkTo, mint, unlock, visit, type Member } from "./public-helpers";

const PASSWORD = "made-up visitor password";
const OTHER_PASSWORD = "another made-up password";
const X = "198.51.100.10";
const Y = "198.51.100.20";

const today = () => utcDayOf(new Date());
const tomorrowNoon = () => {
  const at = new Date();
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1, 12));
};
const pathOf = (url: string) => new URL(url).pathname;
const urlOf = (answer: { body: unknown }) => (answer.body as { url: string }).url;

async function imageFile(owner: Member, parentId: string | null = null, name = "photo.png") {
  return makeFile(owner.id, parentId, { scanStatus: "clean", name, mimeSniffed: "image/png", size: 2000 });
}

describe("pwv on everything minted", () => {
  it("download, inline and thumb carry the link's current pwv; a link with no password carries NO_PASSWORD_PWV", async () => {
    const owner = await member();
    const file = await imageFile(owner);
    const locked = await linkTo(owner, file.id, { password: PASSWORD });
    const open = await linkTo(owner, file.id);
    const { session } = await unlock(locked.token, PASSWORD);
    const expected = await linkPwv((await linkById(locked.id)).passwordHash);
    expect(expected).not.toBe(NO_PASSWORD_PWV);
    for (const body of [{ kind: "download" }, { kind: "inline" }, { kind: "thumb", size: 320 }]) {
      const minted = await mint(locked.token, body, { session });
      expect(minted.status, body.kind).toBe(200);
      expect(claimsOf(urlOf(minted)), body.kind).toMatchObject({
        st: "l",
        sub: locked.id,
        pwv: expected,
        k: body.kind,
      });
      const plain = await mint(open.token, body);
      expect(claimsOf(urlOf(plain)), body.kind).toMatchObject({
        st: "l",
        sub: open.id,
        pwv: NO_PASSWORD_PWV,
      });
    }
  });

  it("the lifecycle: create → unlock → mint → revoke → 410; a password change ends open sessions", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await linkTo(owner, file.id, { password: PASSWORD });
    const { session } = await unlock(link.token, PASSWORD);
    expect((await mint(link.token, { kind: "download" }, { session })).status).toBe(200);
    await api(asCaller(owner), `/links/${link.id}`, { method: "PATCH", json: { password: OTHER_PASSWORD } });
    const stale = await mint(link.token, { kind: "download" }, { session });
    expect([stale.status, errorOf(stale).error]).toEqual([403, "password_required"]);
    expect(((await visit(link.token, "", { session })).body as { node: unknown }).node).toBeNull();
    const { session: fresh } = await unlock(link.token, OTHER_PASSWORD);
    expect((await mint(link.token, { kind: "download" }, { session: fresh })).status).toBe(200);
    expect((await api(asCaller(owner), `/links/${link.id}`, { method: "DELETE" })).status).toBe(204);
    const gone = await mint(link.token, { kind: "download" }, { session: fresh });
    expect([gone.status, errorOf(gone).details?.reason]).toEqual([410, "revoked"]);
  });
});

describe("the public node", () => {
  it("carries the detected type the owner's NodeDto carries — the preview picks its viewer by it", async () => {
    const owner = await member();
    const file = await imageFile(owner);
    const folder = await makeFolder(owner.id);
    await makeFile(owner.id, folder.id, {
      scanStatus: "clean",
      name: "notes.txt",
      mimeSniffed: "text/plain",
    });
    const onFile = await linkTo(owner, file.id);
    const onFolder = await linkTo(owner, folder.id);
    const node = ((await visit(onFile.token)).body as { node: Record<string, unknown> }).node;
    const asOwner = (
      (await api(asCaller(owner), `/nodes/${file.id}`)).body as { node: Record<string, unknown> }
    ).node;
    expect(node.mimeSniffed).toBe("image/png");
    expect(node.mimeSniffed).toBe(asOwner.mimeSniffed);
    const listing = (await visit(onFolder.token, "/children")).body as { items: Record<string, unknown>[] };
    expect(listing.items.map((item) => item.mimeSniffed)).toEqual(["text/plain"]);
  });
});

describe("counting at mint", () => {
  it("download mints count; inline and thumb do not; at CEIL_LINK_DOWNLOADS_DAY the mint is 429, nothing paused, one mail; 429 again (never 423); the next day mints with nothing lifted", async () => {
    const owner = await member();
    const file = await imageFile(owner);
    const link = await linkTo(owner, file.id, { maxDownloads: 10 });
    const settings = settingsWith({ ceilings: { CEIL_LINK_DOWNLOADS_DAY: 2 } });
    expect((await mint(link.token, { kind: "download" }, { settings })).status).toBe(200);
    expect((await mint(link.token, { kind: "download" }, { settings })).status).toBe(200);
    expect((await mint(link.token, { kind: "inline" }, { settings })).status).toBe(200);
    expect((await mint(link.token, { kind: "thumb", size: 160 }, { settings })).status).toBe(200);
    expect((await ledgerOf("link", link.id, today())).count).toBe(2);
    expect((await linkById(link.id)).downloadCount).toBe(2);

    const third = await mint(link.token, { kind: "download" }, { settings });
    expect([third.status, errorOf(third).error, errorOf(third).details]).toEqual([
      429,
      "ceiling_exceeded",
      { kind: "download_link", dimension: "count" },
    ]);
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    const row = await linkById(link.id);
    expect([row.downloadCount, row.pauseReasons, row.pausedAt]).toEqual([2, [], null]);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
    const listed = (
      (await api(asCaller(owner), "/links/mine", { settings })).body as Record<string, unknown>[]
    ).find((dto) => dto.id === link.id);
    expect(listed).toMatchObject({ limitedToday: true, pausedReasons: [], state: "active" });

    const fourth = await mint(link.token, { kind: "download" }, { settings });
    expect([fourth.status, errorOf(fourth).error]).toEqual([429, "ceiling_exceeded"]);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);

    const next = { "x-holdfast-test-now": tomorrowNoon().toISOString() };
    const tomorrow = (
      (await api(asCaller(owner), "/links/mine", { settings, headers: next })).body as Record<
        string,
        unknown
      >[]
    ).find((dto) => dto.id === link.id);
    expect(tomorrow?.limitedToday).toBe(false);
    expect((await mint(link.token, { kind: "download" }, { settings, headers: next })).status).toBe(200);
  });

  it("file.download is written at mint: one per download mint, no actor, meta.linkId; none for inline or thumb", async () => {
    const owner = await member();
    const file = await imageFile(owner);
    const link = await linkTo(owner, file.id);
    await mint(link.token, { kind: "download" });
    await mint(link.token, { kind: "download" });
    await mint(link.token, { kind: "inline" });
    await mint(link.token, { kind: "thumb", size: 320 });
    const rows = await auditRows({ action: "file.download", targetId: file.id });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.actorUserId).toBeNull();
      expect(row.meta).toEqual({ linkId: link.id, size: file.size });
    }
  });

  it("ten Range fetches of one minted URL on the files host add bytes and no count, and no audit row", async () => {
    const owner = await member();
    const { node } = await storedFile(owner.id);
    const link = await linkTo(owner, node.id);
    const minted = await mint(link.token, { kind: "download" });
    expect(minted.status).toBe(200);
    for (let i = 0; i < 10; i++) {
      const range = await ask(pathOf(urlOf(minted)), {
        headers: { range: `bytes=${i * 10}-${i * 10 + 9}` },
        settings: settingsWith(),
      });
      expect(range.status).toBe(206);
    }
    const ledger = await ledgerOf("link", link.id, today());
    expect(ledger.count).toBe(1);
    expect(ledger.bytes).toBeGreaterThanOrEqual(100);
    expect((await linkById(link.id)).downloadCount).toBe(1);
    expect(await auditRows({ action: "file.download", targetId: node.id })).toHaveLength(1);
  });

  it("maxDownloads under concurrency: 20 parallel mints against 2 → exactly 2 tokens; at limit − 1 two parallel → one", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await linkTo(owner, file.id, { maxDownloads: 2 });
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => mint(link.token, { kind: "download" })),
    );
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(2);
    for (const answer of answers.filter((a) => a.status !== 200)) {
      expect([answer.status, errorOf(answer).details?.reason]).toEqual([410, "limit_reached"]);
    }
    expect((await linkById(link.id)).downloadCount).toBe(2);

    const second = await linkTo(owner, file.id, { maxDownloads: 3 });
    await testDb().update(shareLinks).set({ downloadCount: 2 }).where(eq(shareLinks.id, second.id));
    const pair = await Promise.all([
      mint(second.token, { kind: "download" }),
      mint(second.token, { kind: "download" }),
    ]);
    expect(pair.map((answer) => answer.status).sort()).toEqual([200, 410]);
  });

  it("inline and thumb never consume maxDownloads, even at the cap's edge", async () => {
    const owner = await member();
    const file = await imageFile(owner);
    const link = await linkTo(owner, file.id, { maxDownloads: 1 });
    for (let i = 0; i < 3; i++) {
      expect((await mint(link.token, { kind: "inline" })).status).toBe(200);
      expect((await mint(link.token, { kind: "thumb", size: 160 })).status).toBe(200);
    }
    expect((await linkById(link.id)).downloadCount).toBe(0);
    expect((await mint(link.token, { kind: "download" })).status).toBe(200);
  });
});

describe("the owner-cap preview", () => {
  it("at the owner's daily link bytes: every mint and the manifest on two links → 429 download_owner; nothing paused, consumed or written; another owner mints; one byte under mints", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const file = await imageFile(owner, folder.id);
    const onFile = await linkTo(owner, file.id, { maxDownloads: 5 });
    const onFolder = await linkTo(owner, folder.id, { maxDownloads: 5 });
    const settings = settingsWith({ ceilings: { CEIL_OWNER_LINK_BYTES_DAY: 1000 } });
    await addUsage(testDb(), today(), "link_owner", owner.id, 1000, 0);

    const answers = [
      await mint(onFile.token, { kind: "download" }, { settings }),
      await mint(onFile.token, { kind: "inline" }, { settings }),
      await mint(onFile.token, { kind: "thumb", size: 320 }, { settings }),
      await mint(onFolder.token, { kind: "download", nodeId: file.id }, { settings }),
      await visit(onFolder.token, "/zip-manifest", { method: "POST", settings }),
    ];
    for (const answer of answers) {
      expect([answer.status, errorOf(answer).error, errorOf(answer).details?.kind]).toEqual([
        429,
        "ceiling_exceeded",
        "download_owner",
      ]);
    }
    for (const link of [onFile, onFolder]) {
      const row = await linkById(link.id);
      expect([row.pauseReasons, row.downloadCount]).toEqual([[], 0]);
      expect(await ledgerOf("link", link.id, today())).toEqual({ bytes: 0, count: 0 });
    }
    expect(await ledgerOf("link_owner", owner.id, today())).toEqual({ bytes: 1000, count: 0 });
    expect(await auditRows({ action: "file.download", targetId: file.id })).toHaveLength(0);

    const other = await member();
    const theirs = await linkTo(other, (await makeFile(other.id, null, { scanStatus: "clean" })).id);
    expect((await mint(theirs.token, { kind: "download" }, { settings })).status).toBe(200);

    // The control: one byte under the cap mints.
    const under = await member();
    const underFile = await makeFile(under.id, null, { scanStatus: "clean" });
    const underLink = await linkTo(under, underFile.id);
    await addUsage(testDb(), today(), "link_owner", under.id, 999, 0);
    expect((await mint(underLink.token, { kind: "download" }, { settings })).status).toBe(200);
  });
});

describe("zip grants", () => {
  /** Folder F: file f, subfolders A (file a) and B (file b); a link on F. */
  async function tree(body: Record<string, unknown> = {}) {
    const owner = await member();
    const root = await makeFolder(owner.id, null, { name: "Root" });
    const a = await makeFolder(owner.id, root.id, { name: "A" });
    const b = await makeFolder(owner.id, root.id, { name: "B" });
    const f = await makeFile(owner.id, root.id, { scanStatus: "clean", name: "f.txt", size: 11 });
    const fa = await makeFile(owner.id, a.id, { scanStatus: "clean", name: "a.txt", size: 12 });
    const fb = await makeFile(owner.id, b.id, { scanStatus: "clean", name: "b.txt", size: 13 });
    const link = await linkTo(owner, root.id, { maxDownloads: 100, ...body });
    return { owner, root, a, b, f, fa, fb, link };
  }
  const grantOf = (answer: { body: unknown }) => (answer.body as { zipGrant: string }).zipGrant;
  const counts = async (linkId: string) => ({
    day: (await ledgerOf("link", linkId, today())).count,
    max: (await linkById(linkId)).downloadCount,
  });

  it("a manifest counts once and writes one zip audit row; the mints under its grant count nothing and write none", async () => {
    const { root, f, fa, fb, link } = await tree();
    const manifest = await visit(link.token, "/zip-manifest", { method: "POST", ip: X });
    expect(manifest.status).toBe(200);
    expect((manifest.body as { entries: unknown[] }).entries).toHaveLength(3);
    expect(await counts(link.id)).toEqual({ day: 1, max: 1 });
    for (const file of [f, fa, fb]) {
      const answer = await mint(
        link.token,
        { kind: "download", nodeId: file.id, zipGrant: grantOf(manifest) },
        { ip: X },
      );
      expect(answer.status).toBe(200);
    }
    expect(await counts(link.id)).toEqual({ day: 1, max: 1 });
    const zipRows = await auditRows({ action: "file.download", targetId: root.id });
    expect(zipRows).toHaveLength(1);
    expect(zipRows[0]!.meta).toEqual({ linkId: link.id, size: 36, zip: true });
    expect(await auditRows({ action: "file.download", targetId: f.id })).toHaveLength(0);
  });

  it("from another address the grant does not hold: the mint is counted", async () => {
    const { f, link } = await tree();
    const manifest = await visit(link.token, "/zip-manifest", { method: "POST", ip: X });
    const answer = await mint(
      link.token,
      { kind: "download", nodeId: f.id, zipGrant: grantOf(manifest) },
      { ip: Y },
    );
    expect(answer.status).toBe(200);
    expect(await counts(link.id)).toEqual({ day: 2, max: 2 });
  });

  it("a grant for folder A presented for a file in sibling B is counted; control: the manifest's grant for a file inside → not", async () => {
    const { a, fb, fa, link } = await tree();
    const pwv = await linkPwv(null);
    const forA = await mintZipGrant(testKeys(), {
      linkId: link.id,
      n: a.id,
      pwv,
      ipHashStable: await ipHashStable(testKeys(), X),
    });
    expect(
      (await mint(link.token, { kind: "download", nodeId: fb.id, zipGrant: forA.token }, { ip: X })).status,
    ).toBe(200);
    expect(await counts(link.id)).toEqual({ day: 1, max: 1 });
    // Even for a file inside A: the route binds the grant to the link's own node.
    expect(
      (await mint(link.token, { kind: "download", nodeId: fa.id, zipGrant: forA.token }, { ip: X })).status,
    ).toBe(200);
    expect(await counts(link.id)).toEqual({ day: 2, max: 2 });
    const manifest = await visit(link.token, "/zip-manifest", { method: "POST", ip: X });
    expect(await counts(link.id)).toEqual({ day: 3, max: 3 });
    await mint(link.token, { kind: "download", nodeId: fa.id, zipGrant: grantOf(manifest) }, { ip: X });
    expect(await counts(link.id)).toEqual({ day: 3, max: 3 });
  });

  it("a grant from before a password set / change / remove is not honoured (counted, and a fresh session is needed); control: password untouched → honoured", async () => {
    for (const change of [
      { password: PASSWORD },
      { password: OTHER_PASSWORD },
      { password: null },
    ] as const) {
      const start = change.password === PASSWORD ? {} : { password: PASSWORD };
      const { owner, f, link } = await tree(start);
      const session =
        "password" in start ? (await unlock(link.token, PASSWORD, { ip: X })).session : undefined;
      const manifest = await visit(link.token, "/zip-manifest", { method: "POST", ip: X, session });
      expect(manifest.status).toBe(200);
      const grant = grantOf(manifest);
      // The control first: unchanged password, the grant holds.
      await mint(link.token, { kind: "download", nodeId: f.id, zipGrant: grant }, { ip: X, session });
      expect(await counts(link.id)).toEqual({ day: 1, max: 1 });
      await api(asCaller(owner), `/links/${link.id}`, { method: "PATCH", json: change });
      const fresh =
        change.password === null ? undefined : (await unlock(link.token, change.password, { ip: X })).session;
      if (session) {
        const old = await mint(
          link.token,
          { kind: "download", nodeId: f.id, zipGrant: grant },
          { ip: X, session },
        );
        expect(old.status, JSON.stringify(change)).toBe(change.password === null ? 200 : 403);
      }
      const answer = await mint(
        link.token,
        { kind: "download", nodeId: f.id, zipGrant: grant },
        { ip: X, session: fresh },
      );
      expect(answer.status, JSON.stringify(change)).toBe(200);
      const after = await counts(link.id);
      expect(after.day, JSON.stringify(change)).toBeGreaterThanOrEqual(2);
      expect(after.max, JSON.stringify(change)).toBe(after.day);
    }
  });

  it("a grant of one link cannot be replayed on another link of the same folder", async () => {
    const { owner, root, f, link } = await tree();
    const other = await linkTo(owner, root.id, { maxDownloads: 100 });
    const manifest = await visit(link.token, "/zip-manifest", { method: "POST", ip: X });
    await mint(other.token, { kind: "download", nodeId: f.id, zipGrant: grantOf(manifest) }, { ip: X });
    expect(await counts(other.id)).toEqual({ day: 1, max: 1 });
  });

  it("the manifest lists a pending, an infected and a skipped file in `skipped` as `unavailable` only", async () => {
    const { owner, root, link } = await tree();
    const states = ["pending", "infected", "skipped", "under_review", "error"] as const;
    const made = [];
    for (const state of states)
      made.push(await makeFile(owner.id, root.id, { scanStatus: state, name: `${state}.bin` }));
    const csam = await makeFile(owner.id, root.id, { scanStatus: "suspected_csam", name: "hidden.bin" });
    const manifest = await visit(link.token, "/zip-manifest", { method: "POST" });
    const body = manifest.body as {
      entries: { nodeId: string }[];
      skipped: { nodeId: string; path: string; reason: string }[];
    };
    expect(body.skipped.map((s) => s.nodeId).sort()).toEqual(made.map((m) => m.id).sort());
    for (const skipped of body.skipped)
      expect(Object.keys(skipped).sort()).toEqual(["nodeId", "path", "reason"]);
    expect(new Set(body.skipped.map((s) => s.reason))).toEqual(new Set(["unavailable"]));
    expect(JSON.stringify(body)).not.toContain(csam.id);
    expect(JSON.stringify(body)).not.toMatch(/scan_|unscanned/);
  });
});

describe("scope, inherited takedown, refusals", () => {
  it("a folder link reaches its subtree only: a sibling, the parent and their listings are 404", async () => {
    const owner = await member();
    const parent = await makeFolder(owner.id);
    const linked = await makeFolder(owner.id, parent.id);
    const sibling = await makeFolder(owner.id, parent.id);
    const inSibling = await makeFile(owner.id, sibling.id, { scanStatus: "clean" });
    const atParent = await makeFile(owner.id, parent.id, { scanStatus: "clean" });
    const link = await linkTo(owner, linked.id);
    const reference = envelope(await visit("AAAAAAAAAAAAAAAAAAAAAA"));
    expect(envelope(await mint(link.token, { kind: "download", nodeId: inSibling.id }))).toEqual(reference);
    expect(envelope(await mint(link.token, { kind: "download", nodeId: atParent.id }))).toEqual(reference);
    expect(envelope(await visit(link.token, `/children/${sibling.id}`))).toEqual(reference);
    expect(envelope(await visit(link.token, `/children/${parent.id}`))).toEqual(reference);
  });

  it("a link above a taken-down folder: the folder is not listed, its listing, a file two levels inside it and its zip entries are 404 / absent", async () => {
    const owner = await member();
    const root = await makeFolder(owner.id);
    const down = await makeFolder(owner.id, root.id, { name: "Down" });
    const mid = await makeFolder(owner.id, down.id);
    const deep = await makeFile(owner.id, mid.id, { scanStatus: "clean" });
    const visible = await makeFile(owner.id, root.id, { scanStatus: "clean", name: "visible.txt" });
    const link = await linkTo(owner, root.id);
    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, down.id));
    const listing = (await visit(link.token, "/children")).body as { items: { id: string }[] };
    expect(listing.items.map((item) => item.id)).toEqual([visible.id]);
    expect((await visit(link.token, `/children/${down.id}`)).status).toBe(404);
    expect((await visit(link.token, `/children/${mid.id}`)).status).toBe(404);
    expect((await mint(link.token, { kind: "download", nodeId: deep.id })).status).toBe(404);
    const manifest = (await visit(link.token, "/zip-manifest", { method: "POST" })).body as {
      entries: { nodeId: string }[];
      skipped: { nodeId: string }[];
    };
    expect(manifest.entries.map((e) => e.nodeId)).toEqual([visible.id]);
    expect(manifest.skipped).toEqual([]);
  });

  it("a link on the taken-down folder itself, once paused by the takedown (subtree pause): 423 on every route", async () => {
    const owner = await member();
    const down = await makeFolder(owner.id);
    const file = await makeFile(owner.id, down.id, { scanStatus: "clean" });
    const link = await linkTo(owner, down.id);
    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, down.id));
    await pauseLinks(testDb(), { subtreeOf: down.id }, "moderation");
    for (const answer of [
      await visit(link.token),
      await visit(link.token, "/children"),
      await mint(link.token, { kind: "download", nodeId: file.id }),
    ]) {
      expect([answer.status, errorOf(answer).details?.reason]).toEqual([423, "unavailable"]);
    }
  });

  it("a dangerous type needs dangerousAck for a download (403 dangerous_ack, nothing counted); with it, it mints", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", name: "setup.exe" });
    const link = await linkTo(owner, file.id);
    expect(((await visit(link.token)).body as { dangerous: boolean }).dangerous).toBe(true);
    const refused = await mint(link.token, { kind: "download" });
    expect([refused.status, errorOf(refused).error, errorOf(refused).details?.reason]).toEqual([
      403,
      "forbidden",
      "dangerous_ack",
    ]);
    expect((await linkById(link.id)).downloadCount).toBe(0);
    expect((await mint(link.token, { kind: "download", dangerousAck: true })).status).toBe(200);
  });

  it("the body: thumb without size, download with size → 400; preview kinds refused when preview is off", async () => {
    const owner = await member();
    const file = await imageFile(owner);
    const link = await linkTo(owner, file.id, { allowPreview: false });
    for (const body of [{ kind: "thumb" }, { kind: "download", size: 320 }, { kind: "inline", size: 160 }]) {
      const answer = await mint(link.token, body);
      expect([answer.status, errorOf(answer).error], JSON.stringify(body)).toEqual([400, "validation"]);
    }
    for (const body of [{ kind: "inline" }, { kind: "thumb", size: 320 }]) {
      const answer = await mint(link.token, body);
      expect([answer.status, errorOf(answer).error], JSON.stringify(body)).toEqual([403, "forbidden"]);
    }
    expect(((await visit(link.token)).body as { node: { thumb: boolean } }).node.thumb).toBe(false);
  });

  it("revoking a link, or removing a share, makes an already-minted files-host URL fail", async () => {
    const owner = await member();
    const grantee = await member();
    const { node } = await storedFile(owner.id);
    const link = await linkTo(owner, node.id);
    const viaLink = urlOf(await mint(link.token, { kind: "download" }));
    expect((await ask(pathOf(viaLink), { settings: settingsWith() })).status).toBe(200);
    await api(asCaller(owner), `/links/${link.id}`, { method: "DELETE" });
    expect((await ask(pathOf(viaLink), { settings: settingsWith() })).status).toBe(410);

    const share = await makeShare(node.id, owner.id, grantee.id);
    const minted = await api(asCaller(grantee), `/nodes/${node.id}/download-url`, {
      json: { kind: "download" },
    });
    expect(minted.status).toBe(200);
    const viaShare = urlOf(minted);
    expect((await ask(pathOf(viaShare), { settings: settingsWith() })).status).toBe(200);
    await api(asCaller(owner), `/shares/${share.id}`, { method: "DELETE" });
    expect((await ask(pathOf(viaShare), { settings: settingsWith() })).status).not.toBe(200);
  });
});
