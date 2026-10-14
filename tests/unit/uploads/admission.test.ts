// The admission of an upload is ONE transaction: the day's ceilings, the open-session cap, the
// quota reservation and the session row. These tests run inits TOGETHER — real requests, each on
// its own connections — and hold the route to "fits alone, not together → exactly one".
import { describe, expect, it } from "vitest";
import { MAX_OPEN_UPLOADS } from "../../../src/shared/constants";
import { eq, sql } from "drizzle-orm";
import { nodes } from "../../../src/worker/db/schema";
import {
  backendPid,
  gate,
  makeFolder,
  makeShare,
  makeUpload,
  testDb,
  untilBlockedBy,
} from "../services-core/helpers";
import {
  call,
  initBody,
  ledgerOf,
  ROOMY,
  sessionsOf,
  uploader,
  usedBytes,
  type Answer,
  type TxFailure,
  type UserRow,
} from "./helpers";

const ROUNDS = 6;
const statuses = (answers: Answer[]) => answers.map((answer) => answer.status).sort();
const post = (caller: UserRow, json: unknown, options: Parameters<typeof call>[3] = {}) =>
  call(caller, "POST", "/uploads", { ...options, json });

describe("two inits that each fit alone but not together", () => {
  it("four inits at once under the owner's daily ceiling: what is admitted fits, and every refusal was right", async () => {
    const tight = { settings: { ...ROOMY, ceilings: { ...ROOMY.ceilings, CEIL_UPLOAD_BYTES_DAY: 1500 } } };
    const sizes = [700, 700, 100, 800];
    for (let round = 0; round < ROUNDS; round++) {
      // Quota no larger than the ceiling's base (so it does not scale it) and room for every
      // admitted file in it — only the ceiling refuses.
      const owner = await uploader({ quotaBytes: 1500 });
      const answers = await Promise.all(sizes.map((size) => post(owner, initBody({ size }), tight)));
      const rows = await sessionsOf(owner.id);
      const total = rows.reduce((sum, row) => sum + row.size, 0);
      expect(rows).toHaveLength(answers.filter((answer) => answer.status === 201).length);
      expect(total).toBeLessThanOrEqual(1500);
      expect(await usedBytes(owner.id)).toBe(total);
      for (const [index, answer] of answers.entries()) {
        if (answer.status === 201) continue;
        expect(answer.status).toBe(429);
        expect(answer.body).toMatchObject({ error: "ceiling_exceeded", details: { kind: "upload_user" } });
        // Totals only grow: a file refused at any moment still does not fit at the end.
        expect(total + sizes[index]!).toBeGreaterThan(1500);
      }
    }
  });

  it("exactly two files, 1000 bytes each, under a ceiling of 1500: one 201, one 429", async () => {
    const tight = { settings: { ...ROOMY, ceilings: { ...ROOMY.ceilings, CEIL_UPLOAD_BYTES_DAY: 1500 } } };
    for (let round = 0; round < ROUNDS; round++) {
      // Quota 1500 leaves the day's limit at its base of 1500. The ceiling is asked before the
      // quota, so the second file is refused by it (429), never by the reservation (413).
      const owner = await uploader({ quotaBytes: 1500 });
      const answers = await Promise.all([
        post(owner, initBody({ size: 1000 }), tight),
        post(owner, initBody({ size: 1000 }), tight),
      ]);
      expect(statuses(answers)).toEqual([201, 429]);
      const refused = answers.find((answer) => answer.status === 429)!;
      expect(refused.body).toMatchObject({ error: "ceiling_exceeded", details: { kind: "upload_user" } });
      expect(await sessionsOf(owner.id)).toHaveLength(1);
      expect(await usedBytes(owner.id)).toBe(1000);
    }
  });

  it("the editor's ceiling, across two different owners' trees: one 201, one 429, one session", async () => {
    const tight = {
      settings: { ...ROOMY, ceilings: { ...ROOMY.ceilings, CEIL_EDITOR_UPLOAD_BYTES_DAY: 1500 } },
    };
    for (let round = 0; round < ROUNDS; round++) {
      const editor = await uploader();
      const owners = [await uploader(), await uploader()];
      const folders = await Promise.all(owners.map((owner) => makeFolder(owner.id)));
      await Promise.all(
        folders.map((folder, i) =>
          makeShare(folder.id, owners[i]!.id, editor.id, { role: "editor", canUpload: true }),
        ),
      );
      const answers = await Promise.all(
        folders.map((folder) => post(editor, initBody({ parentId: folder.id, size: 1000 }), tight)),
      );
      expect(statuses(answers)).toEqual([201, 429]);
      const refused = answers.find((answer) => answer.status === 429)!;
      expect(refused.body.details).toEqual({ kind: "upload_editor", dimension: "bytes" });
      expect(await sessionsOf(editor.id)).toHaveLength(1);
      // The refused owner's storage was not touched.
      expect((await usedBytes(owners[0]!.id)) + (await usedBytes(owners[1]!.id))).toBe(1000);
    }
  });

  it(`with ${MAX_OPEN_UPLOADS - 1} sessions open, two inits: one admitted`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const user = await uploader();
      for (let i = 0; i < MAX_OPEN_UPLOADS - 1; i++) await makeUpload(user.id, user.id, { size: 1 });
      const answers = await Promise.all([post(user, initBody()), post(user, initBody())]);
      expect(statuses(answers)).toEqual([201, 429]);
      expect(answers.find((answer) => answer.status === 429)!.body.details).toEqual({ kind: "open_uploads" });
      expect(await sessionsOf(user.id)).toHaveLength(MAX_OPEN_UPLOADS);
      expect(await usedBytes(user.id)).toBe(1000);
    }
  });
});

describe("quota under concurrency", () => {
  it("20 inits at once never over-commit: exactly as many are admitted as fit", async () => {
    const user = await uploader({ quotaBytes: 10_500 });
    const answers = await Promise.all(Array.from({ length: 20 }, () => post(user, initBody({ size: 1000 }))));
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(10);
    const refused = answers.filter((answer) => answer.status !== 201);
    expect(refused).toHaveLength(10);
    for (const answer of refused) expect(answer.body.error).toBe("quota_exceeded");
    expect(await usedBytes(user.id)).toBe(10_000);
    expect(await sessionsOf(user.id)).toHaveLength(10);
    // Nothing is in a ledger before a complete.
    expect(await ledgerOf("upload_user", user.id)).toHaveLength(0);
  });

  it("an owner and two editors filling one tree at once: the owner's quota holds", async () => {
    const owner = await uploader({ quotaBytes: 5_000 });
    const editors = [await uploader(), await uploader()];
    const folder = await makeFolder(owner.id);
    for (const editor of editors) {
      await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    }
    const callers = [owner, ...editors];
    const answers = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        post(callers[i % 3]!, initBody({ parentId: folder.id, size: 1000 })),
      ),
    );
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(5);
    expect(await usedBytes(owner.id)).toBe(5_000);
    for (const editor of editors) expect(await usedBytes(editor.id)).toBe(0);
  });
});

describe("lock order", () => {
  it("two people uploading into each other's trees at once never deadlock — not even one that a retry would hide", async () => {
    const failures: TxFailure[] = [];
    let admitted = 0;
    for (let round = 0; round < 12; round++) {
      const a = await uploader();
      const b = await uploader();
      const [inA, inB] = [await makeFolder(a.id), await makeFolder(b.id)];
      await makeShare(inA.id, a.id, b.id, { role: "editor", canUpload: true });
      await makeShare(inB.id, b.id, a.id, { role: "editor", canUpload: true });
      // Each is owner in one transaction and editor in the other, started in both orders.
      const jobs = [
        () => post(a, initBody({ parentId: inB.id }), { failures }),
        () => post(b, initBody({ parentId: inA.id }), { failures }),
        () => post(a, initBody({ parentId: inA.id }), { failures }),
        () => post(b, initBody({ parentId: inB.id }), { failures }),
      ];
      if (round % 2) jobs.reverse();
      const answers = await Promise.all(jobs.map((job) => job()));
      expect(statuses(answers)).toEqual([201, 201, 201, 201]);
      admitted += answers.length;
    }
    expect(admitted).toBe(48);
    // Every transaction of every request was observed: none failed, for any reason.
    expect(failures).toEqual([]);
  });

  it("an init that Postgres ends as a deadlock victim is run again: the request is answered 201", async () => {
    const owner = await uploader();
    const folder = await makeFolder(owner.id);
    const failures: TxFailure[] = [];
    const holding = gate<number>();
    const goOn = gate();
    let otherFailed: unknown = null;
    // A writer in the opposite order: the folder's row first, then the owner's `user` row.
    const other = testDb()
      .transaction(async (tx) => {
        await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, folder.id)).for("update");
        holding.open(await backendPid(tx));
        await goOn.opened;
        await tx.execute(sql`SELECT 1 FROM "user" WHERE id = ${owner.id} FOR KEY SHARE`);
      })
      .catch((error: unknown) => {
        otherFailed = error;
      });
    const pid = await holding.opened;
    // The init takes the owner's row (the ceilings), then waits for the folder's.
    const initing = post(owner, initBody({ parentId: folder.id }), { failures });
    await untilBlockedBy(pid);
    goOn.open();
    const [answer] = await Promise.all([initing, other]);
    // One of the two was the victim. Whichever: the init is answered, and nothing is half-done.
    expect(answer.status).toBe(201);
    expect(otherFailed !== null || failures.some((failure) => failure.code === "40P01")).toBe(true);
    expect(failures.every((failure) => failure.code === "40P01")).toBe(true);
    expect(await sessionsOf(owner.id)).toHaveLength(1);
    expect(await usedBytes(owner.id)).toBe(1000);
  });
});
