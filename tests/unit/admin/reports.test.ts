// Reports (T25 section 5): the list and its filters, the detail (metadata only, the lock record
// and every time operators were told), Dismiss and Action — and that Dismiss never closes the
// `csam` case of a LOCKED file (only "Clear lock" does).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AdminNodeDto, ReportDetailDto, ReportPage } from "../../../src/shared/schemas/admin";
import { csamLocksWithoutReport } from "../../../src/worker/db/queries/moderation";
import { reports, shareLinks, strikes } from "../../../src/worker/db/schema";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { mailTo } from "../auth/helpers";
import {
  admin,
  adminCall,
  auditOf,
  contentUrlsIn,
  linkRowOf,
  lockedFile,
  makeFile,
  makeFolder,
  makeLink,
  member,
  nodeRowOf,
  oldVersion,
  rand,
  reportRowOf,
  reported,
  serviceDeps,
  strikesOfUser,
  testDb,
  uploadAddress,
} from "./helpers";

const dismiss = (resolution?: string) => ({
  action: "dismiss",
  ...(resolution === undefined ? {} : { resolution }),
});

/** A clean file of a fresh owner, reported (`under_review`, links paused `report`). */
async function reportedFile(
  category: Parameters<typeof reported>[2] = "other",
  scanStatus: "clean" | "pending" = "clean",
) {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus });
  const link = await makeLink(file.id, owner.id);
  const reportId = await reported(file.id, owner.id, category);
  return { owner, file, link, reportId };
}

describe("the report list", () => {
  it("filters by status, category, source and age; every item matches; pages by cursor", async () => {
    const who = await admin();
    const a = await reportedFile("phishing");
    await testDb()
      .update(reports)
      .set({ createdAt: new Date(Date.now() - 48 * 3_600_000) })
      .where(eq(reports.id, a.reportId));
    const b = await reportedFile("spam");

    const bySpam = await adminCall(who.as, "GET", "/reports?status=open&category=spam&source=user&limit=200");
    expect(bySpam.status).toBe(200);
    const page = ReportPage.parse(bySpam.body);
    expect(page.items.map((r) => r.id)).toContain(b.reportId);
    for (const r of page.items) expect([r.status, r.category, r.source]).toEqual(["open", "spam", "user"]);

    // Older than 24 h: the backdated one is found (walk the pages), the new one never.
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      const answer = await adminCall(
        who.as,
        "GET",
        `/reports?category=phishing&olderThanHours=24&limit=200${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const got = ReportPage.parse(answer.body);
      for (const r of got.items) expect(Date.parse(r.createdAt)).toBeLessThan(Date.now() - 24 * 3_600_000);
      seen.push(...got.items.map((r) => r.id));
      cursor = got.nextCursor;
      if (!cursor || seen.includes(a.reportId)) break;
    }
    expect(seen).toContain(a.reportId);
    expect(seen).not.toContain(b.reportId);

    // Paging: limit 1 gives a cursor, and the next page is older.
    const first = ReportPage.parse((await adminCall(who.as, "GET", "/reports?limit=1")).body);
    expect(first.nextCursor).not.toBeNull();
    const second = ReportPage.parse(
      (await adminCall(who.as, "GET", `/reports?limit=1&cursor=${first.nextCursor}`)).body,
    );
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(Date.parse(second.items[0]!.createdAt)).toBeLessThanOrEqual(Date.parse(first.items[0]!.createdAt));
  });
});

describe("the report detail", () => {
  it("metadata only: open count and distinct reporters, the uploader's account age and strikes, the link summary", async () => {
    const who = await admin();
    const t = await reportedFile("malware");
    await reported(t.file.id, t.owner.id, "malware");
    await testDb()
      .update(shareLinks)
      .set({ downloadCount: 3, bytesServed: 300 })
      .where(eq(shareLinks.id, t.link.id));
    await testDb().insert(strikes).values({ userId: t.owner.id, kind: "abuse" });
    const answer = await adminCall(who.as, "GET", `/reports/${t.reportId}`);
    expect(answer.status).toBe(200);
    const detail = ReportDetailDto.parse(answer.body);
    expect(detail).toMatchObject({
      openOnNode: 2,
      distinctReporters: 2,
      links: { count: 1, downloads: 3, bytesServed: 300 },
      locked: null,
      alerts: [],
      nodeIsFolder: false,
      releasableAt: null,
    });
    expect(detail.uploader).toMatchObject({ id: t.owner.id, createdAt: t.owner.row.createdAt.toISOString() });
    expect(detail.uploader!.strikes.map((s) => s.state)).toEqual(["active"]);
    expect(contentUrlsIn(answer.text)).toEqual([]);
  });

  it("a locked file: when it was locked (its real source) and each time operators were told — a count, never an address", async () => {
    const who = await admin();
    const t = await lockedFile();
    const answer = await adminCall(who.as, "GET", `/reports/${t.reportId}`);
    const detail = ReportDetailDto.parse(answer.body);
    expect(detail.locked).toMatchObject({ source: "admin" });
    expect(detail.alerts).toHaveLength(1);
    expect(detail.alerts[0]).toMatchObject({ via: "lock", recipients: 1 });
    expect(answer.text).not.toContain(t.ops.address);
  });

  it('a lock with nobody told has no alert row: `alerts: []` (the console\'s "operators not yet reached")', async () => {
    const who = await admin();
    // Nobody to tell: the lock is recorded, no mail goes and no alert row is written.
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: rand(32) });
    const service = serviceDeps({ ADMIN_EMAILS: "", E2E_ADMIN_EMAILS: "" });
    const { reportId } = await lockSuspectedCsam(service.deps, file.id, { source: "admin" });
    await service.settle();
    const detail = ReportDetailDto.parse((await adminCall(who.as, "GET", `/reports/${reportId}`)).body);
    expect(detail.locked).toMatchObject({ source: "admin" });
    expect(detail.alerts).toEqual([]);
  });
});

describe("Dismiss", () => {
  it("needs a typed reason: absent or empty → 400, nothing written", async () => {
    const who = await admin();
    const t = await reportedFile();
    for (const body of [dismiss(), dismiss(""), dismiss("   ")]) {
      const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, { body });
      expect(answer.status).toBe(400);
    }
    expect((await reportRowOf(t.reportId))!.status).toBe("open");
  });

  it("the last open report: dismissed, the node gets its saved status back, links lose `report` only", async () => {
    const who = await admin();
    const t = await reportedFile();
    const owned = await makeLink(t.file.id, t.owner.id, ["owner"]);
    await reported(t.file.id, t.owner.id); // keeps the second link's `report` in step
    const other = (await testDb().select().from(reports).where(eq(reports.nodeId, t.file.id))).find(
      (r) => r.id !== t.reportId,
    )!;
    expect(
      (await adminCall(who.as, "POST", `/reports/${other.id}/action`, { body: dismiss("No.") })).status,
    ).toBe(200);
    // One still open: nothing restored, nothing unpaused.
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("under_review");
    expect((await linkRowOf(t.link.id)).pauseReasons).toEqual(["report"]);

    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
      body: dismiss("Not abuse."),
    });
    expect(answer.status).toBe(200);
    expect(answer.body.report).toMatchObject({ status: "dismissed", resolution: "Not abuse." });
    const row = await reportRowOf(t.reportId);
    expect(row!.resolvedAt).not.toBeNull();
    const node = await nodeRowOf(t.file.id);
    expect([node!.scanStatus, node!.scanStatusPrev]).toEqual(["clean", null]);
    expect((await linkRowOf(t.link.id)).pauseReasons).toEqual([]);
    expect((await linkRowOf(owned.id)).pauseReasons).toEqual(["owner"]);
    expect(await auditOf("admin.report_dismissed", t.reportId)).toHaveLength(1);
  });

  it("a node whose saved status was `pending` is scanned again", async () => {
    const who = await admin();
    const t = await reportedFile("other", "pending");
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
      body: dismiss("Fine."),
    });
    expect(answer.status).toBe(200);
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("pending");
    expect(await auditOf("scan.rescan_requested", t.file.id)).toHaveLength(1);
  });

  it("never closes the csam case of a LOCKED file: 409 csam_locked, report and node unchanged, the case stays", async () => {
    const who = await admin();
    const t = await lockedFile();
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
      body: dismiss("Looks fine."),
    });
    expect([answer.status, answer.body.details?.reason]).toEqual([409, "csam_locked"]);
    expect((await reportRowOf(t.reportId))!.status).toBe("open");
    expect((await nodeRowOf(t.file.id))!.scanStatus).toBe("suspected_csam");
    // T22's hourly sweepUnrecordedCsamLocks walks exactly this predicate (the sweep itself is
    // table-wide): a locked file with an open case is not listed — nothing would be re-filed.
    const owed = await csamLocksWithoutReport(testDb(), 1000);
    expect(owed.map((row) => row.nodeId)).not.toContain(t.file.id);
  });

  it("control: a csam-category report whose file is merely under review is dismissed", async () => {
    const who = await admin();
    const t = await reportedFile("csam");
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
      body: dismiss("Not csam."),
    });
    expect(answer.status).toBe(200);
    expect((await reportRowOf(t.reportId))!.status).toBe("dismissed");
  });

  it("the reporter who left an address is told only that the report was reviewed", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const email = `reporter-${rand(6)}@example.test`;
    const reportId = await reported(file.id, owner.id, "spam", { reporterEmail: email });
    expect(
      (await adminCall(who.as, "POST", `/reports/${reportId}/action`, { body: dismiss("Fine.") })).status,
    ).toBe(200);
    expect(mailTo(email, "reportReviewed")).toHaveLength(1);
    expect(mailTo(email)).toHaveLength(1);
  });
});

describe("Action", () => {
  it("take down: the node down (reason abuse, by the admin), the subtree's links paused `moderation`, the report actioned", async () => {
    const who = await admin();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const inner = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const link = await makeLink(inner.id, owner.id);
    const reportId = await reported(folder.id, owner.id, "other");
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "takedown", resolution: "Abusive." },
    });
    expect(answer.status).toBe(200);
    const node = await nodeRowOf(folder.id);
    expect([node!.takedownReason, node!.takedownBy]).toEqual(["abuse", who.id]);
    expect(node!.takedownAt).not.toBeNull();
    expect((await linkRowOf(link.id)).pauseReasons).toContain("moderation");
    expect((await reportRowOf(reportId))!.status).toBe("actioned");
  });

  it("strike: the uploader of the CURRENT version — not the earlier version's — and the report actioned", async () => {
    const who = await admin();
    const owner = await member();
    const [e1, e2] = [await member(), await member()];
    const file = await makeFile(owner.id, null, { scanStatus: "clean", createdBy: e2.id });
    const v1 = await oldVersion(file.id, owner.id, e1.id);
    await uploadAddress(file.id, v1, e1.id, "192.0.2.21");
    await uploadAddress(file.id, file.versionId!, e2.id, "198.51.100.22");
    const reportId = await reported(file.id, owner.id, "other");
    const answer = await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "strike", resolution: "Abuse confirmed." },
    });
    expect(answer.status).toBe(200);
    expect((await strikesOfUser(e2.id)).map((s) => s.reportId)).toEqual([reportId]);
    expect(await strikesOfUser(e1.id)).toEqual([]);
    expect(await strikesOfUser(owner.id)).toEqual([]);
    expect((await reportRowOf(reportId))!.status).toBe("actioned");
  });

  it("neither is offered on a csam-category report: 409 csam_report, nothing written", async () => {
    const who = await admin();
    const t = await reportedFile("csam");
    for (const action of ["takedown", "strike"]) {
      const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
        body: { action, resolution: "Tried." },
      });
      expect([answer.status, answer.body.details?.reason]).toEqual([409, "csam_report"]);
    }
    const node = await nodeRowOf(t.file.id);
    expect([node!.takedownAt, node!.scanStatus]).toEqual([null, "under_review"]);
    expect(await strikesOfUser(t.owner.id)).toEqual([]);
    expect((await reportRowOf(t.reportId))!.status).toBe("open");
  });
});

describe("no content in the reports API", () => {
  it("under_review and suspected_csam nodes: no files-host URL anywhere, every node an AdminNodeDto", async () => {
    const who = await admin();
    const review = await reportedFile("malware");
    const locked = await lockedFile();
    const list = await adminCall(who.as, "GET", "/reports?status=open&limit=200");
    expect(contentUrlsIn(list.text)).toEqual([]);
    const items = ReportPage.parse(list.body).items.filter((r) =>
      [review.reportId, locked.reportId].includes(r.id),
    );
    expect(items).toHaveLength(2);
    for (const item of items) AdminNodeDto.strict().parse(item.node);
    for (const id of [review.reportId, locked.reportId]) {
      const detail = await adminCall(who.as, "GET", `/reports/${id}`);
      expect(contentUrlsIn(detail.text)).toEqual([]);
      AdminNodeDto.strict().parse(detail.body.report.node);
    }
  });
});
