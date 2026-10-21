// Report intake (T22 steps 1–2, decision D6): proof of access before anything else, then a report
// that pauses and hides — reversibly — and nothing more.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HEADER_LINK_SESSION } from "../../../src/shared/constants";
import { TURNSTILE_TEST_SECRET_FAIL } from "../../../src/worker/auth/test-outbound";
import { dismissReview } from "../../../src/worker/db/queries/moderation";
import {
  hashBlocklist,
  nodes,
  shareLinks,
  strikes,
  user,
  type ScanStatus,
} from "../../../src/worker/db/schema";
import { ipHashStable } from "../../../src/worker/services/ip-hash";
import {
  fileReport,
  FOLDER_MESSAGE,
  LINK_ALERT_OPEN_REPORTS,
  REPORTS_PER_REPORTER_DAY,
} from "../../../src/worker/routes/reports";
import {
  api,
  asCaller,
  auditRows,
  envelope,
  errorOf,
  makeFile,
  makeFolder,
  makeShare,
  member,
  nodeById,
  rand,
  settingsWith,
  testDb,
  testKeys,
} from "../sharing/helpers";
import { linkTo, unlock, visit } from "../sharing/public-helpers";
import {
  alertsAbout,
  backdateReport,
  deepLink,
  freshIp,
  linkRow,
  operators,
  publicReport,
  reportsBy,
  reportsOn,
  sessionReport,
} from "./helpers";

const UNKNOWN_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
// Made up.
const PASSWORD = "made-up link password 1";
const OTHER_PASSWORD = "made-up link password 2";

async function setNodeRow(id: string, values: Partial<typeof nodes.$inferInsert>) {
  await testDb().update(nodes).set(values).where(eq(nodes.id, id));
}
async function setLinkRow(id: string, values: Partial<typeof shareLinks.$inferInsert>) {
  await testDb().update(shareLinks).set(values).where(eq(shareLinks.id, id));
}

describe("the public route: proof of access, in order", () => {
  it("a valid token whose subtree holds the file (two levels down) → 202 { received: true }", async () => {
    const { file, link } = await deepLink();
    const answer = await publicReport({ nodeId: file.id, linkToken: link.token });
    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ received: true });
  });

  it("no token, an unknown token, a revoked or an expired link, a node outside the subtree, a bare nodeId: one 404, identical", async () => {
    const { owner, file, link } = await deepLink();
    const outside = await makeFile(owner.id, null, { scanStatus: "clean" });
    const unknown = await publicReport({ nodeId: file.id, linkToken: UNKNOWN_TOKEN });
    expect(unknown.status).toBe(404);
    const bare = await publicReport({ nodeId: file.id });
    const notUnder = await publicReport({ nodeId: outside.id, linkToken: link.token });
    const noSuchNode = await publicReport({ nodeId: crypto.randomUUID(), linkToken: link.token });

    const revoked = await deepLink();
    await setLinkRow(revoked.link.id, { revokedAt: new Date() });
    const revokedAnswer = await publicReport({ nodeId: revoked.file.id, linkToken: revoked.link.token });
    const expired = await deepLink();
    await setLinkRow(expired.link.id, { expiresAt: new Date(Date.now() - 60_000) });
    const expiredAnswer = await publicReport({ nodeId: expired.file.id, linkToken: expired.link.token });

    for (const answer of [bare, notUnder, noSuchNode, revokedAnswer, expiredAnswer]) {
      expect(envelope(answer)).toEqual(envelope(unknown));
    }
    // Nothing was filed and nothing hidden by any of them.
    for (const id of [file.id, outside.id, revoked.file.id, expired.file.id]) {
      expect(await reportsOn(id)).toEqual([]);
      expect((await nodeById(id))!.scanStatus).toBe("clean");
    }
  });

  it("a password link: no link session, another link's, one from another address, one of an old password → 404 identical to an unknown token; this link's session from this address → 202", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "clean" });
    const locked = await linkTo(owner, folder.id, { password: PASSWORD });
    const ip = freshIp();
    const as = (session: string | undefined, from = ip) =>
      publicReport(
        { nodeId: file.id, linkToken: locked.token },
        { ip: from, headers: session ? { [HEADER_LINK_SESSION]: session } : {} },
      );
    const unknown = envelope(await publicReport({ nodeId: file.id, linkToken: UNKNOWN_TOKEN }));

    const other = await linkTo(owner, folder.id, { password: PASSWORD });
    const { session: otherSession } = await unlock(other.token, PASSWORD, { ip });
    const { session: oldSession } = await unlock(locked.token, PASSWORD, { ip });
    expect(otherSession).toBeTruthy();
    expect(oldSession).toBeTruthy();
    const refused = [await as(undefined), await as(otherSession), await as(oldSession, freshIp())];
    await api(asCaller(owner), `/links/${locked.id}`, {
      method: "PATCH",
      json: { password: OTHER_PASSWORD },
    });
    refused.push(await as(oldSession));
    for (const answer of refused) expect(envelope(answer)).toEqual(unknown);
    expect(await reportsOn(file.id)).toEqual([]);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");

    const { session } = await unlock(locked.token, OTHER_PASSWORD, { ip });
    expect((await as(session)).status).toBe(202);
    expect(await reportsOn(file.id)).toHaveLength(1);
  });

  it("every other row of the availability table — an admin lock, any pause (a report's, the owner's, anomaly), links off, the owner suspended or banned, the download cap — → 404 identical to an unknown token, nothing filed", async () => {
    const unknown = envelope(await publicReport({ nodeId: crypto.randomUUID(), linkToken: UNKNOWN_TOKEN }));
    const cases: [string, (subject: Awaited<ReturnType<typeof deepLink>>) => Promise<unknown>, object?][] = [
      ["lockedByAdmin", (s) => setLinkRow(s.link.id, { lockedByAdmin: true })],
      ["report", (s) => setLinkRow(s.link.id, { pauseReasons: ["report"], pausedAt: new Date() })],
      ["owner", (s) => setLinkRow(s.link.id, { pauseReasons: ["owner"], pausedAt: new Date() })],
      ["anomaly", (s) => setLinkRow(s.link.id, { pauseReasons: ["anomaly"], pausedAt: new Date() })],
      ["linksEnabled off", async () => {}, { settings: settingsWith({ linksEnabled: false }) }],
      [
        "suspended",
        (s) => testDb().update(user).set({ suspendedAt: new Date() }).where(eq(user.id, s.owner.id)),
      ],
      ["banned", (s) => testDb().update(user).set({ banned: true }).where(eq(user.id, s.owner.id))],
      ["cap", (s) => setLinkRow(s.link.id, { maxDownloads: 2, downloadCount: 2 })],
    ];
    for (const [name, arrange, options] of cases) {
      const subject = await deepLink();
      await arrange(subject);
      const answer = await publicReport({ nodeId: subject.file.id, linkToken: subject.link.token }, options);
      // Soft: a red names every row that is still let through, not only the first.
      expect.soft(envelope(answer), name).toEqual(unknown);
      expect.soft(await reportsOn(subject.file.id), name).toEqual([]);
      expect.soft((await nodeById(subject.file.id))!.scanStatus, name).toBe("clean");
    }
  });

  it("a refused link says nothing about the node: its file, its folder and an unknown id answer the same 404 in the same number of statements", async () => {
    const { owner, outer, inner, file } = await deepLink();
    const locked = await linkTo(owner, outer.id, { password: PASSWORD });
    const ip = freshIp();
    const answers = [];
    for (const nodeId of [file.id, inner.id, crypto.randomUUID()]) {
      answers.push(await publicReport({ nodeId, linkToken: locked.token }, { ip }));
    }
    const [first, ...rest] = answers;
    expect(envelope(first!)).toMatchObject({ status: 404, error: "not_found" });
    for (const answer of rest) {
      expect(envelope(answer)).toEqual(envelope(first!));
      expect(answer.statements).toBe(first!.statements);
    }
  });

  it("a folder target → 400 validation, 'Choose the file you want to report' (after the token is proven)", async () => {
    const { inner, link } = await deepLink();
    const answer = await publicReport({ nodeId: inner.id, linkToken: link.token });
    expect(answer.status).toBe(400);
    expect(errorOf(answer)).toMatchObject({ error: "validation" });
    expect((answer.body as { message?: string }).message).toBe(FOLDER_MESSAGE);
    expect(await reportsOn(inner.id)).toEqual([]);
  });

  it("a file hidden by inheritance two levels down (its outer folder taken down) or in the trash above → 404; control: the same file before → 202", async () => {
    const control = await deepLink();
    expect((await publicReport({ nodeId: control.file.id, linkToken: control.link.token })).status).toBe(202);

    const taken = await deepLink();
    await setNodeRow(taken.inner.id, { takedownAt: new Date(), takedownReason: "abuse" });
    const trashed = await deepLink();
    await setNodeRow(trashed.inner.id, { deletedAt: new Date() });
    const locked = await deepLink();
    await setNodeRow(locked.file.id, { scanStatus: "suspected_csam" });
    const unknown = await publicReport({ nodeId: taken.file.id, linkToken: UNKNOWN_TOKEN });
    for (const subject of [taken, trashed, locked]) {
      const answer = await publicReport({ nodeId: subject.file.id, linkToken: subject.link.token });
      expect(envelope(answer)).toEqual(envelope(unknown));
      expect(await reportsOn(subject.file.id)).toEqual([]);
    }
  });

  it("Turnstile is checked AFTER the proof: a failing check on an unproven report is the 404, on a proven one the 403", async () => {
    const env = { TURNSTILE_SECRET: TURNSTILE_TEST_SECRET_FAIL };
    const { file, link } = await deepLink();
    const unproven = await publicReport({ nodeId: file.id, linkToken: UNKNOWN_TOKEN }, { env });
    expect(unproven.status).toBe(404);
    const proven = await publicReport({ nodeId: file.id, linkToken: link.token }, { env });
    expect(proven.status).toBe(403);
    expect(errorOf(proven)).toMatchObject({ error: "forbidden", details: { code: "VERIFICATION_FAILED" } });
    expect(await reportsOn(file.id)).toEqual([]);
  });

  it("a session cookie on the public route is ignored: a signed-in sharee with no token is refused 404, and a report WITH the token carries no reporter account", async () => {
    const { owner, file, link } = await deepLink();
    const sharee = await member();
    await makeShare(file.id, owner.id, sharee.id, { role: "viewer" });
    const noToken = await api(asCaller(sharee), "/public/report", {
      ip: freshIp(),
      json: { nodeId: file.id, category: "spam", details: "", turnstileToken: "x" },
    });
    expect(noToken.status).toBe(404);
    expect(await reportsOn(file.id)).toEqual([]);
    const withToken = await api(asCaller(sharee), "/public/report", {
      ip: freshIp(),
      json: { nodeId: file.id, linkToken: link.token, category: "spam", details: "", turnstileToken: "x" },
    });
    expect(withToken.status).toBe(202);
    const [row] = await reportsOn(file.id);
    expect(row).toMatchObject({ reporterUserId: null, reporterEmail: null, linkId: link.id, source: "user" });
  });

  it("the public route spends RL_LINKS by address: a refusing limiter → 429 before anything is read", async () => {
    const { file, link } = await deepLink();
    const refuse = { limit: async () => ({ success: false }) };
    const answer = await publicReport(
      { nodeId: file.id, linkToken: link.token },
      { env: { RL_LINKS: refuse } },
    );
    expect(answer.status).toBe(429);
    expect(answer.headers["retry-after"]).toBeDefined();
    expect(await reportsOn(file.id)).toEqual([]);
  });
});

describe("the session route: proof is a share role", () => {
  async function sharedFile(role: "viewer" | "editor" = "viewer", scanStatus: ScanStatus = "clean") {
    const owner = await member();
    const outer = await makeFolder(owner.id);
    const inner = await makeFolder(owner.id, outer.id);
    const file = await makeFile(owner.id, inner.id, { scanStatus });
    const sharee = await member();
    await makeShare(outer.id, owner.id, sharee.id, { role });
    return { owner, outer, inner, file, sharee };
  }

  it("a viewer and an editor through a share (two levels down) → 202; the row carries the session's account and address, never the body's email", async () => {
    for (const role of ["viewer", "editor"] as const) {
      const { file, sharee } = await sharedFile(role);
      const answer = await sessionReport(sharee, {
        nodeId: file.id,
        linkToken: UNKNOWN_TOKEN, // ignored here
        reporterEmail: "someone-else@example.test",
      });
      expect(answer.status).toBe(202);
      const [row] = await reportsOn(file.id);
      expect(row).toMatchObject({ reporterUserId: sharee.id, reporterEmail: sharee.email, linkId: null });
    }
  });

  it("the owner → 400 validation; no access, an unknown id → 404; signed out → 401", async () => {
    const { owner, file } = await sharedFile();
    const own = await sessionReport(owner, { nodeId: file.id });
    expect(own.status).toBe(400);
    expect(errorOf(own).error).toBe("validation");
    const stranger = await member();
    const none = await sessionReport(stranger, { nodeId: file.id });
    const unknown = await sessionReport(stranger, { nodeId: crypto.randomUUID() });
    expect(none.status).toBe(404);
    expect(envelope(none)).toEqual(envelope(unknown));
    const signedOut = await api(null, "/reports", {
      ip: freshIp(),
      json: { nodeId: file.id, category: "spam", details: "", turnstileToken: "x" },
    });
    expect(signedOut.status).toBe(401);
    expect(await reportsOn(file.id)).toEqual([]);
  });

  it("hidden two levels down — the outer folder taken down, or trashed — → 404 like an unknown id; control: before, 202", async () => {
    const control = await sharedFile();
    expect((await sessionReport(control.sharee, { nodeId: control.file.id })).status).toBe(202);
    const taken = await sharedFile();
    await setNodeRow(taken.inner.id, { takedownAt: new Date(), takedownReason: "abuse" });
    const trashed = await sharedFile();
    await setNodeRow(trashed.inner.id, { deletedAt: new Date() });
    const unknown = await sessionReport(taken.sharee, { nodeId: crypto.randomUUID() });
    for (const subject of [taken, trashed]) {
      const answer = await sessionReport(subject.sharee, { nodeId: subject.file.id });
      expect(envelope(answer)).toEqual(envelope(unknown));
      expect(await reportsOn(subject.file.id)).toEqual([]);
    }
  });

  it("a folder → 400", async () => {
    const { inner, sharee } = await sharedFile();
    const answer = await sessionReport(sharee, { nodeId: inner.id });
    expect(answer.status).toBe(400);
    expect((answer.body as { message?: string }).message).toBe(FOLDER_MESSAGE);
  });
});

describe("the effect of a valid report", () => {
  it("one report hides the file and pauses ITS links inside the request; a folder link that contains it keeps working, minus the file; nothing is revoked", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "clean", name: `r-${rand()}.txt` });
    const sibling = await makeFile(owner.id, folder.id, { scanStatus: "clean", name: `s-${rand()}.txt` });
    const folderLink = await linkTo(owner, folder.id);
    const fileLink = await linkTo(owner, file.id);
    const before = await visit(folderLink.token, "/children");
    expect((before.body as { items: { id: string }[] }).items.map((i) => i.id).sort()).toEqual(
      [file.id, sibling.id].sort(),
    );

    const answer = await publicReport({ nodeId: file.id, linkToken: folderLink.token });
    expect(answer.status).toBe(202);

    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "under_review", scanStatusPrev: "clean" });
    expect(await linkRow(fileLink.id)).toMatchObject({ pauseReasons: ["report"], revokedAt: null });
    expect(await linkRow(folderLink.id)).toMatchObject({ pauseReasons: [], revokedAt: null });
    const after = await visit(folderLink.token, "/children");
    expect(after.status).toBe(200);
    expect((after.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([sibling.id]);
    // The file's own link now answers 423 — "temporarily unavailable".
    expect((await visit(fileLink.token)).status).toBe(423);
  });

  it("the owner sees 'under review' with no category, no reporter and no count; the owner is not mailed", async () => {
    const { owner, file, link } = await deepLink();
    expect(
      (
        await publicReport({
          nodeId: file.id,
          linkToken: link.token,
          category: "phishing",
          details: "SECRET-DETAIL",
        })
      ).status,
    ).toBe(202);
    const seen = await api(asCaller(owner), `/nodes/${file.id}`);
    expect(seen.status).toBe(200);
    const text = JSON.stringify(seen.body);
    expect((seen.body as { node: { scanStatus: string } }).node.scanStatus).toBe("under_review");
    for (const word of ["phishing", "SECRET-DETAIL", "category", "report", "reporter"])
      expect(text).not.toContain(word);
    const { mailTo } = await import("../auth/helpers");
    expect(mailTo(owner.email)).toEqual([]);
  });

  it("after the commit: one routine operator alert (id and category, never a name or the details), one audit row, nothing for a duplicate — and the duplicate is answered identically", async () => {
    const ops = operators();
    const { file, link } = await deepLink();
    const ip = freshIp();
    const first = await publicReport(
      { nodeId: file.id, linkToken: link.token, category: "malware", details: "DETAIL-TEXT" },
      { ip, env: ops.env },
    );
    const second = await publicReport(
      { nodeId: file.id, linkToken: link.token, category: "malware", details: "other words" },
      { ip, env: ops.env },
    );
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body).toEqual(first.body);
    const rows = await reportsOn(file.id);
    expect(rows).toHaveLength(1);
    const reportId = rows[0]!.id;
    const alerts = alertsAbout(ops.address, reportId);
    expect(alerts).toHaveLength(1);
    // …and nothing else reached the operators: the duplicate was not mailed.
    const { mailTo } = await import("../auth/helpers");
    expect(mailTo(ops.address)).toHaveLength(1);
    const mail = JSON.stringify(alerts[0]);
    expect(mail).toContain("malware");
    expect(mail).not.toContain(file.name);
    expect(mail).not.toContain("DETAIL-TEXT");
    expect(await auditRows({ action: "report.created", targetId: reportId })).toHaveLength(1);
  });

  it("dedupe is on the STABLE address hash: the same reporter a day later (their first report backdated past midnight) is still a duplicate; another category is not", async () => {
    const { file, link } = await deepLink();
    const ip = freshIp();
    await publicReport({ nodeId: file.id, linkToken: link.token, category: "spam" }, { ip });
    const [first] = await reportsOn(file.id);
    await backdateReport(first!.id, 25);
    expect(
      (await publicReport({ nodeId: file.id, linkToken: link.token, category: "spam" }, { ip })).status,
    ).toBe(202);
    expect(await reportsBy(file.id, "spam")).toHaveLength(1);
    expect(
      (await publicReport({ nodeId: file.id, linkToken: link.token, category: "other" }, { ip })).status,
    ).toBe(202);
    expect(await reportsOn(file.id)).toHaveLength(2);
  });

  it(`the per-reporter cap: ${REPORTS_PER_REPORTER_DAY} reports in 24 h, the next one 429 rate_limited with Retry-After — another address is unaffected, and a report older than 24 h no longer counts`, async () => {
    const ip = freshIp();
    const files = [];
    for (let i = 0; i < REPORTS_PER_REPORTER_DAY + 1; i++) files.push(await deepLink());
    for (const subject of files.slice(0, REPORTS_PER_REPORTER_DAY)) {
      expect(
        (await publicReport({ nodeId: subject.file.id, linkToken: subject.link.token }, { ip })).status,
      ).toBe(202);
    }
    const last = files.at(-1)!;
    const refused = await publicReport({ nodeId: last.file.id, linkToken: last.link.token }, { ip });
    expect(refused.status).toBe(429);
    expect(errorOf(refused).error).toBe("rate_limited");
    const retryAfter = Number(refused.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(23 * 3600);
    expect(retryAfter).toBeLessThanOrEqual(24 * 3600);
    expect(await reportsOn(last.file.id)).toEqual([]);
    expect((await nodeById(last.file.id))!.scanStatus).toBe("clean");
    // Another reporter is not held by this one's cap.
    expect((await publicReport({ nodeId: last.file.id, linkToken: last.link.token })).status).toBe(202);
    // The oldest report leaves the window: room for one more.
    const [oldest] = await reportsOn(files[0]!.file.id);
    await backdateReport(oldest!.id, 25);
    const again = await deepLink();
    expect((await publicReport({ nodeId: again.file.id, linkToken: again.link.token }, { ip })).status).toBe(
      202,
    );
  });

  it("review m2: the cap holds under a parallel burst — 8 reports at once from one address → exactly 5 filed, 3 refused 429", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const files = [];
    for (let i = 0; i < 8; i++) files.push(await makeFile(owner.id, folder.id, { scanStatus: "clean" }));
    const link = await linkTo(owner, folder.id);
    const ip = freshIp();
    const answers = await Promise.all(
      files.map((file) => publicReport({ nodeId: file.id, linkToken: link.token }, { ip })),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([202, 202, 202, 202, 202, 429, 429, 429]);
    const rows = (await Promise.all(files.map((file) => reportsOn(file.id)))).flat();
    expect(rows).toHaveLength(REPORTS_PER_REPORTER_DAY);
  });

  it("the state table (setUnderReview, called unconditionally): pending/clean/skipped/error → under_review with the previous status saved; a second report leaves scanStatusPrev alone; infected and suspected_csam change nothing and pause nothing", async () => {
    const reporter = await ipHashStable(testKeys(), freshIp());
    async function fileOn(status: ScanStatus) {
      const owner = await member();
      return { file: await makeFile(owner.id, null, { scanStatus: status }) };
    }
    const proven = (file: { id: string; ownerId: string }) => ({
      nodeId: file.id,
      ownerId: file.ownerId,
      linkId: null,
      reporterUserId: null,
      reporterEmail: null,
    });
    for (const status of ["pending", "clean", "skipped", "error"] as const) {
      const { file } = await fileOn(status);
      const filed = await fileReport(testDb(), proven(file), {
        category: "spam",
        details: "",
        reporterIpHashStable: reporter + status,
      });
      expect(filed).toMatchObject({ changed: true });
      expect(await nodeById(file.id)).toMatchObject({ scanStatus: "under_review", scanStatusPrev: status });
      // A second report — another reporter — leaves the saved status alone.
      const again = await fileReport(testDb(), proven(file), {
        category: "other",
        details: "",
        reporterIpHashStable: `${reporter}${status}-2`,
      });
      expect(again).toMatchObject({ changed: false });
      expect(await nodeById(file.id)).toMatchObject({ scanStatus: "under_review", scanStatusPrev: status });
      expect(await reportsOn(file.id)).toHaveLength(2);
    }
    for (const status of ["infected", "suspected_csam"] as const) {
      const owner = await member();
      const file = await makeFile(owner.id, null, { scanStatus: status });
      const { makeLink } = await import("../auth/helpers");
      const link = await makeLink(file.id, owner.id);
      const filed = await fileReport(testDb(), proven(file), {
        category: "malware",
        details: "",
        reporterIpHashStable: reporter + status,
      });
      expect(filed).toMatchObject({ changed: false });
      expect(await nodeById(file.id)).toMatchObject({ scanStatus: status, scanStatusPrev: null });
      expect(await linkRow(link.id)).toMatchObject({ pauseReasons: [] });
      // The report row alone reaches the admin.
      expect(await reportsOn(file.id)).toHaveLength(1);
    }
  });

  it("through the route: an editor who uploaded an infected file reports it → 202, the status stays infected, no link paused", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const editor = await member();
    await makeShare(folder.id, owner.id, editor.id, { role: "editor" });
    const file = await makeFile(owner.id, folder.id, { scanStatus: "infected", createdBy: editor.id });
    const { makeLink } = await import("../auth/helpers");
    const link = await makeLink(file.id, owner.id);
    expect((await sessionReport(editor, { nodeId: file.id, category: "malware" })).status).toBe(202);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "infected", scanStatusPrev: null });
    expect(await linkRow(link.id)).toMatchObject({ pauseReasons: [] });
    expect(await reportsOn(file.id)).toHaveLength(1);
  });

  it("ten reports from ten reporters on ten days never produce suspected_csam — no lock, no blocklist entry, no strike, no revocation", async () => {
    const { owner, file, link } = await deepLink();
    for (let day = 0; day < 10; day++) {
      const answer = await publicReport({ nodeId: file.id, linkToken: link.token, category: "csam" });
      expect(answer.status).toBe(202);
      const rows = await reportsOn(file.id);
      // Each one filed a "day" earlier than the next.
      await backdateReport(rows.at(-1)!.id, 24 * (10 - day));
    }
    expect(await reportsOn(file.id)).toHaveLength(10);
    const node = await nodeById(file.id);
    expect(node).toMatchObject({ scanStatus: "under_review", scanStatusPrev: "clean", legalHold: false });
    expect(
      await testDb().select().from(hashBlocklist).where(eq(hashBlocklist.sourceNodeId, file.id)),
    ).toEqual([]);
    expect(await testDb().select().from(strikes).where(eq(strikes.userId, owner.id))).toEqual([]);
    expect(await linkRow(link.id)).toMatchObject({ revokedAt: null });
  });

  it("dismissal (T05 dismissReview, called directly) restores the previous status and removes exactly the `report` pause — another reason stays", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { scanStatus: "skipped" });
    const { makeLink } = await import("../auth/helpers");
    const onlyReport = await makeLink(file.id, owner.id);
    const alsoOwner = await makeLink(file.id, owner.id, ["owner"]);
    // Reported through a link on the folder: a skipped file cannot have a link of its own made.
    const viaLink = await linkTo(owner, folder.id);
    expect((await publicReport({ nodeId: file.id, linkToken: viaLink.token })).status).toBe(202);
    expect(await linkRow(onlyReport.id)).toMatchObject({ pauseReasons: ["report"] });
    expect((await linkRow(alsoOwner.id)).pauseReasons.sort()).toEqual(["owner", "report"]);

    expect(await dismissReview(testDb(), file.id)).toEqual({ restored: "skipped" });
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "skipped", scanStatusPrev: null });
    expect(await linkRow(onlyReport.id)).toMatchObject({ pauseReasons: [], pausedAt: null });
    expect(await linkRow(alsoOwner.id)).toMatchObject({ pauseReasons: ["owner"] });
  });

  it(`alert volume (standing check c): 10 reporters × ${REPORTS_PER_REPORTER_DAY + 1} reports through one folder link → ${10 * REPORTS_PER_REPORTER_DAY} rows, 10 refused 429, and at most ${LINK_ALERT_OPEN_REPORTS} operator mails (the per-link cap) — every row still filed`, async () => {
    const ops = operators();
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const files = [];
    for (let i = 0; i < 10 * (REPORTS_PER_REPORTER_DAY + 1); i++) {
      files.push(await makeFile(owner.id, folder.id, { scanStatus: "clean", name: `f${i}-${rand()}.txt` }));
    }
    const link = await linkTo(owner, folder.id);
    const statuses: number[] = [];
    let next = 0;
    for (let reporter = 0; reporter < 10; reporter++) {
      const ip = freshIp();
      for (let n = 0; n < REPORTS_PER_REPORTER_DAY + 1; n++) {
        const file = files[next++]!;
        statuses.push(
          (await publicReport({ nodeId: file.id, linkToken: link.token }, { ip, env: ops.env })).status,
        );
      }
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(10 * REPORTS_PER_REPORTER_DAY);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    const rows = (await Promise.all(files.map((f) => reportsOn(f.id)))).flat();
    expect(rows).toHaveLength(10 * REPORTS_PER_REPORTER_DAY);
    const { mailTo } = await import("../auth/helpers");
    const mails = mailTo(ops.address);
    expect(mails).toHaveLength(LINK_ALERT_OPEN_REPORTS);
    // The first ones were mailed, each by its id; the rest are rows the console lists.
    const mailed = rows.filter((row) => alertsAbout(ops.address, row.id).length === 1);
    expect(mailed).toHaveLength(LINK_ALERT_OPEN_REPORTS);
  });
});
