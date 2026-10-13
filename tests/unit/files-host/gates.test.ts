// The gate table of the files host: one block per row, named after the row's number, each
// asserting the status AND the body. A request is refused by the first gate that fails, and the
// order depends on who the token was minted for (a user: node state before account state; a
// link: link state before node state).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PREVIEW_TEXT_MAX_BYTES } from "../../../src/shared/constants";
import { shares, type PauseReason } from "../../../src/worker/db/schema";
import { NO_PASSWORD_PWV, type TokenKind } from "../../../src/worker/services/tokens";
import {
  accessLog,
  ask,
  imagesMock,
  inAnHour,
  ledgerRow,
  linkById,
  linkOn,
  makeAccount,
  makeFolder,
  makeShare,
  MESSAGES,
  opened,
  pathOf,
  pattern,
  signRaw,
  storedFile,
  testDb,
  updateLink,
  updateNode,
  updateUser,
  urlFor,
  type AskOptions,
  type Subject,
} from "./harness";

const ROUTES: TokenKind[] = ["download", "inline", "thumb"];
const TEXT = "text/plain; charset=utf-8";

/** A request whose thumbnails come from a stand-in image service. */
const withImages = (options: AskOptions = {}): AskOptions => ({
  ...options,
  env: { IMAGES: imagesMock().binding, ...options.env },
});

async function refused(
  url: string,
  status: number,
  code: keyof typeof MESSAGES,
  options: AskOptions = {},
  label = "",
) {
  const answer = await ask(url, withImages(options));
  expect(answer.status, `${label} ${url.slice(0, 3)}`).toBe(status);
  expect(answer.text, `${label} ${url.slice(0, 3)}`).toBe(MESSAGES[code]);
  expect(answer.headers.get("content-type")).toBe(TEXT);
  expect(answer.headers.get("etag")).toBeNull();
  expect(answer.headers.get("set-cookie")).toBeNull();
  return answer;
}

async function served(url: string, options: AskOptions = {}, label = "") {
  const answer = await ask(url, withImages(options));
  expect(answer.status, `${label} ${url.slice(0, 3)}`).toBe(200);
  return answer;
}

/** An owner with a clean PNG — a type all three routes serve. */
async function picture(set: Parameters<typeof storedFile>[1] = {}) {
  const owner = await makeAccount();
  const file = await storedFile(owner.id, { mime: "image/png", name: "picture.png", ...set });
  return { owner, file, node: file.node };
}

/** The same picture, with a link on it and a second user it is shared with. */
async function shared(set: Parameters<typeof storedFile>[1] = {}) {
  const base = await picture(set);
  const partner = await makeAccount();
  const share = await makeShare(base.node.id, base.owner.id, partner.id);
  const link = await linkOn(base.node.id, base.owner.id);
  return { ...base, partner, share, link };
}

describe("gate 1 — a token that does not verify is 403, whatever is wrong with it, and opens no database", () => {
  it("1a: forged, truncated, not a token, a path without one", async () => {
    const { node, owner } = await picture();
    const before = opened.clients;
    for (const kind of ROUTES) {
      const good = await urlFor(kind, node, { user: owner.id });
      const flipped = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
      await refused(flipped, 403, "invalid_token", {}, "forged");
      await refused(good.slice(0, -10), 403, "invalid_token", {}, "truncated");
      await refused(pathOf(kind, node.id, "not-a-token"), 403, "invalid_token");
      // The payload of one token with the signature of another.
      const other = await urlFor(kind, { ...node, versionId: "another-version" }, { user: owner.id });
      const spliced = `${good.slice(0, good.lastIndexOf("."))}${other.slice(other.lastIndexOf("."))}`;
      await refused(spliced, 403, "invalid_token", {}, "spliced");
    }
    for (const path of ["/d", "/d/only-one-segment", "/i/a/b/c", "/t/a/b", `/t/${node.id}/x320/token`]) {
      await refused(path, 403, "invalid_token", {}, path);
    }
    expect(opened.clients).toBe(before);
  });

  it("1b: a token without `st`, without `sub`, an `l` token without `pwv`, a `u` token with one", async () => {
    const { node, owner, link } = await shared();
    const base = { v: 1, k: "download", n: node.id, ver: node.versionId, exp: inAnHour() };
    const before = opened.clients;
    for (const payload of [
      { ...base, sub: owner.id },
      { ...base, st: "u" },
      { ...base, st: "u", sub: "" },
      { ...base, st: "l", sub: link.id },
      { ...base, st: "u", sub: owner.id, pwv: NO_PASSWORD_PWV },
      { ...base, v: 2, st: "u", sub: owner.id },
      { ...base, st: "u", sub: owner.id, exp: undefined },
    ]) {
      await refused(pathOf("download", node.id, await signRaw(payload)), 403, "invalid_token");
    }
    // The control: the same payload, complete, is served — the signer is not what fails.
    await served(pathOf("download", node.id, await signRaw({ ...base, st: "u", sub: owner.id })));
    expect(opened.clients).toBe(before + 1);
  });

  it("1c: a token of another kind, for another node or another size; a `scan` token or an `s` subject on every route", async () => {
    const { node, owner } = await picture();
    const other = await picture();
    const before = opened.clients;
    const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
    for (const kind of ROUTES) {
      for (const minted of ROUTES.filter((candidate) => candidate !== kind)) {
        const token = tokenOf(await urlFor(minted, node, { user: owner.id }));
        await refused(pathOf(kind, node.id, token), 403, "invalid_token", {}, `${minted} on`);
      }
      // A valid token, on another node's path.
      const own = tokenOf(await urlFor(kind, node, { user: owner.id }));
      await refused(pathOf(kind, other.node.id, own), 403, "invalid_token", {}, "other node");
      // There is no scanner route and no system subject: such a token fits nothing here.
      for (const claims of [
        { k: "scan", st: "s", sub: "scanner" },
        { k: "scan", st: "u", sub: owner.id },
        { k: kind, st: "s", sub: "scanner", ...(kind === "thumb" ? { sz: 320 } : {}) },
      ]) {
        const token = await signRaw({ v: 1, n: node.id, ver: node.versionId, exp: inAnHour(), ...claims });
        await refused(pathOf(kind, node.id, token), 403, "invalid_token", {}, `${claims.k}/${claims.st}`);
      }
    }
    const thumb = tokenOf(await urlFor("thumb", node, { user: owner.id }, { size: 320 }));
    await refused(pathOf("thumb", node.id, thumb, 160), 403, "invalid_token", {}, "other size");
    await refused(pathOf("thumb", node.id, thumb, 256), 403, "invalid_token", {}, "no such size");
    expect(opened.clients).toBe(before);
  });

  it("1d: an expired token", async () => {
    const { node, owner } = await picture();
    const before = opened.clients;
    for (const kind of ROUTES) {
      const claims = { v: 1, k: kind, n: node.id, ver: node.versionId, st: "u", sub: owner.id };
      const sized = kind === "thumb" ? { sz: 320 } : {};
      const expired = await signRaw({ ...claims, ...sized, exp: Math.floor(Date.now() / 1000) - 1 });
      await refused(pathOf(kind, node.id, expired), 403, "invalid_token", {}, "expired");
    }
    expect(opened.clients).toBe(before);
  });
});

describe("gate 2 — the node exists, is a file, is still that version, is not in the trash", () => {
  it("2: no such node, a folder, a replaced version, a trashed file, a file in a trashed folder → 404", async () => {
    const { node, owner } = await picture();
    for (const kind of ROUTES) {
      const sized = kind === "thumb" ? { sz: 320 } : {};
      const ghost = crypto.randomUUID();
      const token = await signRaw({
        v: 1,
        k: kind,
        n: ghost,
        ver: "v1",
        st: "u",
        sub: owner.id,
        exp: inAnHour(),
        ...sized,
      });
      await refused(pathOf(kind, ghost, token), 404, "not_found", {}, "no node");
    }
    const folder = await makeFolder(owner.id);
    const forFolder = await signRaw({
      v: 1,
      k: "download",
      n: folder.id,
      ver: "v1",
      st: "u",
      sub: owner.id,
      exp: inAnHour(),
    });
    await refused(pathOf("download", folder.id, forFolder), 404, "not_found", {}, "folder");

    // A replaced file: the old URL names a version the node no longer has.
    for (const kind of ROUTES) {
      await refused(
        await urlFor(kind, node, { user: owner.id }, { ver: "the-old-version" }),
        404,
        "not_found",
      );
    }

    const trashed = await picture();
    const inside = await storedFile(owner.id, { parentId: folder.id, mime: "image/png" });
    await updateNode(trashed.node.id, { deletedAt: new Date() });
    await updateNode(folder.id, { deletedAt: new Date() });
    for (const kind of ROUTES) {
      await refused(
        await urlFor(kind, trashed.node, { user: trashed.owner.id }),
        404,
        "not_found",
        {},
        "trashed",
      );
      await refused(await urlFor(kind, inside.node, { user: owner.id }), 404, "not_found", {}, "in trash");
    }
  });
});

describe("gate 3a — taken down, itself or by any ancestor", () => {
  it("3a: a taken-down file is a missing file, for its owner, a share partner and a link", async () => {
    const { node, owner, partner, link } = await shared();
    await updateNode(node.id, { takedownAt: new Date(), takedownReason: "admin" });
    for (const kind of ROUTES) {
      for (const subject of [{ user: owner.id }, { user: partner.id }, { link }] as Subject[]) {
        await refused(await urlFor(kind, node, subject), 404, "not_found");
      }
    }
  });

  it("3a (inherited): a clean file inside a taken-down folder → 404 on every route, for the owner, a share partner and links rooted above, at and below the folder — byte for byte a missing file; a sibling outside is served", async () => {
    const owner = await makeAccount();
    const partner = await makeAccount();
    const top = await makeFolder(owner.id);
    const down = await makeFolder(owner.id, top.id);
    const { node } = await storedFile(owner.id, { parentId: down.id, mime: "image/png", name: "in.png" });
    const sibling = await storedFile(owner.id, { parentId: top.id, mime: "image/png", name: "out.png" });
    await makeShare(top.id, owner.id, partner.id);
    const links = [
      await linkOn(top.id, owner.id),
      await linkOn(down.id, owner.id),
      await linkOn(node.id, owner.id),
    ];
    const subjects: Subject[] = [
      { user: owner.id },
      { user: partner.id },
      ...links.map((link) => ({ link })),
    ];

    // Before the takedown everything is served: the fixture itself is not what refuses.
    for (const subject of subjects) await served(await urlFor("download", node, subject));

    await updateNode(down.id, { takedownAt: new Date(), takedownReason: "dmca" });
    const ghost = crypto.randomUUID();
    const missing = await ask(
      pathOf(
        "download",
        ghost,
        await signRaw({ v: 1, k: "download", n: ghost, ver: "v", st: "u", sub: owner.id, exp: inAnHour() }),
      ),
    );
    for (const kind of ROUTES) {
      for (const subject of subjects) {
        const answer = await refused(await urlFor(kind, node, subject), 404, "not_found", {}, "inherited");
        expect(answer.bytes).toEqual(missing.bytes);
        expect([...answer.headers].sort()).toEqual([...missing.headers].sort());
      }
      // A sibling outside the folder: the owner, the partner and the link above still get it.
      for (const subject of [subjects[0]!, subjects[1]!, subjects[2]!]) {
        await served(await urlFor(kind, sibling.node, subject), {}, "sibling");
      }
    }
  });
});

describe("gates 3b–3f — the scan state, by subject", () => {
  it("3b–3d for the owner: suspected_csam → 404, pending → 409, infected / under_review → 403 scan_blocked", async () => {
    for (const [scanStatus, status, code] of [
      ["suspected_csam", 404, "not_found"],
      ["pending", 409, "scan_pending"],
      ["infected", 403, "scan_blocked"],
      ["under_review", 403, "scan_blocked"],
    ] as const) {
      const { node, owner } = await shared({ scanStatus });
      for (const kind of ROUTES) {
        await refused(await urlFor(kind, node, { user: owner.id }), status, code, {}, scanStatus);
      }
    }
  });

  it("3f: for a share partner a file that is not clean is a missing file — 404, byte for byte an unknown id's — unless they uploaded this version of it; one under review, never", async () => {
    const ghost = crypto.randomUUID();
    const stranger = await makeAccount();
    const missing = await ask(
      pathOf(
        "download",
        ghost,
        await signRaw({
          v: 1,
          k: "download",
          n: ghost,
          ver: "v",
          st: "u",
          sub: stranger.id,
          exp: inAnHour(),
        }),
      ),
    );
    expect(missing.status).toBe(404);
    for (const scanStatus of [
      "pending",
      "infected",
      "under_review",
      "skipped",
      "error",
      "suspected_csam",
    ] as const) {
      const { node, partner } = await shared({ scanStatus });
      for (const kind of ROUTES) {
        const answer = await refused(
          await urlFor(kind, node, { user: partner.id }),
          404,
          "not_found",
          {},
          scanStatus,
        );
        expect(answer.bytes).toEqual(missing.bytes);
        expect([...answer.headers].sort()).toEqual([...missing.headers].sort());
      }
    }
    // The partner who uploaded this version keeps the scan's own answer — it is their upload.
    for (const [scanStatus, status, code] of [
      ["pending", 409, "scan_pending"],
      ["infected", 403, "scan_blocked"],
      ["skipped", 403, "scan_blocked"],
      ["error", 403, "scan_blocked"],
      ["under_review", 404, "not_found"],
      ["suspected_csam", 404, "not_found"],
    ] as const) {
      const base = await shared();
      const uploaded = await storedFile(base.owner.id, {
        mime: "image/png",
        name: "theirs.png",
        scanStatus,
        node: { createdBy: base.partner.id },
      });
      await makeShare(uploaded.node.id, base.owner.id, base.partner.id);
      for (const kind of ROUTES) {
        await refused(
          await urlFor(kind, uploaded.node, { user: base.partner.id }),
          status,
          code,
          {},
          scanStatus,
        );
      }
    }
    // A clean file is served to the partner, whoever uploaded it.
    const clean = await shared();
    await served(await urlFor("download", clean.node, { user: clean.partner.id }));
  });

  it("3f for a link: every state but clean — pending too — is the missing file's 404, never 403 or 409; the log says why, the response does not", async () => {
    const ghost = crypto.randomUUID();
    const anyLink = await shared();
    const missing = await ask(
      await urlFor("download", { id: ghost, versionId: "v" }, { link: anyLink.link }),
    );
    expect(missing.status).toBe(404);
    for (const scanStatus of [
      "pending",
      "infected",
      "under_review",
      "suspected_csam",
      "skipped",
      "error",
    ] as const) {
      const { node, link } = await shared({ scanStatus });
      for (const kind of ROUTES) {
        const answer = await refused(await urlFor(kind, node, { link }), 404, "not_found", {}, scanStatus);
        expect(answer.bytes).toEqual(missing.bytes);
        expect([...answer.headers].sort()).toEqual([...missing.headers].sort());
      }
      expect((await accessLog(link.id)).map((row) => row.outcome)).toEqual(ROUTES.map(() => "denied_scan"));
    }
  });

  it("3e: skipped / error — the owner's own download is served with the warning header; inline and a thumbnail are 403 for them", async () => {
    for (const scanStatus of ["skipped", "error"] as const) {
      const { node, owner } = await shared({ scanStatus });
      const own = await served(await urlFor("download", node, { user: owner.id }));
      expect(own.headers.get("x-holdfast-warning")).toBe("unscanned");
      expect(own.headers.get("access-control-expose-headers")).toContain("X-Holdfast-Warning");
      await refused(await urlFor("inline", node, { user: owner.id }), 403, "scan_blocked", {}, scanStatus);
      await refused(await urlFor("thumb", node, { user: owner.id }), 403, "scan_blocked", {}, scanStatus);
      // The partner who uploaded it may not take it either: only the owner, only as a download.
      const theirs = await shared();
      const uploaded = await storedFile(theirs.owner.id, {
        scanStatus,
        node: { createdBy: theirs.partner.id },
      });
      await makeShare(uploaded.node.id, theirs.owner.id, theirs.partner.id);
      const answer = await ask(await urlFor("download", uploaded.node, { user: theirs.partner.id }));
      expect(answer.status).toBe(403);
      expect(answer.headers.get("x-holdfast-warning")).toBeNull();
    }
    // A clean file carries no warning.
    const clean = await picture();
    const answer = await served(await urlFor("download", clean.node, { user: clean.owner.id }));
    expect(answer.headers.get("x-holdfast-warning")).toBeNull();
  });
});

// (4a's "the owner row exists" cannot fail on its own: `nodes.owner_id` is a foreign key, so a
// node never outlives its owner's row — the gate still refuses if it ever did.)
describe("gates 4a–4d — the accounts behind a user's token", () => {
  it("4a: the owner banned or suspended → 403 for everyone, the owner included; a link → 423", async () => {
    for (const state of [{ banned: true }, { suspendedAt: new Date() }]) {
      const { node, owner, partner, link } = await shared();
      await updateUser(owner.id, state);
      for (const kind of ROUTES) {
        await refused(await urlFor(kind, node, { user: owner.id }), 403, "forbidden", {}, "owner");
        await refused(await urlFor(kind, node, { user: partner.id }), 403, "forbidden", {}, "partner");
        await refused(await urlFor(kind, node, { link }), 423, "link_paused", {}, "link");
      }
    }
    // A ban that has run out is no ban.
    const { node, owner } = await picture();
    await updateUser(owner.id, { banned: true, banExpires: new Date(Date.now() - 60_000) });
    await served(await urlFor("download", node, { user: owner.id }));
  });

  it("4b: the owner scheduled for deletion → a share partner 403, a link 423, the owner's own token still served", async () => {
    const { node, owner, partner, link } = await shared();
    await updateUser(owner.id, { deleteScheduledAt: new Date(Date.now() + 86_400_000) });
    for (const kind of ROUTES) {
      await refused(await urlFor(kind, node, { user: partner.id }), 403, "forbidden", {}, "partner");
      await refused(await urlFor(kind, node, { link }), 423, "link_paused", {}, "link");
      await served(await urlFor(kind, node, { user: owner.id }), {}, "owner");
    }
    expect((await accessLog(link.id)).every((row) => row.outcome === "denied_owner")).toBe(true);
  });

  it("4c: the subject banned, suspended or gone → 403; its own scheduled deletion is no reason to refuse", async () => {
    for (const state of [{ banned: true }, { suspendedAt: new Date() }]) {
      const { node, partner } = await shared();
      await updateUser(partner.id, state);
      for (const kind of ROUTES)
        await refused(await urlFor(kind, node, { user: partner.id }), 403, "forbidden");
    }
    const { node, partner } = await shared();
    await refused(
      await urlFor("download", node, { user: "NoSuchUser0000000000000000000000" }),
      403,
      "forbidden",
    );
    await updateUser(partner.id, { deleteScheduledAt: new Date(Date.now() + 86_400_000) });
    await served(await urlFor("download", node, { user: partner.id }));
  });

  it("4d: a share removed after the mint, a share that was never activated, a stranger → 404", async () => {
    const { node, owner, partner, share } = await shared();
    const stranger = await makeAccount();
    const pending = await makeAccount();
    await makeShare(node.id, owner.id, pending.id, { granteeUserId: null, activatedAt: null });
    const urls: string[] = [];
    for (const kind of ROUTES) urls.push(await urlFor(kind, node, { user: partner.id }));
    for (const url of urls) await served(url, {}, "while shared");
    await testDb().delete(shares).where(eq(shares.id, share.id));
    for (const url of urls) await refused(url, 404, "not_found", {}, "share removed");
    for (const kind of ROUTES) {
      await refused(await urlFor(kind, node, { user: stranger.id }), 404, "not_found", {}, "stranger");
      await refused(await urlFor(kind, node, { user: pending.id }), 404, "not_found", {}, "pending share");
    }
  });

  it("4d: an avatar's thumbnail skips the role check — and only the thumbnail", async () => {
    const owner = await makeAccount();
    const viewer = await makeAccount();
    const { node } = await storedFile(owner.id, {
      mime: "image/png",
      name: "avatar.png",
      node: { system: "avatar" },
    });
    await served(await urlFor("thumb", node, { user: viewer.id }));
    await refused(await urlFor("download", node, { user: viewer.id }), 404, "not_found");
    await refused(await urlFor("inline", node, { user: viewer.id }), 404, "not_found");
    // The other gates still hold for it: a banned viewer gets nothing.
    await updateUser(viewer.id, { banned: true });
    await refused(await urlFor("thumb", node, { user: viewer.id }), 403, "forbidden");
  });
});

describe("gates 4e–4k — the link behind a link token", () => {
  it("4e: links switched off → 423", async () => {
    const { node, link } = await shared();
    for (const kind of ROUTES) {
      await refused(await urlFor(kind, node, { link }), 423, "link_paused", {
        settings: { linksEnabled: false },
      });
      await served(await urlFor(kind, node, { link }), { settings: { linksEnabled: true } });
    }
  });

  it("4f: no such link → 404; a revoked link → 410", async () => {
    const { node, link } = await shared();
    const ghost = { id: crypto.randomUUID(), passwordHash: null };
    for (const kind of ROUTES) await refused(await urlFor(kind, node, { link: ghost }), 404, "not_found");
    const urls: string[] = [];
    for (const kind of ROUTES) urls.push(await urlFor(kind, node, { link }));
    await updateLink(link.id, { revokedAt: new Date() });
    for (const url of urls) await refused(url, 410, "link_expired");
    expect((await accessLog(link.id)).map((row) => row.outcome)).toEqual(ROUTES.map(() => "denied_expired"));
  });

  it("4g: paused for any single reason, for two reasons, or locked by an admin → 423", async () => {
    const reasons: PauseReason[][] = [
      ["ceiling"],
      ["anomaly"],
      ["owner"],
      ["owner_deletion"],
      ["owner_suspended"],
      ["report"],
      ["moderation"],
      ["ceiling", "report"],
    ];
    for (const pauseReasons of reasons) {
      const { node, link } = await shared();
      await updateLink(link.id, { pauseReasons, pausedAt: new Date() });
      await refused(await urlFor("download", node, { link }), 423, "link_paused", {}, pauseReasons.join("+"));
    }
    const { node, link } = await shared();
    await updateLink(link.id, { lockedByAdmin: true });
    for (const kind of ROUTES)
      await refused(await urlFor(kind, node, { link }), 423, "link_paused", {}, "locked");
    expect((await accessLog(link.id)).map((row) => row.outcome)).toEqual(ROUTES.map(() => "denied_paused"));
  });

  it("4h: an expired link → 410; one that expires later is served", async () => {
    const { node, link } = await shared();
    await updateLink(link.id, { expiresAt: new Date(Date.now() - 1000) });
    for (const kind of ROUTES) await refused(await urlFor(kind, node, { link }), 410, "link_expired");
    await updateLink(link.id, { expiresAt: new Date(Date.now() + 3_600_000) });
    for (const kind of ROUTES) await served(await urlFor(kind, node, { link }));
  });

  it("4k: a token minted before the link's password was changed, set or removed → 403 on every route; unchanged → served", async () => {
    for (const kind of ROUTES) {
      // Changed.
      const changed = await shared();
      const withPassword = await linkOn(changed.node.id, changed.owner.id, {
        passwordHash: "scrypt$made-up$one",
      });
      const url = await urlFor(kind, changed.node, { link: withPassword });
      // The control: the same token while the password is unchanged is served.
      await served(url, {}, "unchanged");
      await updateLink(withPassword.id, { passwordHash: "scrypt$made-up$two" });
      await refused(url, 403, "invalid_token", {}, "changed");

      // Added to a link that had none.
      const added = await shared();
      const plain = await urlFor(kind, added.node, { link: added.link }, { pwv: NO_PASSWORD_PWV });
      await served(plain, {}, "no password");
      await updateLink(added.link.id, { passwordHash: "scrypt$made-up$new" });
      await refused(plain, 403, "invalid_token", {}, "added");

      // Removed.
      const removed = await shared();
      const guarded = await linkOn(removed.node.id, removed.owner.id, { passwordHash: "scrypt$made-up$old" });
      const old = await urlFor(kind, removed.node, { link: guarded });
      await updateLink(guarded.id, { passwordHash: null });
      await refused(old, 403, "invalid_token", {}, "removed");
    }
  });

  it("4k comes after the link's state: a revoked link whose password also changed → 410", async () => {
    const { node, owner } = await shared();
    const link = await linkOn(node.id, owner.id, { passwordHash: "scrypt$made-up$one" });
    const url = await urlFor("download", node, { link });
    await updateLink(link.id, { passwordHash: "scrypt$made-up$two", revokedAt: new Date() });
    await refused(url, 410, "link_expired");
  });

  it("4i: a node outside the link's subtree → 404; inside it, served; a link whose own root is trashed or taken down serves nothing", async () => {
    const owner = await makeAccount();
    const top = await makeFolder(owner.id);
    const inner = await makeFolder(owner.id, top.id);
    const inside = await storedFile(owner.id, { parentId: inner.id, mime: "image/png" });
    const beside = await storedFile(owner.id, { parentId: top.id, mime: "image/png" });
    const elsewhere = await storedFile(owner.id, { mime: "image/png" });
    const link = await linkOn(inner.id, owner.id);
    for (const kind of ROUTES) {
      await served(await urlFor(kind, inside.node, { link }), {}, "inside");
      await refused(await urlFor(kind, beside.node, { link }), 404, "not_found", {}, "beside");
      await refused(await urlFor(kind, elsewhere.node, { link }), 404, "not_found", {}, "elsewhere");
    }
    // The link's own root hidden by an ancestor of its own: everything in the link is hidden.
    await updateNode(top.id, { takedownAt: new Date(), takedownReason: "admin" });
    for (const kind of ROUTES) await refused(await urlFor(kind, inside.node, { link }), 404, "not_found");
    await updateNode(top.id, { takedownAt: null, takedownReason: null, deletedAt: new Date() });
    for (const kind of ROUTES) await refused(await urlFor(kind, inside.node, { link }), 404, "not_found");
  });

  it("4j: a link without previews → 403 for inline and thumb, the download is served", async () => {
    const { node, owner } = await shared();
    const link = await linkOn(node.id, owner.id, { allowPreview: false });
    await refused(await urlFor("inline", node, { link }), 403, "forbidden");
    await refused(await urlFor("thumb", node, { link }), 403, "forbidden");
    await served(await urlFor("download", node, { link }));
  });

  it("the cap on downloads is not this host's: a link with maxDownloads = 1 and downloadCount = 1 still serves, and 20 ranges leave the count alone", async () => {
    const { node, owner } = await shared();
    const link = await linkOn(node.id, owner.id, { maxDownloads: 1, downloadCount: 1 });
    const url = await urlFor("download", node, { link });
    await served(url);
    for (let i = 0; i < 20; i++) {
      const range = i === 0 ? "bytes=0-99" : i === 1 ? "bytes=1-" : `bytes=${i * 10}-${i * 10 + 9}`;
      expect((await ask(url, { headers: { range } })).status).toBe(206);
    }
    expect((await linkById(link.id)).downloadCount).toBe(1);
  });
});

describe("the order of the gates", () => {
  it("a link: link state before node state — paused + under_review → 423, revoked + infected → 410, paused + trashed → 423, links off + pending → 423", async () => {
    const paused = await shared({ scanStatus: "under_review" });
    await updateLink(paused.link.id, { pauseReasons: ["report"], pausedAt: new Date() });
    await refused(await urlFor("download", paused.node, { link: paused.link }), 423, "link_paused");

    const revoked = await shared({ scanStatus: "infected" });
    const url = await urlFor("download", revoked.node, { link: revoked.link });
    await updateLink(revoked.link.id, { revokedAt: new Date() });
    await refused(url, 410, "link_expired");

    const trashed = await shared();
    await updateLink(trashed.link.id, { pauseReasons: ["ceiling"], pausedAt: new Date() });
    await updateNode(trashed.node.id, { deletedAt: new Date() });
    await refused(await urlFor("download", trashed.node, { link: trashed.link }), 423, "link_paused");

    const off = await shared({ scanStatus: "pending" });
    await refused(await urlFor("download", off.node, { link: off.link }), 423, "link_paused", {
      settings: { linksEnabled: false },
    });

    // A taken-down file behind a paused link: still "paused".
    const down = await shared();
    await updateLink(down.link.id, { pauseReasons: ["moderation"], pausedAt: new Date() });
    await updateNode(down.node.id, { takedownAt: new Date(), takedownReason: "abuse" });
    await refused(await urlFor("download", down.node, { link: down.link }), 423, "link_paused");
  });

  it("a user: node state first — a suspended or banned owner asking for their own blocked file gets the scan's answer, not the account's", async () => {
    const review = await shared({ scanStatus: "under_review" });
    await updateUser(review.owner.id, { suspendedAt: new Date() });
    await refused(await urlFor("download", review.node, { user: review.owner.id }), 403, "scan_blocked");

    const infected = await shared({ scanStatus: "infected" });
    await updateUser(infected.owner.id, { banned: true });
    await refused(await urlFor("download", infected.node, { user: infected.owner.id }), 403, "scan_blocked");

    const pending = await shared({ scanStatus: "pending" });
    await updateUser(pending.owner.id, { suspendedAt: new Date() });
    await refused(await urlFor("download", pending.node, { user: pending.owner.id }), 409, "scan_pending", {
      settings: { linksEnabled: false },
    });

    const trashed = await shared({ scanStatus: "pending" });
    await updateNode(trashed.node.id, { deletedAt: new Date() });
    await refused(await urlFor("download", trashed.node, { user: trashed.owner.id }), 404, "not_found");

    // A partner never learns either: a file they may not see is a missing file whatever the
    // owner's account state is.
    await refused(await urlFor("download", review.node, { user: review.partner.id }), 404, "not_found");
  });

  it("a hidden file behind a link without previews is a missing file (404), not 4j's 403", async () => {
    const { node, owner } = await shared();
    const link = await linkOn(node.id, owner.id, { allowPreview: false });
    await updateNode(node.id, { takedownAt: new Date(), takedownReason: "admin" });
    await refused(await urlFor("inline", node, { link }), 404, "not_found");
  });
});

describe("gate 6 — what a kind of URL may serve, by the DETECTED type alone", () => {
  const types = async (mime: string | null, name: string, content = pattern(500)) => {
    const owner = await makeAccount();
    const file = await storedFile(owner.id, { mime, name, content });
    return { owner, node: file.node };
  };

  it("6: /i/ serves a PDF and a small text file — as an attachment", async () => {
    for (const [mime, name] of [
      ["application/pdf", "paper.pdf"],
      ["text/plain", "notes.txt"],
    ] as const) {
      const { owner, node } = await types(mime, name);
      const answer = await served(await urlFor("inline", node, { user: owner.id }));
      expect(answer.headers.get("content-disposition")).toMatch(/^attachment; /);
      expect(answer.headers.get("content-type")).toBe(mime);
    }
  });

  it("6: /i/ refuses HTML, SVG and a text file above the preview limit → 403; /t/ for them → 404", async () => {
    const big = { size: PREVIEW_TEXT_MAX_BYTES + 1_000_000 };
    for (const [mime, name, node] of [
      ["text/html", "page.html", {}],
      ["image/svg+xml", "drawing.svg", {}],
      ["text/plain", "big.txt", big],
    ] as const) {
      const owner = await makeAccount();
      const file = await storedFile(owner.id, { mime, name, node });
      await refused(await urlFor("inline", file.node, { user: owner.id }), 403, "forbidden", {}, name);
      await refused(await urlFor("thumb", file.node, { user: owner.id }), 404, "not_found", {}, name);
    }
  });

  it("6: a node sniffed `application/xml` (what a prolog-SVG looks like) → 403 on /i/, 404 on /t/, an octet-stream attachment on /d/", async () => {
    const { owner, node } = await types("application/xml", "drawing.svg");
    await refused(await urlFor("inline", node, { user: owner.id }), 403, "forbidden");
    await refused(await urlFor("thumb", node, { user: owner.id }), 404, "not_found");
    const answer = await served(await urlFor("download", node, { user: owner.id }));
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("6: the declared type decides nothing — declared image/png, sniffed image/svg+xml is an SVG on all three routes", async () => {
    const owner = await makeAccount();
    const { node } = await storedFile(owner.id, {
      mime: "image/svg+xml",
      name: "photo.png",
      node: { mimeDeclared: "image/png" },
    });
    await refused(await urlFor("inline", node, { user: owner.id }), 403, "forbidden");
    await refused(await urlFor("thumb", node, { user: owner.id }), 404, "not_found");
    const answer = await served(await urlFor("download", node, { user: owner.id }));
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("6: /i/ serves audio/x-m4a and video/x-m4v inline, typed exactly as sniffed; AVIF and BMP are inline but have no thumbnail", async () => {
    for (const [mime, name] of [
      ["audio/x-m4a", "song.m4a"],
      ["video/x-m4v", "clip.m4v"],
    ] as const) {
      const { owner, node } = await types(mime, name);
      const answer = await served(await urlFor("inline", node, { user: owner.id }));
      expect(answer.headers.get("content-disposition")).toMatch(/^inline; /);
      expect(answer.headers.get("content-type")).toBe(mime);
    }
    for (const [mime, name] of [
      ["image/avif", "a.avif"],
      ["image/bmp", "b.bmp"],
    ] as const) {
      const { owner, node } = await types(mime, name);
      const images = imagesMock();
      const inline = await served(await urlFor("inline", node, { user: owner.id }));
      expect(inline.headers.get("content-disposition")).toMatch(/^inline; /);
      await refused(await urlFor("thumb", node, { user: owner.id }), 404, "not_found", {
        env: { IMAGES: images.binding },
      });
      expect(images.calls).toHaveLength(0);
    }
  });

  it("6: a request gate 6 refuses is charged nothing", async () => {
    const { owner, node } = await types("text/html", "page.html");
    await refused(await urlFor("inline", node, { user: owner.id }), 403, "forbidden");
    expect(await ledgerRow("user", owner.id)).toBeNull();
  });
});
