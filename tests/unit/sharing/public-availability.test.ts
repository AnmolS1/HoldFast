// `resolveLink`: one test per row of the availability table, the order of the checks, and what
// every public route has in common (no 401, no-store, the per-IP limiter, the access log).
// Every password here is made up.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { nodes, shareLinks, user, type PauseReason } from "../../../src/worker/db/schema";
import { accessLog, envelope, errorOf, makeFile, makeFolder, member, settingsWith, testDb } from "./helpers";
import { linkTo, mint, unlock, visit } from "./public-helpers";

const PASSWORD = "made-up visitor password";
const UNKNOWN_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

async function setLink(id: string, values: Partial<typeof shareLinks.$inferInsert>) {
  await testDb().update(shareLinks).set(values).where(eq(shareLinks.id, id));
}

/** A clean file in a folder, a link on the folder. */
async function folderLink(body: Record<string, unknown> = {}) {
  const owner = await member();
  const folder = await makeFolder(owner.id);
  const file = await makeFile(owner.id, folder.id, { scanStatus: "clean", name: "doc.txt", size: 10 });
  const link = await linkTo(owner, folder.id, body);
  return { owner, folder, file, link };
}

/** Every public route of a link, as a visitor would call it. */
function everyRoute(token: string, fileId: string, session?: string) {
  return [
    visit(token, "", { session }),
    visit(token, "/children", { session }),
    mint(token, { kind: "download", nodeId: fileId }, { session }),
    visit(token, "/zip-manifest", { method: "POST", session }),
    unlock(token, PASSWORD).then((result) => result.answer),
  ];
}

const reasonOf = (answer: Awaited<ReturnType<typeof visit>>) => [
  answer.status,
  errorOf(answer).error,
  errorOf(answer).details?.reason,
];

describe("the availability table, one row each", () => {
  it("row 1: an unknown token is 404 not_found — and so is a malformed one, identically", async () => {
    const unknown = await visit(UNKNOWN_TOKEN);
    expect(envelope(unknown)).toMatchObject({ status: 404, error: "not_found" });
    expect(envelope(await visit("short"))).toEqual(envelope(unknown));
    expect(envelope(await visit(UNKNOWN_TOKEN, "/children"))).toEqual(envelope(unknown));
  });

  it("row 2: revoked → 410 link_expired 'revoked' on every route", async () => {
    const { file, link } = await folderLink();
    await setLink(link.id, { revokedAt: new Date() });
    for (const answer of await Promise.all(everyRoute(link.token, file.id))) {
      expect(reasonOf(answer)).toEqual([410, "link_expired", "revoked"]);
    }
  });

  it("row 3: expired → 410 'expired'; the boundary is the instant itself", async () => {
    const { link } = await folderLink();
    const at = new Date(Date.now() + 3_600_000);
    await setLink(link.id, { expiresAt: at });
    const before = await visit(link.token, "", {
      headers: { "x-holdfast-test-now": new Date(at.getTime() - 1).toISOString() },
    });
    expect(before.status).toBe(200);
    const on = await visit(link.token, "", { headers: { "x-holdfast-test-now": at.toISOString() } });
    expect(reasonOf(on)).toEqual([410, "link_expired", "expired"]);
  });

  it("row 4: download limit reached → 410 'limit_reached'", async () => {
    const { link } = await folderLink();
    await setLink(link.id, { maxDownloads: 2, downloadCount: 2 });
    expect(reasonOf(await visit(link.token))).toEqual([410, "link_expired", "limit_reached"]);
  });

  it("row 5: linksEnabled off → 423 'unavailable' on every route", async () => {
    const { file, link } = await folderLink();
    const settings = settingsWith({ linksEnabled: false });
    const answers = await Promise.all([
      visit(link.token, "", { settings }),
      visit(link.token, "/children", { settings }),
      mint(link.token, { kind: "download", nodeId: file.id }, { settings }),
      visit(link.token, "/zip-manifest", { method: "POST", settings }),
      unlock(link.token, PASSWORD, { settings }).then((result) => result.answer),
    ]);
    for (const answer of answers) expect(reasonOf(answer)).toEqual([423, "link_paused", "unavailable"]);
  });

  it("rows 6–7: any reason but anomaly is 'unavailable' (so {anomaly, report} too); only anomaly — or a stored ceiling — is 'traffic'; a lock is 'unavailable'", async () => {
    const cases: [PauseReason[], string][] = [
      [["report"], "unavailable"],
      [["owner"], "unavailable"],
      [["moderation"], "unavailable"],
      [["owner_suspended"], "unavailable"],
      [["anomaly", "report"], "unavailable"],
      [["anomaly"], "traffic"],
      [["ceiling"], "traffic"],
      [["anomaly", "ceiling"], "traffic"],
    ];
    for (const [set, reason] of cases) {
      const { link } = await folderLink();
      await setLink(link.id, { pauseReasons: set, pausedAt: new Date() });
      expect(reasonOf(await visit(link.token)), set.join(",")).toEqual([423, "link_paused", reason]);
    }
    const { link } = await folderLink();
    await setLink(link.id, { lockedByAdmin: true });
    expect(reasonOf(await visit(link.token))).toEqual([423, "link_paused", "unavailable"]);
  });

  it("row 8: the owner banned, suspended or scheduled for deletion → 423 'unavailable'", async () => {
    for (const state of [
      { banned: true },
      { suspendedAt: new Date() },
      { deleteScheduledAt: new Date(Date.now() + 86_400_000) },
    ]) {
      const { owner, link } = await folderLink();
      await testDb().update(user).set(state).where(eq(user.id, owner.id));
      expect(reasonOf(await visit(link.token)), JSON.stringify(state)).toEqual([
        423,
        "link_paused",
        "unavailable",
      ]);
    }
  });

  it("row 9: a password and no session → 403 password_required; GET info answers 200 with node null", async () => {
    const { file, link } = await folderLink({ password: PASSWORD });
    const info = await visit(link.token);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ requiresPassword: true, node: null, allowPreview: false, dangerous: false });
    for (const answer of await Promise.all(everyRoute(link.token, file.id).slice(1, 4))) {
      expect([answer.status, errorOf(answer).error]).toEqual([403, "password_required"]);
    }
    const { session } = await unlock(link.token, PASSWORD);
    const open = await visit(link.token, "", { session });
    expect(open.body).toMatchObject({ requiresPassword: true, node: { kind: "folder" } });
  });

  it("rows 10–11: trashed, infected, under review, skipped, error, suspected CSAM, taken down (itself or above), pending → 404 identical to an unknown token", async () => {
    const reference = envelope(await visit(UNKNOWN_TOKEN));
    const owner = await member();
    const make = async (values: Partial<typeof nodes.$inferInsert>, parentId: string | null = null) => {
      const file = await makeFile(owner.id, parentId, { scanStatus: "clean" });
      const link = await linkTo(owner, file.id);
      await testDb().update(nodes).set(values).where(eq(nodes.id, file.id));
      return link;
    };
    const links = [
      await make({
        deletedAt: new Date(),
        purgeAfter: new Date(Date.now() + 86_400_000),
        trashedBy: owner.id,
      }),
      await make({ scanStatus: "infected" }),
      await make({ scanStatus: "under_review" }),
      await make({ scanStatus: "skipped" }),
      await make({ scanStatus: "error" }),
      await make({ scanStatus: "suspected_csam" }),
      await make({ takedownAt: new Date() }),
      await make({ scanStatus: "pending" }),
    ];
    // A file two folders below a folder that is then taken down.
    const top = await makeFolder(owner.id);
    const mid = await makeFolder(owner.id, top.id);
    const deep = await makeFile(owner.id, mid.id, { scanStatus: "clean" });
    links.push(await linkTo(owner, deep.id));
    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, top.id));
    for (const link of links) {
      expect(envelope(await visit(link.token))).toEqual(reference);
      expect(envelope(await mint(link.token, { kind: "download" }))).toEqual(reference);
    }
  });
});

describe("the order of the checks", () => {
  it("a password link to an infected file: 403 password_required without a session, 404 with one — never scan_blocked", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await linkTo(owner, file.id, { password: PASSWORD });
    await testDb().update(nodes).set({ scanStatus: "infected" }).where(eq(nodes.id, file.id));
    const without = await mint(link.token, { kind: "download" });
    expect([without.status, errorOf(without).error]).toEqual([403, "password_required"]);
    const { session } = await unlock(link.token, PASSWORD);
    expect(session).toBeTruthy();
    const withSession = await mint(link.token, { kind: "download" }, { session });
    expect(envelope(withSession)).toEqual(
      envelope(await visit(UNKNOWN_TOKEN, "/download-url", { json: { kind: "download" } })),
    );
  });

  it("the same link to a pending file: 403 without a session, 404 with one, byte-identical to an unknown token's 404 — no 409 anywhere", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await linkTo(owner, file.id, { password: PASSWORD });
    await testDb().update(nodes).set({ scanStatus: "pending" }).where(eq(nodes.id, file.id));
    expect((await mint(link.token, { kind: "download" })).status).toBe(403);
    const { session } = await unlock(link.token, PASSWORD);
    const reference = await visit(UNKNOWN_TOKEN, "/download-url", { json: { kind: "download" } });
    for (const answer of [
      await mint(link.token, { kind: "download" }, { session }),
      await mint(link.token, { kind: "inline" }, { session }),
      await visit(link.token, "", { session }),
    ]) {
      expect(answer.status).toBe(404);
      expect(envelope(answer)).toEqual(envelope(reference));
    }
  });

  it("link state comes before the password: a revoked password link is 410 without a session", async () => {
    const { link } = await folderLink({ password: PASSWORD });
    await setLink(link.id, { revokedAt: new Date() });
    expect(reasonOf(await visit(link.token, "/children"))).toEqual([410, "link_expired", "revoked"]);
  });
});

describe("every public route", () => {
  it("never answers 401, sends Cache-Control: no-store, and reads no session cookie", async () => {
    const { file, link } = await folderLink({ password: PASSWORD });
    const answers = [
      ...(await Promise.all(everyRoute(link.token, file.id))),
      ...(await Promise.all(everyRoute(UNKNOWN_TOKEN, file.id))),
      await visit(link.token, "", { headers: { cookie: "__Secure-holdfast.session_token=made-up" } }),
    ];
    for (const answer of answers) {
      expect(answer.status).not.toBe(401);
      expect(answer.headers["cache-control"]).toContain("no-store");
    }
  });

  it("RL_LINKS on EVERY public route: a refusing limiter answers 429 rate_limited with Retry-After, keyed by address", async () => {
    const { folder, file, link } = await folderLink();
    const routes: [string, Parameters<typeof visit>[2]][] = [
      ["", {}],
      ["/children", {}],
      [`/children/${folder.id}`, {}],
      ["/unlock", { json: { password: PASSWORD } }],
      ["/download-url", { json: { kind: "download", nodeId: file.id } }],
      ["/download-urls", { json: { zipGrant: "made-up-grant", nodeIds: [file.id] } }],
      ["/zip-manifest", { method: "POST" }],
    ];
    for (const [rest, options] of routes) {
      const keys: string[] = [];
      const refuse = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
      const answer = await visit(link.token, rest, {
        ...options,
        env: { RL_LINKS: refuse },
        ip: "198.51.100.23",
      });
      expect([answer.status, errorOf(answer).error], rest || "/").toEqual([429, "rate_limited"]);
      expect(answer.headers["retry-after"], rest || "/").toBe("60");
      expect(keys, rest || "/").toEqual(["ip:198.51.100.23"]);
    }
    // The control: an allowing limiter lets the same request through.
    expect((await visit(link.token)).status).toBe(200);
  });

  it("a refusal writes one link_access_log row with its stored outcome and the country; no address", async () => {
    const { file, link } = await folderLink({ password: PASSWORD });
    await mint(link.token, { kind: "download", nodeId: file.id }, { cf: { country: "NL" } });
    await setLink(link.id, { revokedAt: new Date() });
    await visit(link.token, "/children", { cf: { country: "NL" } });
    const rows = await accessLog(link.id);
    expect(rows.map((row) => row.outcome).sort()).toEqual(["denied_expired", "denied_password"]);
    for (const row of rows) {
      expect(row.country).toBe("NL");
      expect(row.ipHashDaily).toMatch(/^[0-9a-f]+$/);
      expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    }
  });
});
