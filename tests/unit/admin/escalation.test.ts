// Escalate to `suspected_csam` (T25 section 5, ruling 2026-10-13), both branches: a `csam`
// report IS the case and stays open; any other report is closed as `actioned`, pointing at the
// `csam` report the lock filed. And the invariant: `actioned` on a `csam` report ⇔ filed.
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reports } from "../../../src/worker/db/schema";
import {
  admin,
  adminCall,
  linkRowOf,
  lockedFile,
  makeFile,
  makeFolder,
  makeLink,
  member,
  nodeRowOf,
  operators,
  reportRowOf,
  reported,
  testDb,
  userRowOf,
} from "./helpers";

const escalate = { action: "escalate_csam", resolution: "Escalated after review." };

async function reportedFile(category: Parameters<typeof reported>[2]) {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const link = await makeLink(file.id, owner.id);
  const reportId = await reported(file.id, owner.id, category);
  return { owner, file, link, reportId };
}

const csamReportsOn = (nodeId: string) =>
  testDb()
    .select()
    .from(reports)
    .where(and(eq(reports.nodeId, nodeId), eq(reports.category, "csam")));

describe("escalation", () => {
  it("(a) a csam-category report: the lock returns THE SAME report, which stays open as the case; ncmec/start works on it", async () => {
    const who = await admin();
    const ops = operators();
    const t = await reportedFile("csam");
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
      body: escalate,
      env: ops.env,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.csamReportId).toBe(t.reportId);
    expect((await reportRowOf(t.reportId))!.status).toBe("open");
    const node = await nodeRowOf(t.file.id);
    expect([node!.scanStatus, node!.legalHold]).toEqual(["suspected_csam", true]);
    expect((await userRowOf(t.owner.id))!.legalHold).toBe(true);
    expect((await linkRowOf(t.link.id)).pauseReasons).toContain("moderation");
    expect(await csamReportsOn(t.file.id)).toHaveLength(1);

    const start = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/start`);
    expect(start.status).toBe(200);
    expect(start.body.status).toBe("reviewing");
  });

  it("(b) another category: a csam report is filed, the original is actioned pointing at it; a second report on the node returns the SAME case", async () => {
    const who = await admin();
    const ops = operators();
    const t = await reportedFile("other");
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/action`, {
      body: escalate,
      env: ops.env,
    });
    expect(answer.status).toBe(200);
    const csamId = answer.body.csamReportId as string;
    expect(csamId).not.toBe(t.reportId);
    const csam = await reportRowOf(csamId);
    expect([csam!.category, csam!.nodeId, csam!.status]).toEqual(["csam", t.file.id, "open"]);
    const original = await reportRowOf(t.reportId);
    expect([original!.status, original!.resolution]).toEqual(["actioned", `escalated_csam:${csamId}`]);

    const second = await reported(t.file.id, t.owner.id, "spam");
    const again = await adminCall(who.as, "POST", `/reports/${second}/action`, {
      body: escalate,
      env: ops.env,
    });
    expect(again.status).toBe(200);
    expect(again.body.csamReportId).toBe(csamId);
    // Control: exactly one csam report on the node — no second case was filed.
    expect((await csamReportsOn(t.file.id)).map((r) => r.id)).toEqual([csamId]);
    expect((await reportRowOf(second))!.resolution).toBe(`escalated_csam:${csamId}`);
  });

  it("a folder cannot be locked: 409 folder, nothing written; control: the file inside is locked", async () => {
    const who = await admin();
    const ops = operators();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const inner = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const folderReport = await reported(folder.id, owner.id, "csam");
    const refused = await adminCall(who.as, "POST", `/reports/${folderReport}/action`, {
      body: escalate,
      env: ops.env,
    });
    expect([refused.status, refused.body.details?.reason]).toEqual([409, "folder"]);
    const after = await nodeRowOf(folder.id);
    expect([after!.scanStatus, after!.legalHold]).toEqual(["under_review", false]);
    expect((await userRowOf(owner.id))!.legalHold).toBe(false);
    expect((await reportRowOf(folderReport))!.status).toBe("open");

    const fileReport = await reported(inner.id, owner.id, "csam");
    const locked = await adminCall(who.as, "POST", `/reports/${fileReport}/action`, {
      body: escalate,
      env: ops.env,
    });
    expect(locked.status).toBe(200);
    expect((await nodeRowOf(inner.id))!.scanStatus).toBe("suspected_csam");
    expect((await userRowOf(owner.id))!.legalHold).toBe(true);
  });

  it("THE INVARIANT: no section-5 action leaves a csam report actioned without ncmecFiledAt", async () => {
    const who = await admin();
    const ops = operators();
    const locked = await lockedFile();
    const userCsam = await reportedFile("csam");
    const other = await reportedFile("other");
    const actions = ["dismiss", "takedown", "strike", "escalate_csam"];
    for (const reportId of [locked.reportId, userCsam.reportId]) {
      for (const action of actions) {
        await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
          body: { action, resolution: `Tried ${action}.` },
          env: ops.env,
        });
      }
      await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/start`);
    }
    await adminCall(who.as, "POST", `/reports/${other.reportId}/action`, { body: escalate, env: ops.env });
    const nodes = [locked.file.id, userCsam.file.id, other.file.id];
    const rows = await testDb()
      .select()
      .from(reports)
      .where(and(inArray(reports.nodeId, nodes), eq(reports.category, "csam")));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      if (row.status === "actioned") expect(row.ncmecFiledAt, row.id).not.toBeNull();
    }
    // The csam reports are still cases: open, reviewing or (the merely-under-review one) dismissed.
    expect(rows.every((row) => row.status !== "actioned")).toBe(true);
  });
});
