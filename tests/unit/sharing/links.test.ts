// Public links as their owner manages them: create, list, change, pause, revoke, activity. Every
// password here is made up.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pauseLinks } from "../../../src/worker/db/queries/links";
import { auditLog, linkAccessLog, nodes, shareLinks, type PauseReason } from "../../../src/worker/db/schema";
import { hashLinkToken } from "../../../src/worker/services/tokens";
import {
  api,
  asCaller,
  envelope,
  errorOf,
  ledgerOf,
  linkById,
  linksOn,
  makeFile,
  makeFolder,
  makeLink,
  member,
  settingsWith,
  testDb,
  utcDayOf,
} from "./helpers";

type LinkDto = {
  id: string;
  nodeId: string;
  node: { name: string; kind: string };
  url: string | null;
  state: string;
  pausedReasons: string[];
  canUnpause: boolean;
  expiresAt: string | null;
  hasPassword: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  allowPreview: boolean;
  limitedToday?: boolean;
};

type Member = Awaited<ReturnType<typeof member>>;
const PASSWORD = "made-up link password";

const createLink = (
  owner: Member,
  nodeId: string,
  json: unknown = { allowPreview: true },
  settings = settingsWith(),
) => api(asCaller(owner), `/nodes/${nodeId}/links`, { json, settings });

const mine = async (owner: Member, settings = settingsWith()) =>
  (await api(asCaller(owner), "/links/mine", { settings })).body as LinkDto[];

const patch = (owner: Member, linkId: string, json: unknown) =>
  api(asCaller(owner), `/links/${linkId}`, { method: "PATCH", json });

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("POST /nodes/:id/links", () => {
  it("a folder and a clean file: 201 LinkDto; the URL is the same on a later read; no table holds the token", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id, null, { name: "Linked folder" });
    const file = await makeFile(owner.id, null, { scanStatus: "clean", name: "linked.txt" });
    const made = await createLink(owner, folder.id, {
      allowPreview: false,
      maxDownloads: 3,
      password: PASSWORD,
    });
    expect(made.status).toBe(201);
    const dto = made.body as LinkDto;
    expect(dto).toMatchObject({
      nodeId: folder.id,
      node: { name: "Linked folder", kind: "folder" },
      state: "active",
      pausedReasons: [],
      canUnpause: false,
      hasPassword: true,
      maxDownloads: 3,
      downloadCount: 0,
      allowPreview: false,
      limitedToday: false,
    });
    expect(dto.url).toMatch(/^http:\/\/localhost\/s\/[A-Za-z0-9_-]{22}$/);
    expect((await createLink(owner, file.id)).status).toBe(201);

    const again = (await mine(owner)).find((link) => link.id === dto.id);
    expect(again?.url).toBe(dto.url);

    const token = tokenOf(dto.url!);
    const [row] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, dto.id));
    expect(row!.tokenHash).toBe(await hashLinkToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.passwordHash).toMatch(/^scrypt\$16384\$16\$1\$/);
    const audits = await testDb().select().from(auditLog).where(eq(auditLog.targetId, folder.id));
    expect(audits.map((a) => a.action)).toContain("link.create");
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it("url is null under impersonation; a sealed token moved to another row gives url null, never the other link's", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const a = (await createLink(owner, folder.id)).body as LinkDto;
    const b = (await createLink(owner, folder.id)).body as LinkDto;
    const impersonated = await api({ user: owner, impersonatedBy: "a".repeat(32) }, "/links/mine");
    expect(impersonated.status).toBe(200);
    for (const link of impersonated.body as LinkDto[]) expect(link.url).toBeNull();

    const [rowA] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, a.id));
    await testDb()
      .update(shareLinks)
      .set({ tokenEnc: rowA!.tokenEnc, tokenIv: rowA!.tokenIv })
      .where(eq(shareLinks.id, b.id));
    const listed = await mine(owner);
    expect(listed.find((link) => link.id === b.id)?.url).toBeNull();
    expect(listed.find((link) => link.id === a.id)?.url).toBe(a.url);
  });

  it("linksEnabled off → 503 feature_disabled links_disabled, no row", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const off = await createLink(
      owner,
      folder.id,
      { allowPreview: true },
      settingsWith({ linksEnabled: false }),
    );
    expect([off.status, errorOf(off).error, errorOf(off).details]).toEqual([
      503,
      "feature_disabled",
      { reason: "links_disabled" },
    ]);
    expect(await linksOn(folder.id)).toHaveLength(0);
  });

  it("a file not clean 409/403; hidden or suspected CSAM 404 like an unknown id; a non-owner 403/404; a past expiry 400", async () => {
    const owner = await member();
    const stranger = await member();
    const pending = await makeFile(owner.id, null, { scanStatus: "pending" });
    const infected = await makeFile(owner.id, null, { scanStatus: "infected" });
    expect(errorOf(await createLink(owner, pending.id)).error).toBe("scan_pending");
    expect(errorOf(await createLink(owner, infected.id)).error).toBe("scan_blocked");
    const reference = envelope(await createLink(owner, "0199d3c2-7a10-7000-8000-00000000abcd"));
    expect(reference).toMatchObject({ status: 404, error: "not_found" });
    const down = await makeFolder(owner.id);
    const inside = await makeFile(owner.id, (await makeFolder(owner.id, down.id)).id, {
      scanStatus: "clean",
    });
    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, down.id));
    const csam = await makeFile(owner.id, null, { scanStatus: "suspected_csam" });
    expect(envelope(await createLink(owner, down.id))).toEqual(reference);
    expect(envelope(await createLink(owner, inside.id))).toEqual(reference);
    expect(envelope(await createLink(owner, csam.id))).toEqual(reference);
    const folder = await makeFolder(owner.id);
    expect(envelope(await createLink(stranger, folder.id))).toEqual(reference);
    const past = await createLink(owner, folder.id, {
      allowPreview: true,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect([past.status, errorOf(past).error]).toEqual([400, "validation"]);
    for (const node of [pending, infected, down, inside, csam, folder])
      expect(await linksOn(node.id)).toHaveLength(0);
  });

  it("link_user: CEIL_LINKS_DAY reached → the thrown 429, rolled back: no row, no ledger unit", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const today = utcDayOf(new Date());
    const refused = await createLink(
      owner,
      folder.id,
      { allowPreview: true },
      settingsWith({ ceilings: { CEIL_LINKS_DAY: 0 } }),
    );
    expect([refused.status, errorOf(refused).error, errorOf(refused).details]).toEqual([
      429,
      "ceiling_exceeded",
      { kind: "link_user", dimension: "count" },
    ]);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(await linksOn(folder.id)).toHaveLength(0);
    expect(await ledgerOf("link_user", owner.id, today)).toEqual({ bytes: 0, count: 0 });
  });

  it("NEW_ACCOUNT_MAX_LINKS under concurrency: at cap − 1, two parallel creations → one 201, one 429, one new row", async () => {
    const young = await member();
    const folder = await makeFolder(young.id);
    const settings = settingsWith({
      ceilings: { NEW_ACCOUNT_DAYS: 30, NEW_ACCOUNT_FACTOR: 1, NEW_ACCOUNT_MAX_LINKS: 3 },
    });
    await makeLink(folder.id, young.id);
    await makeLink(folder.id, young.id);
    const both = await Promise.all([
      createLink(young, folder.id, { allowPreview: true }, settings),
      createLink(young, folder.id, { allowPreview: true }, settings),
    ]);
    expect(both.map((answer) => answer.status).sort()).toEqual([201, 429]);
    expect(await linksOn(folder.id)).toHaveLength(3);
    const refused = both.find((answer) => answer.status === 429)!;
    expect(errorOf(refused).details).toEqual({ kind: "link_user", dimension: "count" });
  });
});

describe("PATCH /links/:id", () => {
  it("{} is 400; a stranger's PATCH is 404 like an unknown id", async () => {
    const owner = await member();
    const stranger = await member();
    const link = (await createLink(owner, (await makeFolder(owner.id)).id)).body as LinkDto;
    const empty = await patch(owner, link.id, {});
    expect([empty.status, errorOf(empty).error]).toEqual([400, "validation"]);
    const foreign = await patch(stranger, link.id, { allowPreview: false });
    const unknown = await patch(stranger, "0199d3c2-7a10-7000-8000-00000000dddd", { allowPreview: false });
    expect(envelope(foreign)).toEqual(envelope(unknown));
    expect(foreign.status).toBe(404);
  });

  it("changing the password writes passwordHash and nothing else (no other column, no other link)", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const link = (await createLink(owner, folder.id)).body as LinkDto;
    const other = (await createLink(owner, folder.id)).body as LinkDto;
    const before = await linkById(link.id);
    const otherBefore = await linkById(other.id);
    const answer = await patch(owner, link.id, { password: PASSWORD });
    expect(answer.status).toBe(200);
    expect((answer.body as LinkDto).hasPassword).toBe(true);
    const after = await linkById(link.id);
    expect({ ...after, passwordHash: null }).toEqual({ ...before, passwordHash: null });
    expect(after.passwordHash).toMatch(/^scrypt\$/);
    expect(await linkById(other.id)).toEqual(otherBefore);
    const removed = await patch(owner, link.id, { password: null });
    expect((removed.body as LinkDto).hasPassword).toBe(false);
    expect((await linkById(link.id)).passwordHash).toBeNull();
  });

  it("the owner pauses and resumes: { owner } empties the set", async () => {
    const owner = await member();
    const link = (await createLink(owner, (await makeFolder(owner.id)).id)).body as LinkDto;
    const paused = (await patch(owner, link.id, { paused: true })).body as LinkDto;
    expect(paused).toMatchObject({ state: "paused", pausedReasons: ["owner"], canUnpause: true });
    const resumed = await patch(owner, link.id, { paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ state: "active", pausedReasons: [], canUnpause: false });
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
  });

  it("resume is refused (403, the set unchanged) for every set the owner may not clear, and for a locked link", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const sets: PauseReason[][] = [
      ["report"],
      ["moderation"],
      ["owner_deletion"],
      ["owner_suspended"],
      ["anomaly"],
      ["owner", "anomaly"],
      ["owner", "report"],
    ];
    for (const set of sets) {
      const row = await makeLink(folder.id, owner.id, set);
      const answer = await patch(owner, row.id, { paused: false });
      expect([answer.status, errorOf(answer).error], set.join(",")).toEqual([403, "forbidden"]);
      expect((await linkById(row.id)).pauseReasons).toEqual(set);
    }
    const locked = await makeLink(folder.id, owner.id, ["owner"]);
    await testDb().update(shareLinks).set({ lockedByAdmin: true }).where(eq(shareLinks.id, locked.id));
    expect((await patch(owner, locked.id, { paused: false })).status).toBe(403);
    expect((await linkById(locked.id)).pauseReasons).toEqual(["owner"]);
    // The control: an { owner } set resumes.
    const own = await makeLink(folder.id, owner.id, ["owner"]);
    expect((await patch(owner, own.id, { paused: false })).status).toBe(200);
    expect((await linkById(own.id)).pauseReasons).toEqual([]);
  });
});

describe("DELETE /links/:id", () => {
  it("revokes (state revoked), once; a stranger gets 404", async () => {
    const owner = await member();
    const stranger = await member();
    const link = (await createLink(owner, (await makeFolder(owner.id)).id)).body as LinkDto;
    expect((await api(asCaller(stranger), `/links/${link.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await api(asCaller(owner), `/links/${link.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(asCaller(owner), `/links/${link.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await linkById(link.id)).revokedAt).not.toBeNull();
    expect((await mine(owner)).find((l) => l.id === link.id)?.state).toBe("revoked");
  });
});

describe("DELETE /links/:id — decided by who created the link (Addendum 6)", () => {
  it("a link on a node inside a taken-down folder: listed, and revoked by its creator — access ends", async () => {
    const owner = await member();
    const down = await makeFolder(owner.id);
    const file = await makeFile(owner.id, (await makeFolder(owner.id, down.id)).id, { scanStatus: "clean" });
    const made = (await createLink(owner, file.id)).body as LinkDto;
    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, down.id));
    await pauseLinks(testDb(), { subtreeOf: down.id }, "moderation");
    expect((await mine(owner)).some((link) => link.id === made.id)).toBe(true);
    expect((await api(asCaller(owner), `/links/${made.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await linkById(made.id)).revokedAt).not.toBeNull();
    const visit = await api(null, `/public/links/${made.url!.slice(made.url!.lastIndexOf("/") + 1)}`);
    expect([visit.status, (visit.body as { details?: { reason?: string } }).details?.reason]).toEqual([
      410,
      "revoked",
    ]);
    // PATCH still asks for the node: a hidden node's link is not changed.
    expect((await patch(owner, made.id, { allowPreview: false })).status).toBe(404);
  });

  it("a link on a legally held node of a held owner: revoked, its row and its access log kept", async () => {
    const owner = await member({ legalHold: true });
    const file = await makeFile(owner.id, null, { scanStatus: "clean", legalHold: true });
    const made = (await createLink(owner, file.id)).body as LinkDto;
    await testDb()
      .insert(linkAccessLog)
      .values({ linkId: made.id, nodeId: file.id, outcome: "ok", ipHashDaily: "made-up-hash" });
    expect((await api(asCaller(owner), `/links/${made.id}`, { method: "DELETE" })).status).toBe(204);
    const row = await linkById(made.id);
    expect(row.revokedAt).not.toBeNull();
    expect(await testDb().select().from(linkAccessLog).where(eq(linkAccessLog.linkId, made.id))).toHaveLength(
      1,
    );
  });

  it("anyone but the creator gets 404, like an unknown id — the link untouched", async () => {
    const owner = await member();
    const stranger = await member();
    const made = (await createLink(owner, (await makeFolder(owner.id)).id)).body as LinkDto;
    const foreign = await api(asCaller(stranger), `/links/${made.id}`, { method: "DELETE" });
    const unknown = await api(asCaller(stranger), "/links/0199d3c2-7a10-7000-8000-00000000cccc", {
      method: "DELETE",
    });
    expect(envelope(foreign)).toEqual(envelope(unknown));
    expect(foreign.status).toBe(404);
    expect((await linkById(made.id)).revokedAt).toBeNull();
  });
});

describe("GET /links/mine", () => {
  it("every link with its state; a link inside a taken-down folder reads paused ['review'] once the subtree pause is applied", async () => {
    const owner = await member();
    const top = await makeFolder(owner.id);
    const mid = await makeFolder(owner.id, top.id);
    const file = await makeFile(owner.id, mid.id, { scanStatus: "clean" });
    const onFile = (await createLink(owner, file.id)).body as LinkDto;
    const expired = await makeLink(top.id, owner.id);
    await testDb()
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shareLinks.id, expired.id));
    const capped = await makeLink(top.id, owner.id);
    await testDb()
      .update(shareLinks)
      .set({ maxDownloads: 2, downloadCount: 2 })
      .where(eq(shareLinks.id, capped.id));

    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, top.id));
    await pauseLinks(testDb(), { subtreeOf: top.id }, "moderation");
    const listed = new Map((await mine(owner)).map((link) => [link.id, link]));
    expect(listed.get(onFile.id)).toMatchObject({
      state: "paused",
      pausedReasons: ["review"],
      canUnpause: false,
    });
    expect(listed.get(expired.id)?.state).toBe("expired");
    expect(listed.get(capped.id)?.state).toBe("limit_reached");
  });
});

describe("GET /links/:id/activity", () => {
  it("stored refusals for scan and owner go out as `refused` only; no key outside the enum; a link on a hidden node is still answered", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const link = (await createLink(owner, folder.id)).body as LinkDto;
    const row = (
      outcome: (typeof linkAccessLog.outcome.enumValues)[number],
      country: string | null = "DE",
    ) => ({
      linkId: link.id,
      nodeId: folder.id,
      outcome,
      country,
      ipHashDaily: "made-up-hash",
    });
    await testDb()
      .insert(linkAccessLog)
      .values([
        row("ok"),
        row("ok", "FR"),
        row("denied_scan"),
        row("denied_owner"),
        row("denied_password"),
        row("denied_cap"),
      ]);
    await testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, folder.id));
    const answer = await api(asCaller(owner), `/links/${link.id}/activity`);
    expect(answer.status).toBe(200);
    const body = answer.body as {
      days: { day: string; downloads: number }[];
      countries: { country: string; downloads: number }[];
      outcomes: Record<string, number>;
    };
    expect(body.outcomes).toEqual({ ok: 2, refused: 2, password: 1, limit: 1 });
    for (const key of Object.keys(body.outcomes)) {
      expect(["ok", "password", "expired", "limit", "paused", "refused"]).toContain(key);
    }
    expect(body.countries).toEqual([
      { country: "DE", downloads: 1 },
      { country: "FR", downloads: 1 },
    ]);
    expect(body.days).toEqual([{ day: utcDayOf(new Date()), downloads: 2, bytes: 0 }]);
    expect(JSON.stringify(body)).not.toContain("made-up-hash");
    expect(JSON.stringify(body)).not.toContain("denied");
    const stranger = await member();
    expect((await api(asCaller(stranger), `/links/${link.id}/activity`)).status).toBe(404);
    void sql;
  });
});
