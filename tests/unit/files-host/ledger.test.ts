// Gate 5 and what follows it: the daily ledgers are CHARGED before the first byte — bytes only,
// the address first — and what was charged and then not sent is given back when the stream ends.
// Every limit here is the test's own (`settings.ceilings`), every subject a row this file made.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addUsage, utcDay } from "../../../src/worker/db/queries/ledger";
import { auditLog, downloadLedger } from "../../../src/worker/db/schema";
import { settleOnce } from "../../../src/worker/files-host";
import {
  notifyLinkLimitOnce,
  notifyLinkPausedOnce,
  notifyOwnerLinkCapOnce,
  settleServe,
  type ServeCharge,
} from "../../../src/worker/services/ledger";
import { serviceDeps } from "../auth/helpers";
import {
  accessLog,
  ask,
  FAKE_WEBP,
  freshIp,
  gate,
  imagesMock,
  ipSubject,
  ledgerBytes,
  ledgerRow,
  linkById,
  lineUp,
  linkOn,
  mailTo,
  makeAccount,
  makeShare,
  MESSAGES,
  open,
  pattern,
  readThenCancel,
  spyBucket,
  storedFile,
  testDb,
  updateLink,
  urlFor,
  type AskOptions,
} from "./harness";

const SIZE = 1000;
const ceilings = (values: Record<string, number>): AskOptions => ({ settings: { ceilings: values } });

/** An owner, a picture of `SIZE` bytes and a link on it. */
async function world(bytes = SIZE) {
  const owner = await makeAccount();
  const file = await storedFile(owner.id, { content: pattern(bytes), mime: "image/png", name: "p.png" });
  const link = await linkOn(file.node.id, owner.id);
  return { owner, file, node: file.node, link };
}

const yesterday = () => new Date(Date.now() - 86_400_000);

describe("gate 5 — what a response is charged", () => {
  it("a 200 charges the full size and a 206 the length of its range — on the user's and the address's ledger, bytes only", async () => {
    const { owner, node } = await world();
    const ip = freshIp();
    const url = await urlFor("download", node, { user: owner.id });
    expect((await ask(url, { ip })).status).toBe(200);
    expect(await ledgerRow("user", owner.id)).toEqual({ bytes: SIZE, count: 0 });
    expect(await ledgerRow("ip", await ipSubject(ip))).toEqual({ bytes: SIZE, count: 0 });

    expect((await ask(url, { ip, headers: { range: "bytes=100-199" } })).status).toBe(206);
    expect(await ledgerRow("user", owner.id)).toEqual({ bytes: SIZE + 100, count: 0 });
    expect(await ledgerRow("ip", await ipSubject(ip))).toEqual({ bytes: SIZE + 100, count: 0 });
    // A signed-in download is never the owner's LINK egress.
    expect(await ledgerRow("link_owner", owner.id)).toBeNull();
  });

  it("a link token charges three ledgers — the address, the owner's links, the link — and never a count; 20 ranges leave the link's daily count where the mint left it", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    // What the mint of this link's download URL has counted so far today.
    await addUsage(testDb(), utcDay(), "link", link.id, 0, 3);
    const url = await urlFor("download", node, { link });
    expect((await ask(url, { ip })).status).toBe(200);
    expect(await ledgerRow("link", link.id)).toEqual({ bytes: SIZE, count: 3 });
    expect(await ledgerRow("link_owner", owner.id)).toEqual({ bytes: SIZE, count: 0 });
    expect(await ledgerRow("ip", await ipSubject(ip))).toEqual({ bytes: SIZE, count: 0 });
    expect(await ledgerRow("user", owner.id)).toBeNull();

    let expected = SIZE;
    for (let i = 0; i < 20; i++) {
      const range = i === 0 ? "bytes=0-99" : i === 1 ? "bytes=1-" : `bytes=${i}-${i + 9}`;
      expect((await ask(url, { ip, headers: { range } })).status).toBe(206);
      expected += i === 0 ? 100 : i === 1 ? SIZE - 1 : 10;
    }
    expect(await ledgerRow("link", link.id)).toEqual({ bytes: expected, count: 3 });
    expect(await ledgerRow("link_owner", owner.id)).toEqual({ bytes: expected, count: 0 });
    expect((await linkById(link.id)).bytesServed).toBe(expected);
    expect((await linkById(link.id)).downloadCount).toBe(0);
  });

  it("a 304 — on /d/, /i/ and /t/ — a 412 and a 416 charge nothing: no ledger row is even created", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const images = imagesMock();
    const env = { IMAGES: images.binding };
    // The validators, learnt with another subject so that this one's ledgers stay untouched.
    const other = await makeAccount();
    await makeShare(node.id, owner.id, other.id);
    const tags: Record<string, string> = {};
    for (const kind of ["download", "inline", "thumb"] as const) {
      const first = await ask(await urlFor(kind, node, { user: other.id }), { env });
      expect(first.status).toBe(200);
      // The thumbnail's validator is its cached object's: the second request has it.
      const again = await ask(await urlFor(kind, node, { user: other.id }), { env });
      tags[kind] = again.headers.get("etag")!;
      expect(tags[kind]).toBeTruthy();
    }
    for (const subject of [{ user: owner.id }, { link }]) {
      for (const kind of ["download", "inline", "thumb"] as const) {
        const url = await urlFor(kind, node, subject);
        const cached = await ask(url, { ip, env, headers: { "if-none-match": tags[kind]! } });
        expect(cached.status, kind).toBe(304);
        expect((await ask(url, { ip, env, headers: { "if-match": '"another"' } })).status, kind).toBe(412);
        expect((await ask(url, { ip, env, headers: { range: "bytes=99999-" } })).status, kind).toBe(416);
      }
    }
    expect(await ledgerRow("user", owner.id)).toBeNull();
    expect(await ledgerRow("link", link.id)).toBeNull();
    expect(await ledgerRow("link_owner", owner.id)).toBeNull();
    expect(await ledgerRow("ip", await ipSubject(ip))).toBeNull();
    expect((await linkById(link.id)).bytesServed).toBe(0);
  });

  it("this host writes no audit row: not for a full download, 20 ranges, an inline view or a thumbnail", async () => {
    const { owner, node, link } = await world();
    const env = { IMAGES: imagesMock().binding };
    for (const subject of [{ user: owner.id }, { link }]) {
      expect((await ask(await urlFor("download", node, subject))).status).toBe(200);
      for (let i = 0; i < 20; i++) {
        const range = i === 0 ? "bytes=0-99" : `bytes=${i}-`;
        expect((await ask(await urlFor("download", node, subject), { headers: { range } })).status).toBe(206);
      }
      expect((await ask(await urlFor("inline", node, subject))).status).toBe(200);
      expect((await ask(await urlFor("thumb", node, subject), { env })).status).toBe(200);
    }
    const about = (id: string) => testDb().select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(await about(node.id)).toEqual([]);
    expect(await about(link.id)).toEqual([]);
    expect(await testDb().select().from(auditLog).where(eq(auditLog.actorUserId, owner.id))).toEqual([]);
  });
});

describe("gate 5 — the ceilings are consumed atomically, the address first", () => {
  it("two parallel downloads that each fit under the user's ceiling alone but not together → one 200, one 429, one response's bytes on the ledger", async () => {
    const { owner, node } = await world();
    const url = await urlFor("download", node, { user: owner.id });
    // Both are lined up at their read of the object, so their charges overlap.
    const limits = {
      ...ceilings({ CEIL_USER_BYTES_DAY: SIZE + 500 }),
      env: { FILES: lineUp(2, "u/").bucket },
    };
    const answers = await Promise.all([ask(url, limits), ask(url, limits)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 429]);
    const refusal = answers.find((answer) => answer.status === 429)!;
    expect(refusal.text).toBe(MESSAGES.ceiling_exceeded);
    expect(Number(refusal.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(refusal.headers.get("retry-after"))).toBeLessThanOrEqual(86_400);
    // The app reads it across origins (Addendum 12).
    expect(refusal.headers.get("access-control-expose-headers")?.split(", ")).toContain("Retry-After");
    expect(await ledgerBytes("user", owner.id)).toBe(SIZE);
  });

  it("the same for a link's ceiling and for an address's", async () => {
    const forLink = await world();
    const url = await urlFor("download", forLink.node, { link: forLink.link });
    const limits = ceilings({ CEIL_LINK_BYTES_DAY: SIZE + 500 });
    const answers = await Promise.all([ask(url, limits), ask(url, limits)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 429]);
    expect(await ledgerBytes("link", forLink.link.id)).toBe(SIZE);

    const a = await world();
    const b = await world();
    const ip = freshIp();
    const perIp = { ...ceilings({ CEIL_IP_BYTES_DAY: SIZE + 500 }), ip };
    const both = await Promise.all([
      ask(await urlFor("download", a.node, { user: a.owner.id }), perIp),
      ask(await urlFor("download", b.node, { user: b.owner.id }), perIp),
    ]);
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 429]);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE);
    // The refused request reached no user's ledger.
    expect((await ledgerBytes("user", a.owner.id)) + (await ledgerBytes("user", b.owner.id))).toBe(SIZE);
  });

  it("an address over its own ceiling asks for a link's file 50 times → 50 × 429, and neither the link's nor the owner's ledger moves", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const url = await urlFor("download", node, { link });
    const limits = { ...ceilings({ CEIL_IP_BYTES_DAY: SIZE - 1 }), ip };
    for (let i = 0; i < 50; i++) {
      const answer = await ask(url, limits);
      expect(answer.status).toBe(429);
      expect(answer.text).toBe(MESSAGES.ceiling_exceeded);
    }
    expect(await ledgerRow("link", link.id)).toBeNull();
    expect(await ledgerRow("link_owner", owner.id)).toBeNull();
    expect(await ledgerRow("ip", await ipSubject(ip))).toBeNull();
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
    expect(mailTo(owner.email)).toEqual([]);
  });

  it("the subject refuses after the address was charged → 429, and the address keeps its charge", async () => {
    const { owner, node } = await world();
    const ip = freshIp();
    const answer = await ask(await urlFor("download", node, { user: owner.id }), {
      ...ceilings({ CEIL_USER_BYTES_DAY: SIZE - 1 }),
      ip,
    });
    expect(answer.status).toBe(429);
    expect(await ledgerRow("user", owner.id)).toBeNull();
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE);
  });

  it("a refusal after the store was asked cancels the open body, and no byte is served", async () => {
    for (const limit of ["CEIL_IP_BYTES_DAY", "CEIL_USER_BYTES_DAY"]) {
      const { owner, node } = await world();
      const spy = spyBucket();
      const answer = await ask(await urlFor("download", node, { user: owner.id }), {
        ...ceilings({ [limit]: SIZE - 1 }),
        env: { FILES: spy.bucket },
      });
      expect(answer.status, limit).toBe(429);
      expect(answer.text).toBe(MESSAGES.ceiling_exceeded);
      expect(spy.gets, limit).toHaveLength(1);
      expect(spy.cancelled, limit).toBe(1);
    }
    for (const limit of ["CEIL_OWNER_LINK_BYTES_DAY", "CEIL_LINK_BYTES_DAY"]) {
      const { node, link } = await world();
      const spy = spyBucket();
      const answer = await ask(await urlFor("download", node, { link }), {
        ...ceilings({ [limit]: SIZE - 1 }),
        env: { FILES: spy.bucket },
      });
      expect(answer.status, limit).toBe(429);
      expect(answer.bytes.byteLength).toBe(MESSAGES.ceiling_exceeded.length);
      expect(spy.cancelled, limit).toBe(1);
      expect((await accessLog(link.id)).map((row) => row.outcome)).toEqual(["denied_cap"]);
      expect((await linkById(link.id)).pauseReasons, limit).toEqual([]);
    }
  });
});

describe("a link's own ceiling: a 429 while its ledger is full, one mail that day — and never a pause", () => {
  it("five downloads opened and never read fill the link; the sixth is 429; when the five are given up the NEXT request is served — the link was never paused, and its owner got one mail", async () => {
    const { owner, node, link } = await world();
    const url = await urlFor("download", node, { link });
    const limits = ceilings({ CEIL_LINK_BYTES_DAY: SIZE * 5 });
    const held = [];
    for (let i = 0; i < 5; i++) held.push(await open(url, limits));
    expect(held.map((one) => one.response.status)).toEqual([200, 200, 200, 200, 200]);
    const refused = await ask(url, limits);
    expect(refused.status).toBe(429);
    expect(refused.text).toBe(MESSAGES.ceiling_exceeded);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
    expect(await ledgerBytes("link", link.id)).toBe(SIZE * 5);
    // Still full: refused again, and no second mail.
    expect((await ask(url, limits)).status).toBe(429);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
    expect(mailTo(owner.email, "linkLimitReached")[0]?.text).toMatch(/“p.png”/);
    expect(mailTo(owner.email, "linkLimitReached")[0]?.text).not.toMatch(/paused/i);

    for (const one of held) {
      await one.response.body!.cancel();
      await one.ctx.settle();
    }
    expect(await ledgerBytes("link", link.id)).toBe(0);
    const next = await ask(url, limits);
    expect(next.status).toBe(200);
    expect(next.bytes).toHaveLength(SIZE);
    const row = await linkById(link.id);
    expect(row.pauseReasons).toEqual([]);
    expect(row.pausedAt).toBeNull();
    expect(row.lastPauseEmailAt).toBeNull();
    expect(row.bytesServed).toBe(SIZE);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
    expect(mailTo(owner.email, "linkPaused")).toEqual([]);
    // The two refused requests took nothing from the owner's cap: what was charged there before
    // the link refused went straight back.
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE);
    expect((await accessLog(link.id)).map((entry) => entry.outcome)).toEqual(["denied_cap", "denied_cap"]);
  });

  it("fifty requests refused at a full link take nothing from the owner's cap — only from the asking address", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const url = await urlFor("download", node, { link });
    const limits = ceilings({ CEIL_LINK_BYTES_DAY: SIZE + 100 });
    expect((await ask(url, limits)).status).toBe(200);
    for (let i = 0; i < 50; i++) expect((await ask(url, { ...limits, ip })).status).toBe(429);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE);
    expect(await ledgerBytes("link", link.id)).toBe(SIZE);
    // Every refused request cost the address its size: fifty of them, none given back.
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE * 50);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
  });

  it("a request that was charged and then fails before its first byte gives the owner and the link their bytes back; the asking address keeps its charge", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const spy = spyBucket();
    // The request's deferred work is refused outright, so the settle cannot be arranged — a
    // failure AFTER all three ledgers were charged, and not one of them refusing.
    const answer = await ask(await urlFor("download", node, { link }), {
      ip,
      limits: { maxDeferredTasks: 0 },
      env: { FILES: spy.bucket },
    });
    expect(answer.status).toBe(500);
    expect(answer.text).toBe("Something went wrong.\n");
    expect(spy.cancelled).toBe(1);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(0);
    expect(await ledgerBytes("link", link.id)).toBe(0);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE);
    expect((await linkById(link.id)).bytesServed).toBe(0);
    // The control: the same request with its deferred work allowed is served and charged.
    expect((await ask(await urlFor("download", node, { link }), { ip })).status).toBe(200);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE);
    expect(await ledgerBytes("link", link.id)).toBe(SIZE);
  });

  it("a link really used up answers 429 until the day rolls over, without a pause; a link paused for another reason still answers 423 and is not touched", async () => {
    const { owner, node, link } = await world();
    const url = await urlFor("download", node, { link });
    const limits = ceilings({ CEIL_LINK_BYTES_DAY: SIZE + 500 });
    expect((await ask(url, limits)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await ask(url, limits)).status).toBe(429);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
    // What still fits is served: the refusal is the ledger, not a switch.
    expect((await ask(url, { ...limits, headers: { range: "bytes=0-99" } })).status).toBe(206);
    // Tomorrow's ledger is empty.
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect((await ask(url, { ...limits, now: tomorrow })).status).toBe(200);

    await updateLink(link.id, { pauseReasons: ["report"], pausedAt: new Date() });
    const paused = await ask(url, limits);
    expect(paused.status).toBe(423);
    expect(paused.text).toBe(MESSAGES.link_paused);
    expect((await linkById(link.id)).pauseReasons).toEqual(["report"]);
  });

  it("a pause that arrives while a request is being refused for the ceiling is left as it is: nothing is added to the link's reasons", async () => {
    const { owner, node, link } = await world();
    const url = await urlFor("download", node, { link });
    const limits = ceilings({ CEIL_LINK_BYTES_DAY: SIZE - 1 });
    // The pause arrives between this request's gates and its charge: gate 4g saw a live link.
    const racing = spyBucket({
      get: (async (key: string, options?: R2GetOptions) => {
        await updateLink(link.id, { pauseReasons: ["report"], pausedAt: new Date() });
        return spyBucket().bucket.get(key, options);
      }) as R2Bucket["get"],
    });
    expect((await ask(url, { ...limits, env: { FILES: racing.bucket } })).status).toBe(429);
    expect((await linkById(link.id)).pauseReasons).toEqual(["report"]);
    expect(mailTo(owner.email, "linkPaused")).toEqual([]);
  });

  it("notifyLinkLimitOnce: once per link per UTC day — twenty at once, one mail; another link of the owner has its own; true again the next day; nothing for a link that does not exist", async () => {
    const { owner, node, link } = await world();
    const second = await linkOn(node.id, owner.id);
    const { deps, settle } = serviceDeps();
    const won = await Promise.all(Array.from({ length: 20 }, () => notifyLinkLimitOnce(deps, link.id)));
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await notifyLinkLimitOnce(deps, link.id)).toBe(false);
    expect(await notifyLinkLimitOnce(deps, second.id)).toBe(true);
    await settle();
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(2);
    expect(await ledgerRow("notice", `download_link:${link.id}`)).toEqual({ bytes: 0, count: 1 });
    // The marker is no part of the link's own ledger.
    expect(await ledgerRow("link", link.id)).toBeNull();
    expect(await notifyLinkLimitOnce(deps, link.id, new Date(Date.now() + 86_400_000))).toBe(true);
    expect(await notifyLinkLimitOnce(deps, link.id, new Date(Date.now() + 86_400_000))).toBe(false);
    expect(await notifyLinkLimitOnce(deps, crypto.randomUUID())).toBe(false);
    expect(await notifyLinkLimitOnce(deps, "not-an-id")).toBe(false);
    expect(await ledgerRow("notice", "download_link:not-an-id")).toBeNull();
  });

  it("a link at its limit and an owner at their cap each mail once: two different mails", async () => {
    const { owner, node, link } = await world();
    const other = await storedFile(owner.id, { content: pattern(SIZE, 7) });
    const otherLink = await linkOn(other.node.id, owner.id);
    const url = await urlFor("download", node, { link });
    // The link takes one file a day; the owner's links together two.
    const limits = ceilings({ CEIL_LINK_BYTES_DAY: SIZE + 100, CEIL_OWNER_LINK_BYTES_DAY: SIZE * 2 + 100 });
    expect((await ask(url, limits)).status).toBe(200);
    // Refused by the LINK: the owner's cap had room, and keeps it.
    expect((await ask(url, limits)).status).toBe(429);
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
    expect(mailTo(owner.email, "linkCapReached")).toEqual([]);
    // The owner's other link fills the cap; from then on every link of theirs is refused by it.
    expect((await ask(await urlFor("download", other.node, { link: otherLink }), limits)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await ask(url, limits)).status).toBe(429);
      expect((await ask(await urlFor("download", other.node, { link: otherLink }), limits)).status).toBe(429);
    }
    expect(mailTo(owner.email, "linkLimitReached")).toHaveLength(1);
    expect(mailTo(owner.email, "linkCapReached")).toHaveLength(1);
    for (const one of [link, otherLink]) expect((await linkById(one.id)).pauseReasons).toEqual([]);
  });

  it("notifyLinkPausedOnce: true and one mail the first time that day; false after, whatever the reason; one winner of two at once; true again the next UTC day — with a bare ServiceDeps", async () => {
    const { owner, link } = await world();
    const { deps, settle } = serviceDeps();
    expect(await notifyLinkPausedOnce(deps, link.id, "ceiling")).toBe(true);
    await settle();
    expect(mailTo(owner.email, "linkPaused")).toHaveLength(1);
    // The item's name, as the mail's label writer renders it.
    expect(mailTo(owner.email, "linkPaused")[0]?.text).toMatch(/“p.png”/);
    expect(await notifyLinkPausedOnce(deps, link.id, "ceiling")).toBe(false);
    expect(await notifyLinkPausedOnce(deps, link.id, "report")).toBe(false);
    await settle();
    expect(mailTo(owner.email, "linkPaused")).toHaveLength(1);

    // The next UTC day: the stamp is yesterday's.
    await updateLink(link.id, { lastPauseEmailAt: yesterday() });
    const both = await Promise.all([
      notifyLinkPausedOnce(deps, link.id, "ceiling"),
      notifyLinkPausedOnce(deps, link.id, "anomaly"),
    ]);
    expect(both.sort()).toEqual([false, true]);
    await settle();
    expect(mailTo(owner.email, "linkPaused")).toHaveLength(2);

    // No such link: nothing claimed, nothing sent.
    expect(await notifyLinkPausedOnce(deps, crypto.randomUUID(), "ceiling")).toBe(false);
    expect(await notifyLinkPausedOnce(deps, "not-an-id", "ceiling")).toBe(false);
  });

  it("twenty concurrent claims for one link → one mail", async () => {
    const { owner, link } = await world();
    const { deps, settle } = serviceDeps();
    const won = await Promise.all(
      Array.from({ length: 20 }, () => notifyLinkPausedOnce(deps, link.id, "ceiling")),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    await settle();
    expect(mailTo(owner.email, "linkPaused")).toHaveLength(1);
  });
});

describe("the owner's cap over all their links (download_owner)", () => {
  const CAP = SIZE * 2 + 500;
  const limits = ceilings({ CEIL_OWNER_LINK_BYTES_DAY: CAP });

  async function twoLinks() {
    const owner = await makeAccount();
    const fileA = await storedFile(owner.id, { content: pattern(SIZE) });
    const fileB = await storedFile(owner.id, { content: pattern(SIZE, 5) });
    const a = await linkOn(fileA.node.id, owner.id);
    const b = await linkOn(fileB.node.id, owner.id);
    return {
      owner,
      a,
      b,
      fileA,
      urlA: await urlFor("download", fileA.node, { link: a }),
      urlB: await urlFor("download", fileB.node, { link: b }),
    };
  }

  it("the SUM over two links decides: B is refused once it passes the cap although each link is far under its own; then both are; neither link is paused; the per-link ledgers do not move", async () => {
    const { owner, a, b, urlA, urlB, fileA } = await twoLinks();
    expect((await ask(urlA, limits)).status).toBe(200);
    expect((await ask(urlA, limits)).status).toBe(200);
    const refused = await ask(urlB, limits);
    expect(refused.status).toBe(429);
    expect(refused.text).toBe(MESSAGES.ceiling_exceeded);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await ask(urlA, limits)).status).toBe(429);
    expect((await ask(urlB, limits)).status).toBe(429);

    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE * 2);
    // The owner's cap is consumed BEFORE the link's: a refused request leaves the link's alone.
    expect(await ledgerBytes("link", a.id)).toBe(SIZE * 2);
    expect(await ledgerRow("link", b.id)).toBeNull();
    for (const link of [a, b]) {
      const row = await linkById(link.id);
      expect(row.pauseReasons).toEqual([]);
      expect(row.pausedAt).toBeNull();
    }
    expect(mailTo(owner.email, "linkPaused")).toEqual([]);

    // What still fits under the cap is served: the refusal is the sum, not a switch.
    expect((await ask(urlA, { ...limits, headers: { range: "bytes=0-99" } })).status).toBe(206);

    // The owner's own signed-in download is not link egress: not refused, and not counted there.
    const own = await ask(await urlFor("download", fileA.node, { user: owner.id }), limits);
    expect(own.status).toBe(200);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE * 2 + 100);
    expect(await ledgerBytes("user", owner.id)).toBe(SIZE);

    // Another owner's link is not affected.
    const other = await world();
    expect((await ask(await urlFor("download", other.node, { link: other.link }), limits)).status).toBe(200);
  });

  it("one mail to the owner that day across 50 refusals on both links; the marker is a `notice` row of 0 bytes that no byte total includes; one mail again the next UTC day", async () => {
    const { owner, urlA, urlB } = await twoLinks();
    const small = ceilings({ CEIL_OWNER_LINK_BYTES_DAY: SIZE - 1 });
    for (let i = 0; i < 50; i++) {
      expect((await ask(i % 2 ? urlA : urlB, small)).status).toBe(429);
    }
    expect(mailTo(owner.email, "linkCapReached")).toHaveLength(1);
    const marker = `download_owner:${owner.id}`;
    expect(await ledgerRow("notice", marker)).toEqual({ bytes: 0, count: 1 });
    expect(await ledgerRow("link_owner", owner.id)).toBeNull();
    expect(await ledgerRow("link_owner", marker)).toBeNull();

    // The next UTC day: today's marker becomes yesterday's.
    await testDb()
      .update(downloadLedger)
      .set({ day: utcDay(yesterday()) })
      .where(and(eq(downloadLedger.subjectType, "notice"), eq(downloadLedger.subjectId, marker)));
    for (let i = 0; i < 5; i++) expect((await ask(urlA, small)).status).toBe(429);
    expect(mailTo(owner.email, "linkCapReached")).toHaveLength(2);
  });

  it("two refusals at once → one mail; notifyOwnerLinkCapOnce answers true exactly once a day, per owner", async () => {
    const { owner, urlA, urlB } = await twoLinks();
    const small = ceilings({ CEIL_OWNER_LINK_BYTES_DAY: SIZE - 1 });
    const answers = await Promise.all([ask(urlA, small), ask(urlB, small), ask(urlA, small)]);
    expect(answers.map((answer) => answer.status)).toEqual([429, 429, 429]);
    expect(mailTo(owner.email, "linkCapReached")).toHaveLength(1);

    const fresh = await makeAccount();
    const { deps, settle } = serviceDeps();
    const won = await Promise.all(Array.from({ length: 20 }, () => notifyOwnerLinkCapOnce(deps, fresh.id)));
    expect(won.filter(Boolean)).toHaveLength(1);
    await settle();
    expect(mailTo(fresh.email, "linkCapReached")).toHaveLength(1);
    // Another day is another claim; the same day again is none.
    expect(await notifyOwnerLinkCapOnce(deps, fresh.id, new Date(Date.now() + 86_400_000))).toBe(true);
    expect(await notifyOwnerLinkCapOnce(deps, fresh.id, new Date(Date.now() + 86_400_000))).toBe(false);
    expect(await notifyOwnerLinkCapOnce(deps, fresh.id)).toBe(false);
  });
});

describe("unsent bytes are given back when the stream ends", () => {
  const N = 400;

  it("a signed-in download cancelled after N bytes leaves exactly N on the address's and the user's ledger; a completed one leaves the size", async () => {
    const { owner, node } = await world();
    const ip = freshIp();
    const url = await urlFor("download", node, { user: owner.id });
    const chunked = spyBucket({}, { splitAt: N });
    const { response, ctx } = await open(url, { ip, env: { FILES: chunked.bucket } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    // Charged in full before the first byte.
    expect(await ledgerBytes("user", owner.id)).toBe(SIZE);
    expect(await readThenCancel(response, N)).toBe(N);
    await ctx.settle();
    expect(await ledgerBytes("user", owner.id)).toBe(N);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(N);

    expect((await ask(url, { ip })).status).toBe(200);
    expect(await ledgerBytes("user", owner.id)).toBe(N + SIZE);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(N + SIZE);
  });

  it("a link download cancelled after N bytes leaves N on all three ledgers, and `bytesServed` is the bytes sent", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const chunked = spyBucket({}, { splitAt: N });
    const { response, ctx } = await open(await urlFor("download", node, { link }), {
      ip,
      env: { FILES: chunked.bucket },
    });
    expect(await ledgerBytes("link", link.id)).toBe(SIZE);
    expect(await readThenCancel(response, N)).toBe(N);
    await ctx.settle();
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(N);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(N);
    expect(await ledgerBytes("link", link.id)).toBe(N);
    expect((await linkById(link.id)).bytesServed).toBe(N);
  });

  it("a 206 of length L cancelled after N leaves N; a response nobody reads at all leaves 0", async () => {
    const { owner, node } = await world();
    const chunked = spyBucket({}, { splitAt: N });
    const url = await urlFor("download", node, { user: owner.id });
    const ranged = await open(url, { headers: { range: "bytes=100-799" }, env: { FILES: chunked.bucket } });
    expect(ranged.response.status).toBe(206);
    expect(ranged.response.headers.get("content-length")).toBe("700");
    expect(await ledgerBytes("user", owner.id)).toBe(700);
    expect(await readThenCancel(ranged.response, N)).toBe(N);
    await ranged.ctx.settle();
    expect(await ledgerBytes("user", owner.id)).toBe(N);

    const unread = await open(url, { env: { FILES: spyBucket({}, { splitAt: 500 }).bucket } });
    await unread.response.body!.cancel();
    await unread.ctx.settle();
    expect(await ledgerBytes("user", owner.id)).toBe(N);
  });

  it("a refund that arrives after 00:00 UTC is dropped: yesterday's rows keep the full charge and today's are untouched", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const lastNight = new Date(`${utcDay(yesterday())}T23:59:59.000Z`);
    const day = utcDay(lastNight);
    const chunked = spyBucket({}, { splitAt: N });
    for (const subject of [{ user: owner.id }, { link }]) {
      const { response, ctx } = await open(await urlFor("download", node, subject), {
        ip,
        now: lastNight,
        env: { FILES: chunked.bucket },
      });
      expect(response.status).toBe(200);
      expect(await readThenCancel(response, N)).toBe(N);
      await ctx.settle();
    }
    // Booked on the day the request's clock said — and not given back on another.
    expect(await ledgerBytes("user", owner.id, day)).toBe(SIZE);
    expect(await ledgerBytes("link", link.id, day)).toBe(SIZE);
    expect(await ledgerBytes("link_owner", owner.id, day)).toBe(SIZE);
    expect(await ledgerBytes("ip", await ipSubject(ip, lastNight), day)).toBe(SIZE * 2);
    expect(await ledgerRow("user", owner.id)).toBeNull();
    expect(await ledgerRow("link", link.id)).toBeNull();
    expect(await ledgerRow("link_owner", owner.id)).toBeNull();
    expect(await ledgerRow("ip", await ipSubject(ip))).toBeNull();
    // What was SENT is still the link's.
    expect((await linkById(link.id)).bytesServed).toBe(N);
  });

  it("a thumbnail is charged its own length — the cached object's, or the new one's — and a cancelled one is given back too", async () => {
    const { owner, node, link } = await world();
    const env = { IMAGES: imagesMock().binding };
    expect((await ask(await urlFor("thumb", node, { user: owner.id }), { env })).status).toBe(200);
    expect(await ledgerBytes("user", owner.id)).toBe(FAKE_WEBP.byteLength);
    expect((await ask(await urlFor("thumb", node, { link }), { env })).status).toBe(200);
    expect(await ledgerBytes("link", link.id)).toBe(FAKE_WEBP.byteLength);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(FAKE_WEBP.byteLength);
    const { response, ctx } = await open(await urlFor("thumb", node, { user: owner.id }), {
      env: { ...env, FILES: spyBucket({}, { splitAt: 5 }).bucket },
    });
    expect(await readThenCancel(response, 5)).toBe(5);
    await ctx.settle();
    expect(await ledgerBytes("user", owner.id)).toBe(FAKE_WEBP.byteLength + 5);
  });
});

describe("the settle runs once, on the request's client or — for a long stream — in a context of its own", () => {
  const N = 300;
  // A quarter of this is how long the settle may still use the request's own client.
  const limits = { drainDeadlineMs: 160 };

  it("a stream that outlives the request's drain is settled afterwards: cancelled after N → N on every ledger, and bytesServed", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const chunked = spyBucket({}, { splitAt: N });
    const { response, ctx } = await open(await urlFor("download", node, { link }), {
      ip,
      limits,
      env: { FILES: chunked.bucket },
    });
    // The request's deferred work drains and its client closes while the body is still open.
    await ctx.settle();
    expect(await ledgerBytes("link", link.id)).toBe(SIZE);
    const handed = ctx.next();
    expect(await readThenCancel(response, N)).toBe(N);
    // The settle is handed to the context at the moment the stream ends — once.
    await handed;
    expect(ctx.pending).toHaveLength(1);
    await ctx.settle();
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(N);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(N);
    expect(await ledgerBytes("link", link.id)).toBe(N);
    expect((await linkById(link.id)).bytesServed).toBe(N);
  });

  it("the same stream read to its end keeps the full charge — and settles exactly once on either path", async () => {
    const { owner, node, link } = await world();
    const late = await open(await urlFor("download", node, { link }), { limits });
    await late.ctx.settle();
    const handed = late.ctx.next();
    expect(new Uint8Array(await late.response.arrayBuffer())).toHaveLength(SIZE);
    await handed;
    expect(late.ctx.pending).toHaveLength(1);
    await late.ctx.settle();
    expect(await ledgerBytes("link", link.id)).toBe(SIZE);
    expect((await linkById(link.id)).bytesServed).toBe(SIZE);

    // In time: nothing is handed to the context when the stream ends — the settle was deferred
    // before the handler returned.
    const early = await open(await urlFor("download", node, { link }));
    expect(new Uint8Array(await early.response.arrayBuffer())).toHaveLength(SIZE);
    await early.ctx.settle();
    expect(await ledgerBytes("link", link.id)).toBe(SIZE * 2);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE * 2);
    expect((await linkById(link.id)).bytesServed).toBe(SIZE * 2);
  });
});

describe("what a reservation can and cannot do", () => {
  it("one byte of a large object reserves one byte: `bytes=0-0` charges 1 on every ledger", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    expect(
      (await ask(await urlFor("download", node, { link }), { ip, headers: { range: "bytes=0-0" } })).status,
    ).toBe(206);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(1);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(1);
    expect(await ledgerBytes("link", link.id)).toBe(1);
    expect((await linkById(link.id)).bytesServed).toBe(1);
  });

  it("downloads held open by ONE address reserve at most that address's own ceiling on the owner's cap and on the link — and all of it comes back when they end", async () => {
    const { owner, node, link } = await world();
    const ip = freshIp();
    const url = await urlFor("download", node, { link });
    // The address may take two and a half files a day; the link and the owner far more.
    const limits = { ...ceilings({ CEIL_IP_BYTES_DAY: SIZE * 2 + 500 }), ip };
    const held = [];
    for (let i = 0; i < 6; i++) held.push(await open(url, limits));
    expect(held.map((one) => one.response.status)).toEqual([200, 200, 429, 429, 429, 429]);
    // Nothing was read: two responses' bytes are reserved, on the address FIRST — the four
    // refused requests reached neither the owner's nor the link's ledger.
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE * 2);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE * 2);
    expect(await ledgerBytes("link", link.id)).toBe(SIZE * 2);
    expect((await linkById(link.id)).pauseReasons).toEqual([]);

    for (const one of held) {
      await one.response.body?.cancel();
      await one.ctx.settle();
    }
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(0);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(0);
    expect(await ledgerBytes("link", link.id)).toBe(0);
    expect((await linkById(link.id)).bytesServed).toBe(0);
    // Another address is not affected by the first one's refusals.
    expect((await ask(url, ceilings({ CEIL_IP_BYTES_DAY: SIZE * 2 + 500 }))).status).toBe(200);
  });

  it("two downloads at once through two links of one owner, fitting under the owner's cap alone but not together → one 200, one 429", async () => {
    const owner = await makeAccount();
    const urls: string[] = [];
    for (let i = 0; i < 2; i++) {
      const file = await storedFile(owner.id, { content: pattern(SIZE, i) });
      urls.push(await urlFor("download", file.node, { link: await linkOn(file.node.id, owner.id) }));
    }
    const limits = ceilings({ CEIL_OWNER_LINK_BYTES_DAY: SIZE + 500 });
    const answers = await Promise.all(urls.map((url) => ask(url, limits)));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 429]);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(SIZE);
  });

  it("the settle never gives back more than was charged: a count above the charge, below zero or not a number refunds nothing", async () => {
    const { owner, link } = await world();
    const { deps } = serviceDeps();
    const day = utcDay();
    const charged = async (): Promise<ServeCharge> => {
      await testDb().delete(downloadLedger).where(eq(downloadLedger.subjectId, owner.id));
      await addUsage(testDb(), day, "user", owner.id, SIZE, 0);
      await addUsage(testDb(), day, "link_owner", owner.id, SIZE, 0);
      return {
        bytes: SIZE,
        linkId: link.id,
        charges: [
          { kind: "download_user", subjectId: owner.id, receipt: { day } },
          { kind: "download_owner", subjectId: owner.id, receipt: { day } },
        ],
      };
    };
    for (const sent of [SIZE, SIZE + 1, SIZE * 10, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      await settleServe(deps, await charged(), sent);
      expect(await ledgerBytes("user", owner.id), String(sent)).toBe(SIZE);
      expect(await ledgerBytes("link_owner", owner.id), String(sent)).toBe(SIZE);
    }
    // Only real counts were added to the link: SIZE, then SIZE capped twice.
    expect((await linkById(link.id)).bytesServed).toBe(SIZE * 3);
    // The control: an honest count gives the rest back, on every ledger.
    await settleServe(deps, await charged(), 250);
    expect(await ledgerBytes("user", owner.id)).toBe(250);
    expect(await ledgerBytes("link_owner", owner.id)).toBe(250);
    // A charge of nothing (a response without a body) settles to nothing.
    await settleServe(deps, { bytes: 0, charges: [], linkId: link.id }, 0);
    expect((await linkById(link.id)).bytesServed).toBe(SIZE * 3 + 250);
  });
});

describe("the settle's once-guard", () => {
  it("in time: the first call settles through the request, every later call does nothing", () => {
    const inTime: Array<number | null> = [];
    const late: number[] = [];
    const end = settleOnce(
      60_000,
      (sent) => inTime.push(sent),
      (sent) => late.push(sent),
    );
    end(5);
    end(7);
    end(5);
    expect(inTime).toEqual([5]);
    expect(late).toEqual([]);
  });

  it("late: once the window is over, the first call settles in the background, every later call does nothing", async () => {
    const inTime: Array<number | null> = [];
    const late: number[] = [];
    const over = gate();
    const end = settleOnce(
      0,
      (sent) => {
        inTime.push(sent);
        if (sent === null) over.open();
      },
      (sent) => late.push(sent),
    );
    // The window closing is an event: "nothing came in time".
    await over.opened;
    end(3);
    end(4);
    end(3);
    expect(inTime).toEqual([null]);
    expect(late).toEqual([3]);
  });
});
