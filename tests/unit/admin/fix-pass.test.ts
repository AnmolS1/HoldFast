// The review's findings (holdfast-plan/review/T25-review.md) as regression tests — the fix pass of
// brief Addendum 3. Each block names the finding; each proof was red before its fix.
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { auditLog, nodes, reports, uploads } from "../../../src/worker/db/schema";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { adminHooks } from "../../../src/worker/services/admin-actions";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { keyFor } from "../../../src/worker/services/storage";
import { backendPid, gate, untilBlockedBy } from "../services-core/helpers";
import { generationInStep, objectExists } from "../trash/helpers";
import {
  addressRows,
  admin,
  adminCall,
  auditOf,
  blocklistRow,
  linkRowOf,
  lockedFile,
  madeUpSha,
  makeFile,
  makeLink,
  member,
  nodeRowOf,
  operators,
  rand,
  reportRowOf,
  reported,
  serviceDeps,
  testDb,
  uploadAddress,
  userRowOf,
} from "./helpers";

type Admin = Awaited<ReturnType<typeof admin>>;

beforeAll(async () => {
  await generationInStep();
});
afterEach(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});

// ── B1: no NCMEC filing without a lock ──────────────────────────────────────────────────────

/** A user's csam-category report from the intake: the node is merely `under_review`, nothing held. */
async function userCsamReport() {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
  await uploadAddress(file.id, file.versionId!, owner.id, "192.0.2.77");
  const reportId = await reported(file.id, owner.id, "csam");
  return { owner, file, reportId };
}

describe("B1 — the NCMEC procedure runs on a LOCKED node only", () => {
  it("the reviewer's proof: filed straight on an under_review node is refused, nothing written", async () => {
    const who = await admin();
    const t = await userCsamReport();
    const filed = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/filed`, {
      body: { reportId: "123", filedAt: new Date().toISOString() },
    });
    expect([filed.status, filed.body?.details?.reason]).toEqual([409, "not_locked"]);
    expect((await reportRowOf(t.reportId))!.status).toBe("open");
    expect(await blocklistRow(t.file.sha256!)).toBeNull();
  });

  it("start on a report whose node is not locked LOCKS it first (holds, addresses, links), then starts; filed then works and everything stays held", async () => {
    const who = await admin();
    const t = await userCsamReport();
    const link = await makeLink(t.file.id, t.owner.id);
    const started = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/start`, {
      env: operators().env,
    });
    expect(started.status, started.text).toBe(200);
    expect(started.body.status).toBe("reviewing");
    const node = (await nodeRowOf(t.file.id))!;
    expect([node.scanStatus, node.legalHold]).toEqual(["suspected_csam", true]);
    expect((await userRowOf(t.owner.id))!.legalHold).toBe(true);
    expect((await addressRows(t.file.id)).every((row) => row.legalHold)).toBe(true);
    expect((await linkRowOf(link.id)).pauseReasons).toContain("moderation");
    // The lock found THIS report: one csam case on the node.
    const cases = await testDb().select().from(reports).where(eq(reports.nodeId, t.file.id));
    expect(cases.filter((r) => r.category === "csam")).toHaveLength(1);
    const filed = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/filed`, {
      body: { reportId: "123", filedAt: new Date().toISOString() },
    });
    expect(filed.status, filed.text).toBe(200);
    expect((await reportRowOf(t.reportId))!.status).toBe("actioned");
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(true);
    expect((await userRowOf(t.owner.id))!.legalHold).toBe(true);
  });

  it("filed on a locked case that was never started is refused (start first)", async () => {
    const who = await admin();
    const { reportId } = await lockedFile();
    const filed = await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/filed`, {
      body: { reportId: "123", filedAt: new Date().toISOString() },
    });
    expect([filed.status, filed.body?.details?.reason]).toEqual([409, "not_started"]);
    // Control: started → filed.
    expect((await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/start`)).status).toBe(200);
    const again = await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/filed`, {
      body: { reportId: "123", filedAt: new Date().toISOString() },
    });
    expect(again.status).toBe(200);
  });

  it("start on a report whose node is a folder is refused (409 folder), nothing locked", async () => {
    const who = await admin();
    const owner = await member();
    const folder = await testDb()
      .insert(nodes)
      .values({
        ownerId: owner.id,
        createdBy: owner.id,
        kind: "folder",
        name: `f-${rand()}`,
        nameKey: `f-${rand()}`,
        scanStatus: "clean",
      })
      .returning();
    const reportId = await reported(folder[0]!.id, owner.id, "csam");
    const started = await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/start`);
    expect([started.status, started.body?.details?.reason]).toEqual([409, "folder"]);
    expect((await nodeRowOf(folder[0]!.id))!.legalHold).toBe(false);
  });
});

// ── m2: evidence only for a locked node ─────────────────────────────────────────────────────

describe("m2 — the evidence step needs a locked node", () => {
  it("a csam report on an under_review node: 409 not_locked, no address opened, no audit row; control: locked → 200", async () => {
    const who = await admin();
    const t = await userCsamReport();
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/evidence`);
    expect([answer.status, answer.body?.details?.reason]).toEqual([409, "not_locked"]);
    expect(answer.text).not.toContain("192.0.2.77");
    expect(await auditOf("admin.ncmec_evidence_opened", t.reportId)).toHaveLength(0);
    const { reportId } = await lockedFile();
    expect((await adminCall(who.as, "POST", `/reports/${reportId}/ncmec/evidence`)).status).toBe(200);
  });
});

// ── m3: Release holds while the report's own node is still locked ────────────────────────────

describe("m3 — Release holds refuses while the report's own node is locked", () => {
  it("a dismissed report on a node that is still suspected_csam: 409 node_locked, every hold stays", async () => {
    const who = await admin();
    const t = await lockedFile();
    // An older csam report on the same node, dismissed; the node stays locked (its case is another report).
    await testDb().update(reports).set({ status: "dismissed" }).where(eq(reports.id, t.reportId));
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/release-holds`, {
      body: { reason: "Dismissed.", confirm: true },
    });
    expect([answer.status, answer.body?.details?.reason]).toEqual([409, "node_locked"]);
    // The preview (no confirm) is refused the same way — the outer check, before any plan is shown.
    const preview = await adminCall(who.as, "POST", `/reports/${t.reportId}/release-holds`, {
      body: { reason: "Dismissed." },
    });
    expect([preview.status, preview.body?.details?.reason]).toEqual([409, "node_locked"]);
    expect((await nodeRowOf(t.file.id))!.legalHold).toBe(true);
    expect((await userRowOf(t.owner.id))!.legalHold).toBe(true);
  });
});

// ── B2: never delete a server-proven upload whose hash is listed ─────────────────────────────

const keptMade: string[] = [];
afterAll(async () => {
  if (keptMade.length > 0) {
    await testDb()
      .update(uploads)
      .set({ status: "aborted", completedAt: new Date() })
      .where(and(inArray(uploads.id, keptMade), eq(uploads.status, "completing")));
  }
});

async function keptSession() {
  const owner = await member();
  const sha256 = madeUpSha();
  const nodeId = uuidv7();
  const versionId = uuidv7();
  const r2Key = keyFor(owner.id, nodeId, versionId);
  const name = `kept-${rand()}.bin`;
  const [session] = await testDb()
    .insert(uploads)
    .values({
      ownerId: owner.id,
      uploaderId: owner.id,
      parentId: null,
      nodeId,
      versionId,
      name,
      nameKey: name,
      size: 10,
      r2Key,
      expiresAt: new Date(Date.now() + 3_600_000),
      status: "completing",
      completingAt: new Date(Date.now() - 3 * 3_600_000),
      expectedSha256: sha256,
    })
    .returning();
  keptMade.push(session!.id);
  await env.FILES.put(r2Key, "verified bytes");
  await testDb().insert(auditLog).values({
    actorType: "system",
    action: "upload.csam_node_owed",
    targetType: "upload",
    targetId: session!.id,
  });
  return { owner, session: session!, sha256, r2Key };
}

const resolve = (who: Admin, id: string, body: Record<string, unknown>) =>
  adminCall(who.as, "POST", `/kept-uploads/${id}/resolve`, { body: { reason: "Decided.", ...body } });

describe("B2 — 'false positive' never ends a kept upload whose hash is listed", () => {
  it("the reviewer's proof: relist, then false_positive → 409 listed, the session and its object kept", async () => {
    const who = await admin();
    const k = await keptSession();
    expect((await resolve(who, k.session.id, { resolution: "relist", confirm: true })).status).toBe(200);
    for (const confirm of [undefined, true]) {
      const answer = await resolve(who, k.session.id, { resolution: "false_positive", confirm });
      expect([answer.status, answer.body?.details?.reason]).toEqual([409, "listed"]);
    }
    expect(await objectExists(k.r2Key)).toBe(true);
    const [row] = await testDb().select().from(uploads).where(eq(uploads.id, k.session.id));
    expect(row!.status).toBe("completing");
  });

  it("listed for ANY reason (malware here) → 409 listed; control: unlisted → ended, object deleted", async () => {
    const who = await admin();
    const k = await keptSession();
    await blocklist.upsert(testDb(), { sha256: k.sha256, reason: "malware" });
    const refused = await resolve(who, k.session.id, { resolution: "false_positive", confirm: true });
    expect([refused.status, refused.body?.details?.reason]).toEqual([409, "listed"]);
    const free = await keptSession();
    const ended = await resolve(who, free.session.id, { resolution: "false_positive", confirm: true });
    expect(ended.status, ended.text).toBe(200);
    expect(await objectExists(free.r2Key)).toBe(false);
  });

  it("listed between the read and the confirm's lock: decided again inside the transaction", async () => {
    const who = await admin();
    const k = await keptSession();
    adminHooks.afterKeptRead = async () => {
      await blocklist.upsert(testDb(), { sha256: k.sha256, reason: "csam" });
    };
    try {
      const answer = await resolve(who, k.session.id, { resolution: "false_positive", confirm: true });
      expect([answer.status, answer.body?.details?.reason]).toEqual([409, "listed"]);
    } finally {
      adminHooks.afterKeptRead = null;
    }
    expect(await objectExists(k.r2Key)).toBe(true);
  });
});

// ── M1: a notice undoes only what IT did ────────────────────────────────────────────────────

const intake = (nodeIds: string[]) => ({
  receivedVia: "email",
  complainantName: "A. Rights-Holder",
  complainantEmail: "legal@example.test",
  workDescription: "A photograph.",
  infringingDescription: "The named file.",
  statementGoodFaith: true,
  statementAccuracy: true,
  signature: "A. Rights-Holder",
  nodeIds,
});
async function noticeOn(who: Admin, nodeId: string): Promise<string> {
  const made = await adminCall(who.as, "POST", "/dmca", { body: intake([nodeId]) });
  expect(made.status, made.text).toBe(200);
  return made.body.notices[0].id;
}
const act = (who: Admin, id: string, action: string) =>
  adminCall(who.as, "POST", `/dmca/${id}/action`, { body: { action } });

describe("M1 — a DMCA notice undoes only what it did", () => {
  it("P2a: an abuse takedown, then a notice that took no action is withdrawn → the node stays down, its link stays paused", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, owner.id);
    const reportId = await reported(file.id, owner.id, "spam");
    expect(
      (
        await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
          body: { action: "takedown", resolution: "Abuse." },
        })
      ).status,
    ).toBe(200);
    const notice = await noticeOn(who, file.id);
    const withdrawn = await act(who, notice, "withdraw");
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");
    const node = (await nodeRowOf(file.id))!;
    expect([node.takedownAt !== null, node.takedownReason]).toEqual([true, "abuse"]);
    expect((await linkRowOf(link.id)).pauseReasons).toContain("moderation");
  });

  it("an actioned notice on a node already taken down for abuse does not overwrite the reason, and its restore leaves it down", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const reportId = await reported(file.id, owner.id, "spam");
    await adminCall(who.as, "POST", `/reports/${reportId}/action`, {
      body: { action: "takedown", resolution: "Abuse." },
    });
    const notice = await noticeOn(who, file.id);
    expect((await act(who, notice, "takedown")).status).toBe(200);
    expect((await nodeRowOf(file.id))!.takedownReason).toBe("abuse");
    expect((await act(who, notice, "withdraw")).status).toBe(200);
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
  });

  it("P2b: two notices took the same file down; withdrawing A leaves it down for B, and the dmca entry stays; control: then B withdrawn → restored", async () => {
    const who = await admin();
    const owner = await member();
    const sha = madeUpSha();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: sha });
    const link = await makeLink(file.id, owner.id);
    const a = await noticeOn(who, file.id);
    const b = await noticeOn(who, file.id);
    expect((await act(who, a, "takedown")).status).toBe(200);
    expect((await act(who, b, "takedown")).status).toBe(200);
    expect((await act(who, a, "withdraw")).status).toBe(200);
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
    expect((await linkRowOf(link.id)).pauseReasons).toContain("moderation");
    expect((await blocklistRow(sha))?.reason).toBe("dmca");
    expect((await act(who, b, "withdraw")).status).toBe(200);
    expect((await nodeRowOf(file.id))!.takedownAt).toBeNull();
    expect((await linkRowOf(link.id)).pauseReasons).not.toContain("moderation");
    expect(await blocklistRow(sha)).toBeNull();
  });

  it("a notice that still keeps the content down in a TERMINAL status counts: B upheld (lawsuit) or B closed after its takedown → withdrawing A leaves the node down and the dmca entry; control: B withdrawn → A's withdraw restores", async () => {
    const who = await admin();
    for (const ending of ["lawsuit_notice", "close"] as const) {
      const owner = await member();
      const sha = madeUpSha();
      const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: sha });
      const a = await noticeOn(who, file.id);
      const b = await noticeOn(who, file.id);
      expect((await act(who, a, "takedown")).status).toBe(200);
      expect((await act(who, b, "takedown")).status).toBe(200);
      const ended = await act(who, b, ending);
      expect(ended.status, ended.text).toBe(200);
      expect(ended.body.status).toBe(ending === "close" ? "closed" : "upheld");
      expect((await act(who, a, "withdraw")).status).toBe(200);
      expect((await nodeRowOf(file.id))!.takedownAt, ending).not.toBeNull();
      expect((await blocklistRow(sha))?.reason, ending).toBe("dmca");
    }
    // Control: B ended by a withdraw of its own (its takedown lifted) — A's withdraw restores.
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
    const a = await noticeOn(who, file.id);
    const b = await noticeOn(who, file.id);
    await act(who, a, "takedown");
    await act(who, b, "takedown");
    await act(who, b, "withdraw");
    // A notice that never took anything down (still `received`) holds nothing.
    await noticeOn(who, file.id);
    expect((await nodeRowOf(file.id))!.takedownAt).not.toBeNull();
    await act(who, a, "withdraw");
    expect((await nodeRowOf(file.id))!.takedownAt).toBeNull();
  });

  it("an entry listed before the notice (malware) is neither rewritten to dmca nor removed by its restore", async () => {
    const who = await admin();
    const owner = await member();
    const sha = madeUpSha();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: sha });
    await blocklist.upsert(testDb(), { sha256: sha, reason: "malware" });
    const notice = await noticeOn(who, file.id);
    expect((await act(who, notice, "takedown")).status).toBe(200);
    expect((await blocklistRow(sha))?.reason).toBe("malware");
    expect((await act(who, notice, "withdraw")).status).toBe(200);
    expect((await blocklistRow(sha))?.reason).toBe("malware");
  });
});

// ── M2: the hold clear is one transaction in the CSAM lock order ────────────────────────────

describe("M2 — clearing a hold by hand cannot erase a lock's hold", () => {
  it("a lock racing the clear: the clear holds the user row; the lock waits, then sets the hold — it stands", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
    await adminCall(who.as, "POST", `/users/${owner.id}/legal-hold`, {
      body: { held: true, note: "By hand." },
    });
    const held = gate();
    const go = gate();
    let pid = 0;
    adminHooks.afterHoldUserLock = async (tx) => {
      pid = await backendPid(tx);
      held.open();
      await go.opened;
    };
    try {
      const clearing = adminCall(who.as, "POST", `/users/${owner.id}/legal-hold`, {
        body: { held: false, note: "Released by hand." },
      });
      await held.opened;
      const service = serviceDeps(operators().env);
      let lockDone = false;
      const locking = lockSuspectedCsam(service.deps, file.id, { source: "admin" }).finally(() => {
        lockDone = true;
      });
      // Correct code: the lock waits on the user row. (Without that row lock the lock commits here,
      // and the clear's write that follows would erase its hold — the control.)
      await untilBlockedBy(pid, () => lockDone);
      go.open();
      expect((await clearing).status).toBe(200);
      await locking;
      await service.settle();
    } finally {
      adminHooks.afterHoldUserLock = null;
    }
    expect((await userRowOf(owner.id))!.legalHold).toBe(true);
  });
});

// ── m4: settings / revoke-links audited in the same transaction ──────────────────────────────

describe("m4 — bulk revoke commits only with its audit row", () => {
  it("an audit insert that fails rolls the revokes back (500, the links still live)", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const link = await makeLink(file.id, owner.id);
    const answer = await adminCall(who.as, "POST", `/users/${owner.id}/revoke-links`, {
      body: { reason: "Abuse." },
      core: {
        insertAudit: async () => {
          throw new Error("audit insert failed (made up)");
        },
      },
    });
    expect(answer.status).toBe(500);
    expect((await linkRowOf(link.id)).revokedAt).toBeNull();
  });
});

// ── m7: levelling requires the pause switch ─────────────────────────────────────────────────

describe("m7 — accept the database's generation needs the pause switch ON", () => {
  it("switch off: the confirm is 409 not_paused, nothing written (the preview still answers)", async () => {
    const who = await admin();
    const body = {
      reason: "Restored.",
      confirm: true,
      checklist: { pausedAndOrphansOff: true, reapplied: true, reconciled: true },
    };
    const answer = await adminCall(who.as, "POST", "/system/generation", { body });
    expect([answer.status, answer.body?.details?.reason]).toEqual([409, "not_paused"]);
  });
});

// ── m8 (the hand-set half): the toggle's audit row commits with the toggle ──────────────────

describe("m8 — the hand-set hold's audit row is written in the toggle's transaction", () => {
  it("an audit insert that fails rolls the toggle back (500, the hold as it was); control: it commits with its row", async () => {
    const who = await admin();
    const target = await member();
    const failed = await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, {
      body: { held: true, note: "Preservation request." },
      core: {
        insertAudit: async () => {
          throw new Error("audit insert failed (made up)");
        },
      },
    });
    expect(failed.status).toBe(500);
    expect((await userRowOf(target.id))!.legalHold).toBe(false);
    const ok = await adminCall(who.as, "POST", `/users/${target.id}/legal-hold`, {
      body: { held: true, note: "Preservation request." },
    });
    expect(ok.status).toBe(200);
    expect((await userRowOf(target.id))!.legalHold).toBe(true);
    expect(await auditOf("admin.legal_hold_set", target.id)).toHaveLength(1);
  });
});

// ── M1 residual (SEAM took_down): a notice lifts only the takedowns IT made ─────────────────

describe("M1 residual — a scanner-made dmca takedown is not a notice's to lift", () => {
  it("the scanner took the file down (dmca, takedownBy null); a notice naming it is taken down and withdrawn → the file stays down; control: a file the notice itself took down is lifted", async () => {
    const who = await admin();
    const owner = await member();
    const scanned = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "dmca", takedownBy: null })
      .where(eq(nodes.id, scanned.id));
    const own = await makeFile(owner.id, null, { scanStatus: "clean", sha256: madeUpSha() });
    const made = await adminCall(who.as, "POST", "/dmca", { body: intake([scanned.id, own.id]) });
    expect(made.status, made.text).toBe(200);
    const notice = made.body.notices[0].id as string;
    expect((await act(who, notice, "takedown")).status).toBe(200);
    expect((await act(who, notice, "withdraw")).status).toBe(200);
    expect((await nodeRowOf(scanned.id))!.takedownAt).not.toBeNull();
    expect((await nodeRowOf(own.id))!.takedownAt).toBeNull();
  });
});
