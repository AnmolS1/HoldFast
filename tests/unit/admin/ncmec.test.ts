// The NCMEC procedure (T25 section 6): start (the object held in place), the evidence step — every
// subject of the lock with that person's addresses for THIS node, decrypted only here, never in a
// log, an audit row or an error report — and the filing, which confirms the hash for good.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NcmecEvidenceResponse } from "../../../src/shared/schemas/admin";
import { uploadIps } from "../../../src/worker/db/schema";
import { captureError } from "../../../src/worker/sentry";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import {
  admin,
  adminCall,
  auditOf,
  baId,
  blocklistRow,
  lockedFile,
  madeUpSha,
  makeFile,
  member,
  oldVersion,
  operators,
  reportRowOf,
  reported,
  serviceDeps,
  testDb,
  uploadAddress,
} from "./helpers";

vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn(real.captureError) };
});

const IPS = { e1: "192.0.2.11", e1Elsewhere: "192.0.2.99", e2: "198.51.100.12", orphan: "198.51.100.77" };

/** O owns; E1 uploaded version 1 (kept); E2 replaced it (version 2, current). Locked. */
async function threeSubjects() {
  const [o, e1, e2] = [await member(), await member(), await member()];
  const file = await makeFile(o.id, null, { scanStatus: "clean", sha256: madeUpSha(), createdBy: e2.id });
  const v1 = await oldVersion(file.id, o.id, e1.id);
  await uploadAddress(file.id, v1, e1.id, IPS.e1);
  await uploadAddress(file.id, file.versionId!, e2.id, IPS.e2);
  // E1's address on ANOTHER node: not this node's evidence.
  const other = await makeFile(o.id, null, { scanStatus: "clean" });
  await uploadAddress(other.id, other.versionId!, e1.id, IPS.e1Elsewhere);
  // An uploader whose account is gone: its address is still evidence.
  const gone = baId();
  await uploadAddress(file.id, v1, gone, IPS.orphan);
  // A row that cannot be opened.
  const [broken] = await testDb()
    .insert(uploadIps)
    .values({
      nodeId: file.id,
      versionId: file.versionId!,
      uploaderId: e2.id,
      ipEncrypted: crypto.getRandomValues(new Uint8Array(24)),
      iv: crypto.getRandomValues(new Uint8Array(12)),
      keyVersion: 1,
    })
    .returning({ id: uploadIps.id });
  const ops = operators();
  const service = serviceDeps(ops.env);
  const { reportId } = await lockSuspectedCsam(service.deps, file.id, { source: "admin" });
  await service.settle();
  return { o, e1, e2, file, v1, gone, brokenId: broken!.id, reportId };
}

const evidence = (who: Awaited<ReturnType<typeof admin>>, reportId: string, sessionCreatedAt?: Date) =>
  adminCall(
    { ...who.as, ...(sessionCreatedAt ? { sessionCreatedAt } : {}) },
    "POST",
    `/reports/${reportId}/ncmec/evidence`,
  );

describe("ncmec/start", () => {
  it("→ reviewing with ncmecStartedAt; idempotent; the object stays where it is and nothing is copied", async () => {
    const who = await admin();
    const t = await lockedFile();
    await env.FILES.put(t.file.r2Key!, "the held bytes");
    const listing = async () =>
      (await env.FILES.list({ prefix: `u/${t.owner.id}/` })).objects.map((o) => o.key).sort();
    const before = await listing();
    const first = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/start`);
    expect([first.status, first.body.status]).toEqual([200, "reviewing"]);
    const startedAt = (await reportRowOf(t.reportId))!.ncmecStartedAt;
    expect(startedAt).not.toBeNull();
    const second = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/start`);
    expect([second.status, second.body.status]).toEqual([200, "reviewing"]);
    expect((await reportRowOf(t.reportId))!.ncmecStartedAt).toEqual(startedAt);
    expect(await env.FILES.head(t.file.r2Key!)).not.toBeNull();
    expect(await listing()).toEqual(before);
  });

  // (Addendum 3, B1: start on a csam report whose node is not locked LOCKS it first — fix-pass.test.ts.)
  it("refused on a report that is not csam", async () => {
    const who = await admin();
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const spam = await reported(file.id, owner.id, "spam");
    const notCsam = await adminCall(who.as, "POST", `/reports/${spam}/ncmec/start`);
    expect([notCsam.status, notCsam.body.details?.reason]).toEqual([409, "not_csam"]);
    expect((await reportRowOf(spam))!.status).toBe("open");
  });
});

describe("ncmec/evidence", () => {
  let logged: unknown[][] = [];
  beforeEach(() => {
    logged = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
    }
    vi.mocked(captureError).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("every subject of the lock, each with only their own addresses for THIS node; the current uploader marked; orphans and undecryptable rows kept", async () => {
    const who = await admin();
    const t = await threeSubjects();
    const answer = await evidence(who, t.reportId);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const body = NcmecEvidenceResponse.parse(answer.body);
    expect(body.subjects.map((s) => s.userId).sort()).toEqual([t.o.id, t.e1.id, t.e2.id].sort());
    const by = Object.fromEntries(body.subjects.map((s) => [s.userId, s]));
    expect(body.subjects.filter((s) => s.isCurrentVersionUploader).map((s) => s.userId)).toEqual([t.e2.id]);
    expect(body.currentVersionUploader).toBe("present");
    expect(by[t.o.id]!).toMatchObject({ isOwner: true, addresses: [], held: true });
    expect(by[t.e1.id]!.addresses.map((a) => a.ip)).toEqual([IPS.e1]);
    expect(by[t.e1.id]!.uploadedVersionIds).toContain(t.v1);
    expect(by[t.e2.id]!.addresses.map((a) => a.ip).sort()).toEqual([IPS.e2, null].sort());
    expect(by[t.e2.id]!.addresses.find((a) => a.ip === null)).toMatchObject({
      uploadIpRowId: t.brokenId,
      error: "undecryptable",
    });
    expect(by[t.e1.id]!.account.email).toBe(t.e1.row.email);
    expect(answer.text).not.toContain(IPS.e1Elsewhere);
    expect(body.orphanAddresses).toEqual([expect.objectContaining({ uploaderId: t.gone, ip: IPS.orphan })]);
    expect(body.node.versions).toHaveLength(2);
  });

  it("audits counts and row ids only — no address, e-mail or name in the row, a log line or an error report", async () => {
    const who = await admin();
    const t = await threeSubjects();
    expect((await evidence(who, t.reportId)).status).toBe(200);
    const [row] = await auditOf("admin.ncmec_evidence_opened", t.reportId);
    expect(row!.meta).toMatchObject({ subjects: 3, addresses: 3 });
    expect((row!.meta!.uploadIpRowIds as string[]).length).toBe(4);
    const seeded = [
      ...Object.values(IPS),
      t.o.row.email,
      t.e1.row.email,
      t.e2.row.email,
      t.o.row.name,
      t.e1.row.name,
      t.e2.row.name,
    ];
    const rowText = JSON.stringify(row);
    const logText = JSON.stringify(logged.map((args) => args.map(String)));
    const reported = JSON.stringify(vi.mocked(captureError).mock.calls.map((call) => call.map(String)));
    for (const value of seeded) {
      expect(rowText, value).not.toContain(value);
      expect(logText, value).not.toContain(value);
      expect(reported, value).not.toContain(value);
    }
  });

  it("an owner who is also the uploader appears once", async () => {
    const who = await admin();
    const t = await lockedFile();
    const body = NcmecEvidenceResponse.parse((await evidence(who, t.reportId)).body);
    expect(body.subjects).toHaveLength(1);
    expect(body.subjects[0]).toMatchObject({
      userId: t.owner.id,
      isOwner: true,
      isCurrentVersionUploader: true,
    });
    expect(body.subjects[0]!.addresses.map((a) => a.ip)).toEqual(["192.0.2.10"]);
  });

  it("a session older than 15 minutes → 403 reauth_required, no audit row; a GET is no route", async () => {
    const who = await admin();
    const t = await lockedFile();
    const stale = await evidence(who, t.reportId, new Date(Date.now() - 16 * 60_000));
    expect([stale.status, stale.body.details?.reason]).toEqual([403, "reauth_required"]);
    expect(stale.text).not.toContain("192.0.2.10");
    expect(await auditOf("admin.ncmec_evidence_opened", t.reportId)).toHaveLength(0);
    // Control: a fresh session opens it.
    expect((await evidence(who, t.reportId, new Date(Date.now() - 60_000))).status).toBe(200);
    const get = await adminCall(who.as, "GET", `/reports/${t.reportId}/ncmec/evidence`);
    expect([404, 405]).toContain(get.status);
  });
});

describe("ncmec/filed", () => {
  it("records the id and the time, actioned, the release date; the hash a CONFIRMED listing; a second call changes nothing", async () => {
    const who = await admin();
    const t = await lockedFile();
    const filedAt = new Date(Date.now() - 3_600_000).toISOString();
    expect((await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/start`)).status).toBe(200);
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/filed`, {
      body: { reportId: "NCMEC-123", filedAt },
    });
    expect(answer.status).toBe(200);
    const row = await reportRowOf(t.reportId);
    expect([row!.status, row!.ncmecReportId, row!.ncmecFiledAt!.toISOString()]).toEqual([
      "actioned",
      "NCMEC-123",
      filedAt,
    ]);
    const release = new Date(filedAt);
    release.setUTCFullYear(release.getUTCFullYear() + 1);
    expect(row!.resolution).toBe(`release_not_before:${release.toISOString()}`);
    expect(answer.body.releasableAt).toBe(release.toISOString());
    expect(await blocklistRow(t.sha256)).toMatchObject({
      reason: "csam",
      sourceNodeId: null,
      raisedFrom: null,
      raisedByNodeId: null,
    });
    const again = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/filed`, {
      body: { reportId: "NCMEC-999", filedAt: new Date().toISOString() },
    });
    expect(again.status).toBe(200);
    const after = await reportRowOf(t.reportId);
    expect([after!.ncmecReportId, after!.ncmecFiledAt!.toISOString()]).toEqual(["NCMEC-123", filedAt]);
  });

  it("a filing date in the future → 400, nothing written", async () => {
    const who = await admin();
    const t = await lockedFile();
    const answer = await adminCall(who.as, "POST", `/reports/${t.reportId}/ncmec/filed`, {
      body: { reportId: "NCMEC-1", filedAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(answer.status).toBe(400);
    expect((await reportRowOf(t.reportId))!.status).toBe("open");
  });
});
