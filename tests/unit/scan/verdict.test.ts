// The verdict (T21 steps 2f–2g) through the real pipeline with the stub scanner: `queue()` is
// handed each message, and the rows, the ledger, the mails and the audit trail are read back.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { STRIKES_TO_SUSPEND } from "../../../src/shared/constants";
import { setUnderReview } from "../../../src/worker/db/queries/moderation";
import { finish } from "../../../src/worker/db/queries/scan-jobs";
import { nodes, shareLinks, strikes, uploads, user } from "../../../src/worker/db/schema";
import { toNodeDto } from "../../../src/worker/services/node-dto";
import { makeLink } from "../auth/helpers";
import { enqueueRescan } from "../../../src/worker/services/scanning";
import { addStrike } from "../../../src/worker/services/strikes";
import {
  accessOf,
  auditRows,
  cleanBytes,
  deliver,
  explicit,
  infectedBytes,
  jobsFor,
  listAs,
  listing,
  mailTo,
  makeFolder,
  makeUser,
  nodeById,
  r2Event,
  rand,
  reportsOf,
  serviceDeps,
  sha256Of,
  strikesOf,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/services/strikes", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/strikes")>();
  return { ...real, addStrike: vi.fn(real.addStrike) };
});
vi.mock("../../../src/worker/db/queries/scan-jobs", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/scan-jobs")>();
  return { ...real, finish: vi.fn(real.finish) };
});

const ack = [{ outcome: "ack" }];
const mails = (to: { email: string }, template: string) => mailTo(to.email, template).length;
type Effects = Record<string, unknown>;
const ledgerOf = async (key: string) =>
  ((await jobsFor(key))[0]?.verdict as { effects?: Effects } | null)?.effects ?? {};

describe("each outcome's effects, once — and the same message again forced adds nothing", () => {
  it("clean: the status, the server hash, the record; no effect", async () => {
    const bytes = cleanBytes();
    const { file, owner } = await uploadedFile(bytes, { name: "notes.txt" });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    const row = (await nodeById(file.id))!;
    expect(row).toMatchObject({
      scanStatus: "clean",
      scanReason: null,
      sha256: await sha256Of(bytes),
      mimeSniffed: "text/plain",
      scanDetail: { engine: "stub" },
    });
    expect(row.scannedAt).toBeInstanceOf(Date);
    expect(await ledgerOf(file.r2Key!)).toEqual({});
    expect(mails(owner, "quarantineNotice")).toBe(0);
  });

  it("infected: blocklist row, ONE strike for the uploader with the server hash, notices to owner and uploader — once, across a forced rescan", async () => {
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = infectedBytes();
    const hash = await sha256Of(bytes);
    const { file } = await uploadedFile(bytes, { owner, uploader });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "infected", sha256: hash });
    expect(await listing(hash)).toMatchObject({ reason: "malware", sourceNodeId: file.id });
    const struck = await strikesOf(uploader.id);
    expect(struck).toHaveLength(1);
    expect(struck[0]).toMatchObject({ kind: "malware", nodeId: file.id, contentSha256: hash });
    expect(await strikesOf(owner.id)).toHaveLength(0);
    expect(mails(owner, "quarantineNotice")).toBe(1);
    expect(mails(uploader, "quarantineNotice")).toBe(1);
    expect(await auditRows({ action: "scan.infected", targetId: file.id })).toHaveLength(1);
    const ledger = await ledgerOf(file.r2Key!);
    expect(ledger).toEqual({ blocklist: true, strike: struck[0]!.id, quarantineNotice: true });

    // An admin rescan: back to pending, the forced message, the same verdict.
    const rescan = serviceDeps();
    const sent: unknown[] = [];
    rescan.deps.env = {
      ...rescan.deps.env,
      SCAN_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    } as unknown as Env;
    expect(await enqueueRescan(rescan.deps, file.id, { by: "admin" })).toEqual({ queued: true });
    await rescan.settle();
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    expect(await deliver([{ body: sent[0] }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "infected", sha256: hash });
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done", attempt: 2 }]);
    expect(await strikesOf(uploader.id)).toHaveLength(1);
    expect(mails(owner, "quarantineNotice")).toBe(1);
    expect(mails(uploader, "quarantineNotice")).toBe(1);
    expect(await auditRows({ action: "scan.infected", targetId: file.id })).toHaveLength(1);
    // The ledger still lists every effect.
    expect(await ledgerOf(file.r2Key!)).toEqual(ledger);
    // And a plain duplicate of the explicit message and the store's event: acked, nothing more.
    expect(await deliver([{ body: explicit(file) }, { body: r2Event(file.r2Key!) }])).toEqual([
      ...ack,
      ...ack,
    ]);
    expect(await strikesOf(uploader.id)).toHaveLength(1);
    expect(mails(uploader, "quarantineNotice")).toBe(1);
  });

  it("hash mismatch: error/hash_mismatch, not retried; notices to owner and uploader once; nodes.sha256 the server's", async () => {
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = cleanBytes();
    const { file } = await uploadedFile(bytes, { owner, uploader, declared: rand(32) });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({
      scanStatus: "error",
      scanReason: "hash_mismatch",
      sha256: await sha256Of(bytes),
    });
    expect(mails(owner, "uploadNotIntact")).toBe(1);
    expect(mails(uploader, "uploadNotIntact")).toBe(1);
    expect(await auditRows({ action: "scan.hash_mismatch", targetId: file.id })).toHaveLength(1);
    // Forced again: the same verdict (the session's declaration has not changed), nothing more.
    await testDb().update(nodes).set({ scanStatus: "pending" }).where(eq(nodes.id, file.id));
    expect(await deliver([{ body: explicit(file, true) }])).toEqual(ack);
    expect((await nodeById(file.id))!.scanReason).toBe("hash_mismatch");
    expect(mails(owner, "uploadNotIntact")).toBe(1);
    expect(await auditRows({ action: "scan.hash_mismatch", targetId: file.id })).toHaveLength(1);
  });

  it("the uploader is the owner: one notice, not two", async () => {
    const { file, owner } = await uploadedFile(infectedBytes());
    await deliver([{ body: explicit(file) }]);
    expect(mails(owner, "quarantineNotice")).toBe(1);
  });
});

describe("the verdict-write table (step 2g), one row each — with the control in the same file", () => {
  type Setup = { label: string; overrides: Record<string, unknown> };
  const rows: Setup[] = [
    { label: "suspected_csam", overrides: { scanStatus: "suspected_csam", legalHold: true } },
    {
      label: "pending, taken down",
      overrides: { scanStatus: "pending", takedownAt: new Date(), takedownReason: "dmca" },
    },
    { label: "clean already", overrides: { scanStatus: "clean", scannedAt: new Date(0) } },
    { label: "infected already", overrides: { scanStatus: "infected", scannedAt: new Date(0) } },
  ];

  for (const { label, overrides } of rows) {
    it(`${label}: a clean and an infected verdict leave the status; no strike, no blocklist row, no mail`, async () => {
      for (const bytes of [cleanBytes(), infectedBytes()]) {
        const owner = await makeUser();
        const { file } = await uploadedFile(bytes, { owner, ...overrides });
        const before = await nodeById(file.id);
        expect(await deliver([{ body: explicit(file) }]), label).toEqual(ack);
        const after = await nodeById(file.id);
        expect(accessOf(after), label).toEqual(accessOf(before));
        // The record is written all the same: the server hash.
        expect(after!.sha256, label).toBe(await sha256Of(bytes));
        expect(await strikesOf(owner.id), label).toHaveLength(0);
        expect(await listing(await sha256Of(bytes)), label).toBeNull();
        expect(mails(owner, "quarantineNotice"), label).toBe(0);
        expect(await jobsFor(file.r2Key!), label).toMatchObject([{ status: "done" }]);
      }
    });

    it(`${label}: a suspected_csam outcome locks it`, async () => {
      const bytes = cleanBytes("csam-listed");
      await listAs(await sha256Of(bytes), "csam");
      const { file } = await uploadedFile(bytes, overrides);
      expect(await deliver([{ body: explicit(file) }]), label).toEqual(ack);
      expect(await nodeById(file.id), label).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
      expect(
        (await reportsOf(file.id)).filter((r) => r.category === "csam"),
        label,
      ).toHaveLength(1);
    });
  }

  it("CONTROL: the identical messages on a pending, not-taken-down node write the verdict and the strike", async () => {
    const owner = await makeUser();
    for (const [bytes, status] of [
      [cleanBytes(), "clean"],
      [infectedBytes(), "infected"],
    ] as const) {
      const { file } = await uploadedFile(bytes, { owner });
      expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
      expect((await nodeById(file.id))!.scanStatus).toBe(status);
    }
    expect(await strikesOf(owner.id)).toHaveLength(1);
    expect(mails(owner, "quarantineNotice")).toBe(1);
  });

  it("a suspected_csam node stays suspected_csam after a clean verdict for its key (the store's event too)", async () => {
    const { file } = await uploadedFile(cleanBytes(), { scanStatus: "suspected_csam", legalHold: true });
    for (const body of [explicit(file), r2Event(file.r2Key!), explicit(file, true)]) {
      expect(await deliver([{ body }])).toEqual(ack);
      expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
    }
  });
});

describe("precedence", () => {
  it("under_review: the verdict lands in scanStatusPrev — no strike or mail; a csam outcome raises it", async () => {
    const owner = await makeUser();
    const { file } = await uploadedFile(infectedBytes(), { owner, scanStatus: "under_review" });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "under_review", scanStatusPrev: "infected" });
    expect(await strikesOf(owner.id)).toHaveLength(0);
    expect(mails(owner, "quarantineNotice")).toBe(0);

    const bytes = cleanBytes();
    await listAs(await sha256Of(bytes), "csam");
    const reviewed = await uploadedFile(bytes, { scanStatus: "pending" });
    await setUnderReview(testDb(), reviewed.file.id);
    expect((await nodeById(reviewed.file.id))!.scanStatus).toBe("under_review");
    expect(await deliver([{ body: explicit(reviewed.file) }])).toEqual(ack);
    expect((await nodeById(reviewed.file.id))!.scanStatus).toBe("suspected_csam");
  });
});

describe("blocklist reasons (on the SERVER hash)", () => {
  it("csam: suspected_csam, the object kept, node and owner held, only the admin told", async () => {
    const owner = await makeUser();
    const bytes = cleanBytes();
    await listAs(await sha256Of(bytes), "csam");
    const { file } = await uploadedFile(bytes, { owner });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();
    const [account] = await testDb().select().from(user).where(eq(user.id, owner.id));
    expect(account!.legalHold).toBe(true);
    const csamReports = (await reportsOf(file.id)).filter((r) => r.category === "csam");
    expect(csamReports).toHaveLength(1);
    expect(await auditRows({ action: "scan.suspected_csam", targetId: file.id })).toHaveLength(1);
    // The owner is told nothing; no strike.
    expect(mailTo(owner.email)).toHaveLength(0);
    expect(await strikesOf(owner.id)).toHaveLength(0);
    expect((await jobsFor(file.r2Key!))[0]).toMatchObject({ status: "done" });
    expect(await ledgerOf(file.r2Key!)).toEqual({ csamLock: csamReports[0]!.id });
    // A redelivery: the same report, no second record.
    expect(await deliver([{ body: explicit(file, true) }])).toEqual(ack);
    expect((await reportsOf(file.id)).filter((r) => r.category === "csam")).toHaveLength(1);
  });

  it("malware: infected with no scanner hit — no second blocklist row, a strike", async () => {
    const owner = await makeUser();
    const bytes = cleanBytes();
    const hash = await sha256Of(bytes);
    await listAs(hash, "malware");
    const { file } = await uploadedFile(bytes, { owner });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({
      scanStatus: "infected",
      scanDetail: { blocklist: "malware" },
    });
    expect(await listing(hash)).toMatchObject({ reason: "malware", sourceNodeId: null });
    expect(await strikesOf(owner.id)).toHaveLength(1);
    expect(await ledgerOf(file.r2Key!)).not.toHaveProperty("blocklist");
  });

  for (const [reason, category] of [
    ["dmca", "copyright"],
    ["admin", "other"],
  ] as const) {
    it(`${reason}: the engine's verdict stands, plus a takedown, a link pause (moderation) and a ${category} report — no strike`, async () => {
      const owner = await makeUser();
      const bytes = cleanBytes();
      await listAs(await sha256Of(bytes), reason);
      const { file } = await uploadedFile(bytes, { owner });
      await makeLink(file.id, owner.id);
      expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
      const row = (await nodeById(file.id))!;
      expect(row).toMatchObject({
        scanStatus: "clean",
        takedownReason: reason,
        scanDetail: { blocklist: reason },
      });
      expect(row.takedownAt).toBeInstanceOf(Date);
      const [link] = await testDb().select().from(shareLinks).where(eq(shareLinks.nodeId, file.id));
      expect(link!.pauseReasons).toContain("moderation");
      expect(await reportsOf(file.id)).toMatchObject([{ source: "system", category, status: "open" }]);
      expect(await strikesOf(owner.id)).toHaveLength(0);
      // Forced again: no second report.
      await testDb()
        .update(nodes)
        .set({ scanStatus: "pending", takedownAt: null })
        .where(eq(nodes.id, file.id));
      await deliver([{ body: explicit(file, true) }]);
      expect(await reportsOf(file.id)).toHaveLength(1);
    });
  }
});

describe("the hash check (f.4) compares with the session's declaration", () => {
  it("the two lies end alike — and nodes.sha256 is the stored bytes' hash after either", async () => {
    // (1) A LISTED hash declared for unlisted bytes: T12 hashed it (a declared hit) and so wrote
    // the SERVER hash to nodes.sha256; the session keeps the declaration.
    const listedLie = rand(32);
    await listAs(listedLie, "malware");
    const honestBytes = cleanBytes();
    const one = await uploadedFile(honestBytes, { declared: listedLie });
    await testDb()
      .update(nodes)
      .set({ sha256: await sha256Of(honestBytes) })
      .where(eq(nodes.id, one.file.id));
    expect(await deliver([{ body: explicit(one.file) }])).toEqual(ack);
    expect(await nodeById(one.file.id)).toMatchObject({
      scanStatus: "error",
      scanReason: "hash_mismatch",
      sha256: await sha256Of(honestBytes),
    });

    // (2) An unlisted (clean) hash declared for listed bytes — csam and malware each.
    for (const [reason, status] of [
      ["csam", "suspected_csam"],
      ["malware", "infected"],
    ] as const) {
      const bytes = cleanBytes(reason);
      await listAs(await sha256Of(bytes), reason);
      const two = await uploadedFile(bytes, { declared: rand(32) });
      expect(await deliver([{ body: explicit(two.file) }])).toEqual(ack);
      const row = (await nodeById(two.file.id))!;
      expect(row.scanStatus, reason).toBe(status);
      expect(row.sha256, reason).toBe(await sha256Of(bytes));
      if (reason === "malware") expect(await strikesOf(two.owner.id)).toHaveLength(1);
      else expect(row.legalHold).toBe(true);
    }
  });

  it("no session row left (trimmed): a scanned node compares with nodes.sha256; a never-scanned one does not compare", async () => {
    // Scanned before (scannedAt set, nodes.sha256 the server's of OTHER bytes) → mismatch.
    const bytes = cleanBytes();
    const a = await uploadedFile(bytes, { noSession: true, sha256: rand(32), scannedAt: new Date(0) });
    expect(await deliver([{ body: explicit(a.file) }])).toEqual(ack);
    expect(await nodeById(a.file.id)).toMatchObject({ scanStatus: "error", scanReason: "hash_mismatch" });
    // The same with equal bytes → its verdict.
    const b = await uploadedFile(bytes, {
      noSession: true,
      sha256: await sha256Of(bytes),
      scannedAt: new Date(0),
    });
    expect(await deliver([{ body: explicit(b.file) }])).toEqual(ack);
    expect((await nodeById(b.file.id))!.scanStatus).toBe("clean");
    // NEVER scanned (scannedAt null): nodes.sha256 is the client's unverified claim — no compare.
    const c = await uploadedFile(infectedBytes(), { noSession: true, sha256: rand(32), scannedAt: null });
    expect(await deliver([{ body: explicit(c.file) }])).toEqual(ack);
    expect(await nodeById(c.file.id)).toMatchObject({ scanStatus: "infected", scanReason: null });
    const d = await uploadedFile(cleanBytes(), { noSession: true, sha256: rand(32), scannedAt: null });
    expect(await deliver([{ body: explicit(d.file) }])).toEqual(ack);
    expect((await nodeById(d.file.id))!.scanStatus).toBe("clean");
  });

  it("a forced RESCAN after the session was trimmed still compares (resetToPending cleared scannedAt; the job row keeps the earlier verdict)", async () => {
    const bytes = cleanBytes();
    const { file } = await uploadedFile(bytes);
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
    // Seven days on: the session is trimmed; the stored bytes are (somehow) not what was scanned.
    await testDb().delete(uploads).where(eq(uploads.r2Key, file.r2Key!));
    await env.FILES.put(file.r2Key!, cleanBytes("different"));
    const rescan = serviceDeps();
    const sent: unknown[] = [];
    rescan.deps.env = {
      ...rescan.deps.env,
      SCAN_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    } as unknown as Env;
    await enqueueRescan(rescan.deps, file.id, { by: "owner" });
    await rescan.settle();
    expect((await nodeById(file.id))!.scannedAt).toBeNull();
    expect(await deliver([{ body: sent[0] }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "error", scanReason: "hash_mismatch" });
  });
});

describe("inherited takedown (Q-T21-3)", () => {
  it("a pending file two folders below a taken-down folder: clean and infected verdicts leave it; csam locks it", async () => {
    const owner = await makeUser();
    const top = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
    const middle = await makeFolder(owner.id, top.id);
    for (const bytes of [cleanBytes(), infectedBytes()]) {
      const { file } = await uploadedFile(bytes, { owner, parentId: middle.id });
      expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
      expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    }
    expect(await strikesOf(owner.id)).toHaveLength(0);
    expect(mails(owner, "quarantineNotice")).toBe(0);
    const bytes = cleanBytes();
    await listAs(await sha256Of(bytes), "csam");
    const { file } = await uploadedFile(bytes, { owner, parentId: middle.id });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
  });
});

describe("nodes.sha256 is the server hash after every verdict", () => {
  it("clean, infected, hash_mismatch, and the untouched rows; the owner's NodeDto shows it only after pending", async () => {
    const cases: [Uint8Array, Record<string, unknown>][] = [
      [cleanBytes(), {}],
      [infectedBytes(), {}],
      [cleanBytes(), { declared: rand(32) }],
      [cleanBytes(), { scanStatus: "suspected_csam" }],
      [cleanBytes(), { takedownAt: new Date(), takedownReason: "admin" }],
      [cleanBytes(), { scanStatus: "clean", scannedAt: new Date(0) }],
    ];
    for (const [bytes, opts] of cases) {
      const { file, owner } = await uploadedFile(bytes, {
        declared: opts.declared as string | undefined,
        ...opts,
      });
      // The mapper takes visible nodes only (a locked or taken-down one is never mapped).
      const visible = (row: typeof file) => row.scanStatus !== "suspected_csam" && row.takedownAt === null;
      if (visible(file)) {
        const pendingDto = await toNodeDto(testDb(), file, { viewerId: owner.id, role: "owner" });
        if (file.scanStatus === "pending") expect(pendingDto.sha256).toBeNull();
      }
      await deliver([{ body: explicit(file) }]);
      const row = (await nodeById(file.id))!;
      expect(row.sha256, JSON.stringify(opts)).toBe(await sha256Of(bytes));
      if (row.scanStatus !== "pending" && visible(row)) {
        const dto = await toNodeDto(testDb(), row, { viewerId: owner.id, role: "owner" });
        expect(dto.sha256, JSON.stringify(opts)).toBe(await sha256Of(bytes));
      }
    }
  });
});

describe("strikes", () => {
  it("same content, new node: three uploads of one infected file → three infected, ONE strike with the server hash, no suspension", async () => {
    const uploader = await makeUser();
    const bytes = infectedBytes();
    for (let n = 0; n < 3; n++) {
      const { file } = await uploadedFile(bytes, { owner: uploader });
      expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
      expect((await nodeById(file.id))!.scanStatus).toBe("infected");
    }
    const struck = await strikesOf(uploader.id);
    expect(struck).toHaveLength(1);
    expect(struck[0]!.contentSha256).toBe(await sha256Of(bytes));
    const [account] = await testDb().select().from(user).where(eq(user.id, uploader.id));
    expect(account!.suspendedAt).toBeNull();
  });

  it(`CONTROL: three different infected files → three strikes and a suspension (threshold ${STRIKES_TO_SUSPEND})`, async () => {
    const uploader = await makeUser();
    for (let n = 0; n < 3; n++) {
      const { file } = await uploadedFile(infectedBytes(), { owner: uploader });
      expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    }
    expect(await strikesOf(uploader.id)).toHaveLength(3);
    const [account] = await testDb().select().from(user).where(eq(user.id, uploader.id));
    expect(account!.suspendedAt).toBeInstanceOf(Date);
    expect(mails(uploader, "accountSuspended")).toBe(1);
  });

  it("strike repair on redelivery: the verdict committed, applySuspension never ran — the done row suspends; no new strike; one mail", async () => {
    const uploader = await makeUser();
    // Two prior strikes.
    for (let n = 0; n < 2; n++) {
      await addStrike(serviceDeps().deps, { userId: uploader.id, kind: "malware", sha256: rand(32) });
    }
    const real = (
      await vi.importActual<typeof import("../../../src/worker/services/strikes")>(
        "../../../src/worker/services/strikes",
      )
    ).addStrike;
    vi.mocked(addStrike).mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      return { ...result, applySuspension: () => Promise.reject(new Error("the invocation died here")) };
    });
    const { file } = await uploadedFile(infectedBytes(), { owner: uploader });
    // The verdict commits; the suspension step "dies": the message is retried, not acked.
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("infected");
    expect(await strikesOf(uploader.id)).toHaveLength(3);
    let [account] = await testDb().select().from(user).where(eq(user.id, uploader.id));
    expect(account!.suspendedAt).toBeNull();
    // The redelivery: job done, node infected → the threshold is enforced.
    expect(await deliver([{ body: explicit(file), attempts: 2 }])).toEqual(ack);
    expect(await strikesOf(uploader.id)).toHaveLength(3);
    [account] = await testDb().select().from(user).where(eq(user.id, uploader.id));
    expect(account!.suspendedAt).toBeInstanceOf(Date);
    expect(mails(uploader, "accountSuspended")).toBe(1);
    // Once more: still one mail.
    expect(await deliver([{ body: explicit(file), attempts: 3 }])).toEqual(ack);
    expect(mails(uploader, "accountSuspended")).toBe(1);
  });

  it("three deliveries of one infected file — rolled back, committed, forced — end with exactly one strike row", async () => {
    const uploader = await makeUser();
    const { file } = await uploadedFile(infectedBytes(), { owner: uploader });
    // 1: the verdict transaction rolls back at its last statement (after the strike row).
    vi.mocked(finish).mockImplementationOnce(async () => {
      throw new Error("connection lost at commit");
    });
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect(await strikesOf(uploader.id)).toHaveLength(0);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    // 2: committed.
    expect(await deliver([{ body: explicit(file), attempts: 2 }])).toEqual(ack);
    // 3: forced on the done job, node back to pending.
    await testDb().update(nodes).set({ scanStatus: "pending" }).where(eq(nodes.id, file.id));
    expect(await deliver([{ body: explicit(file, true) }])).toEqual(ack);
    const rows = await testDb().select().from(strikes).where(eq(strikes.nodeId, file.id));
    expect(rows).toHaveLength(1);
  });
});
