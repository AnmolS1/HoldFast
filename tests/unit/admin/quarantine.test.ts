// The quarantine queue (T25 section 4): Mark false positive with its guard (only an `infected`
// node that is not taken down), the blocklist row it may remove, Rescan and the reasons the admin
// is told, and that no answer carries a content URL.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AdminQuarantineDetailDto, QuarantinePage } from "../../../src/shared/schemas/admin";
import { hashBlocklist, strikes } from "../../../src/worker/db/schema";
import {
  admin,
  adminCall,
  auditAbout,
  auditOf,
  blocklistRow,
  contentUrlsIn,
  lockedFile,
  madeUpSha,
  makeFile,
  makeFolder,
  member,
  nodeRowOf,
  strikesOfUser,
  testDb,
} from "./helpers";

const RELEASE = { action: "release", note: "The signature was a false match." } as const;

/** An infected file, its malware blocklist row (this node added it) and its uploader's malware strike. */
async function infected(overrides: Parameters<typeof makeFile>[2] = {}) {
  const owner = await member();
  const sha256 = madeUpSha();
  const file = await makeFile(owner.id, null, {
    scanStatus: "infected",
    sha256,
    scanDetail: { signatures: ["Eicar-Test"], pua: [], engine: "stub" },
    ...overrides,
  });
  await testDb().insert(hashBlocklist).values({ sha256, reason: "malware", sourceNodeId: file.id });
  const [strike] = await testDb()
    .insert(strikes)
    .values({ userId: owner.id, kind: "malware", nodeId: file.id, contentSha256: sha256 })
    .returning();
  return { owner, file, sha256, strike: strike! };
}

/** Everything the release could have written, as it is now. */
async function snapshot(nodeId: string, sha256: string, userId: string) {
  const node = await nodeRowOf(nodeId);
  return {
    scanStatus: node?.scanStatus,
    blocklist: await blocklistRow(sha256),
    strikes: (await strikesOfUser(userId)).map((s) => [s.id, s.liftedAt]),
    audit: (await auditAbout(nodeId)).length,
  };
}

describe("Mark false positive — the guard, one test per refused state", () => {
  const refused: [string, Parameters<typeof makeFile>[2]][] = [
    ["suspected_csam", { scanStatus: "suspected_csam" }],
    ["under_review", { scanStatus: "under_review" }],
    ["pending", { scanStatus: "pending" }],
    ["clean", { scanStatus: "clean" }],
    ["skipped", { scanStatus: "skipped", scanReason: "size" }],
    ["error", { scanStatus: "error", scanReason: "engine" }],
    ["infected and taken down", { scanStatus: "infected", takedownAt: new Date(), takedownReason: "admin" }],
  ];
  it.each(refused)("%s → 409 conflict, nothing written", async (_name, state) => {
    const who = await admin();
    const t = await infected(state);
    const before = await snapshot(t.file.id, t.sha256, t.owner.id);
    const answer = await adminCall(who.as, "POST", `/quarantine/${t.file.id}`, { body: RELEASE });
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe("conflict");
    expect(await snapshot(t.file.id, t.sha256, t.owner.id)).toEqual(before);
  });

  it("control: the same request on an infected, not-taken-down node → clean, its own entry removed, audited, the strike offered", async () => {
    const who = await admin();
    const t = await infected();
    const answer = await adminCall(who.as, "POST", `/quarantine/${t.file.id}`, { body: RELEASE });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ blocklistRemoved: true, malwareStrikeId: t.strike.id });
    expect(answer.body.node.scanStatus).toBe("clean");
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("clean");
    expect(await blocklistRow(t.sha256)).toBeNull();
    const rows = await auditOf("admin.false_positive", t.file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: who.id, actorType: "admin", targetType: "node" });
    // The strike is offered, not lifted.
    expect((await strikesOfUser(t.owner.id))[0]!.liftedAt).toBeNull();
  });

  it("a reason is required", async () => {
    const who = await admin();
    const t = await infected();
    const answer = await adminCall(who.as, "POST", `/quarantine/${t.file.id}`, {
      body: { action: "release" },
    });
    expect(answer.status).toBe(400);
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("infected");
  });
});

describe("Mark false positive removes only a blocklist row THIS node added as malware", () => {
  it("an entry another node added stays", async () => {
    const who = await admin();
    const t = await infected();
    const other = await makeFile(t.owner.id, null, { scanStatus: "infected", sha256: t.sha256 });
    await testDb()
      .update(hashBlocklist)
      .set({ sourceNodeId: other.id })
      .where(eq(hashBlocklist.sha256, t.sha256));
    const answer = await adminCall(who.as, "POST", `/quarantine/${t.file.id}`, { body: RELEASE });
    expect(answer.status).toBe(200);
    expect(answer.body.blocklistRemoved).toBe(false);
    expect(await blocklistRow(t.sha256)).toMatchObject({ reason: "malware", sourceNodeId: other.id });
  });

  it("an entry a lock RAISED to csam stays csam", async () => {
    const who = await admin();
    const t = await infected();
    await testDb()
      .update(hashBlocklist)
      .set({ reason: "csam", raisedFrom: "malware", raisedByNodeId: t.file.id })
      .where(eq(hashBlocklist.sha256, t.sha256));
    const answer = await adminCall(who.as, "POST", `/quarantine/${t.file.id}`, { body: RELEASE });
    expect(answer.status).toBe(200);
    expect(answer.body.blocklistRemoved).toBe(false);
    expect((await blocklistRow(t.sha256))!.reason).toBe("csam");
  });
});

describe("Rescan — the admin is told why nothing was queued", () => {
  const rescan = { action: "rescan" } as const;
  const rescanRows = async (nodeId: string) => (await auditOf("admin.rescan", nodeId)).length;

  it("a file taken down itself → { queued: false, reason: taken_down }, nothing audited", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, {
      scanStatus: "infected",
      takedownAt: new Date(),
      takedownReason: "admin",
    });
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: rescan });
    expect(answer.status).toBe(200);
    expect(answer.body.rescan).toEqual({ queued: false, reason: "taken_down" });
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("infected");
    expect(await rescanRows(file.id)).toBe(0);
  });

  it("a file two folders below a taken-down folder → taken_down (inherited)", async () => {
    const who = await admin();
    const owner = await member();
    const top = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "dmca" });
    const middle = await makeFolder(owner.id, top.id);
    const file = await makeFile(owner.id, middle.id, { scanStatus: "error", scanReason: "engine" });
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: rescan });
    expect(answer.body.rescan).toEqual({ queued: false, reason: "taken_down" });
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("error");
    expect(await rescanRows(file.id)).toBe(0);
  });

  it("suspected_csam → { queued: false, reason: locked }", async () => {
    const who = await admin();
    const t = await lockedFile();
    const answer = await adminCall(who.as, "POST", `/quarantine/${t.file.id}`, { body: rescan });
    expect(answer.body.rescan).toEqual({ queued: false, reason: "locked" });
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("suspected_csam");
    expect(await rescanRows(t.file.id)).toBe(0);
  });

  it("under_review → queued, the status kept; the audit row only when queued", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "under_review", scanStatusPrev: "clean" });
    const answer = await adminCall(who.as, "POST", `/quarantine/${file.id}`, { body: rescan });
    expect(answer.body.rescan).toEqual({ queued: true });
    expect((await nodeRowOf(file.id))!.scanStatus).toBe("under_review");
    const rows = await auditOf("admin.rescan", file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(who.id);
  });
});

describe("the list and the detail: the contracts, and never a content URL", () => {
  it("an infected, a locked and a taken-down node are listed; every item parses; no files-host URL anywhere", async () => {
    const who = await admin();
    const t = await infected({ mimeSniffed: "image/png", name: "photo.png" });
    const locked = await lockedFile();
    const list = await adminCall(who.as, "GET", "/quarantine?limit=200");
    expect(list.status).toBe(200);
    expect(QuarantinePage.safeParse(list.body).success).toBe(true);
    expect(contentUrlsIn(list.text)).toEqual([]);
    for (const nodeId of [t.file.id, locked.file.id]) {
      const detail = await adminCall(who.as, "GET", `/quarantine/${nodeId}`);
      expect(detail.status).toBe(200);
      expect(AdminQuarantineDetailDto.safeParse(detail.body).error?.issues ?? []).toEqual([]);
      expect(contentUrlsIn(detail.text)).toEqual([]);
      expect(detail.body.item.node.thumb).toBe(false);
    }
    const lockedDetail = await adminCall(who.as, "GET", `/quarantine/${locked.file.id}`);
    expect(lockedDetail.body.holds).toEqual(expect.arrayContaining(["suspected_csam", "node_legal_hold"]));
    const infectedDetail = await adminCall(who.as, "GET", `/quarantine/${t.file.id}`);
    expect(infectedDetail.body.item.signatures).toEqual(["Eicar-Test"]);
    expect(infectedDetail.body.malwareStrikeId).toBe(t.strike.id);
  });

  it("the status filter: taken_down lists a taken-down folder as ONE row", async () => {
    const who = await admin();
    const owner = await member();
    const top = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "dmca" });
    await makeFile(owner.id, top.id, { scanStatus: "clean" });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await adminCall(
        who.as,
        "GET",
        `/quarantine?status=taken_down&limit=200${cursor ? `&cursor=${cursor}` : ""}`,
      );
      ids.push(...page.body.items.map((item: { node: { id: string } }) => item.node.id));
      cursor = page.body.nextCursor;
    } while (cursor && !ids.includes(top.id));
    expect(ids).toContain(top.id);
  });
});
