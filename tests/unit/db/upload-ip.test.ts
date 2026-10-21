// The uploader's sealed address on an upload session (ruling 2026-10-21, T22 (0c)): a session
// that is `completing` can be finished later by the repair sweep, which has no request address,
// so init seals the address on the session — `ip_encrypted` / `ip_iv` / `ip_key_version`, the
// same three parts as an `upload_ips` row. It is kept no longer than the session is unfinished:
// EVERY move to `done` or `aborted` clears it, through the one `ended()` fragment, and a session
// deleted takes it with it. A session that is still `open` or `completing` keeps it.
// (The sealed values here are made-up bytes, not a sealed address.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { abortOpen } from "../../../src/worker/db/queries/upload-sessions";
import { deleteSubtreeRows } from "../../../src/worker/db/queries/trash";
import {
  claimCompleting,
  deleteForUser,
  ended,
  markAborted,
  markDone,
  sealedIpOf,
  trimFinished,
} from "../../../src/worker/db/queries/uploads";
import { type Upload, uploads, user } from "../../../src/worker/db/schema";
import { stripComments } from "./_sql-rule-scan";
import { makeFolder, makeUpload, makeUser, openDb, useTrimLock } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

// Made-up bytes standing in for a sealed value (never a real address).
const SEALED = {
  ipEncrypted: new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  ipIv: new Uint8Array(12).fill(7),
  ipKeyVersion: 1,
};
const NONE = { ipEncrypted: null, ipIv: null, ipKeyVersion: null };

const row = async (id: string): Promise<Upload | null> =>
  (await db.select().from(uploads).where(eq(uploads.id, id)))[0] ?? null;
// The driver hands bytea back as a Buffer: compared as plain arrays.
const plain = (bytes: Uint8Array | null) => (bytes === null ? null : Array.from(bytes));
const ipOf = async (id: string) => {
  const r = await row(id);
  return r && { ipEncrypted: plain(r.ipEncrypted), ipIv: plain(r.ipIv), ipKeyVersion: r.ipKeyVersion };
};
const KEPT = {
  ipEncrypted: Array.from(SEALED.ipEncrypted),
  ipIv: Array.from(SEALED.ipIv),
  ipKeyVersion: SEALED.ipKeyVersion,
};
const sealedSession = async (
  ownerId: string,
  uploaderId: string,
  extra: Partial<typeof uploads.$inferInsert> = {},
) => makeUpload(db, ownerId, uploaderId, { ...SEALED, ...extra });

describe("the columns (migration 0008, expand-only)", () => {
  it("are nullable, have no default and have exactly the types of upload_ips' sealed address", async () => {
    const columns = await db.execute<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`SELECT table_name, column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND ((table_name = 'uploads' AND column_name IN ('ip_encrypted', 'ip_iv', 'ip_key_version'))
                OR (table_name = 'upload_ips' AND column_name IN ('ip_encrypted', 'iv', 'key_version')))`);
    const of = (table: string, column: string) =>
      columns.rows.find((c) => c.table_name === table && c.column_name === column);
    for (const [mine, theirs] of [
      ["ip_encrypted", "ip_encrypted"],
      ["ip_iv", "iv"],
      ["ip_key_version", "key_version"],
    ] as const) {
      expect(of("uploads", mine), mine).toMatchObject({ is_nullable: "YES", column_default: null });
      expect(of("uploads", mine)!.data_type, mine).toBe(of("upload_ips", theirs)!.data_type);
    }
    expect(of("uploads", "ip_encrypted")!.data_type).toBe("bytea");
    expect(of("uploads", "ip_key_version")!.data_type).toBe("smallint");
  });

  it("a session written without them (as before the column) reads all three as null", async () => {
    const owner = await makeUser(db);
    const session = await makeUpload(db, owner, owner);
    expect(await ipOf(session.id)).toEqual(NONE);
    expect(sealedIpOf(session)).toBeNull();
  });
});

describe("sealedIpOf — the read the repair sweep (T22) uses", () => {
  it("returns the three parts as openIp / uploadIps.record take them, or null", async () => {
    const owner = await makeUser(db);
    const session = (await row((await sealedSession(owner, owner)).id))!;
    const sealed = sealedIpOf(session)!;
    expect(Array.from(sealed.ciphertext)).toEqual(Array.from(SEALED.ipEncrypted));
    expect(Array.from(sealed.iv)).toEqual(Array.from(SEALED.ipIv));
    expect(sealed.keyVersion).toBe(1);
    // A partial triple is never handed on as a sealed value.
    expect(sealedIpOf({ ...session, ipIv: null })).toBeNull();
    expect(sealedIpOf({ ...session, ipKeyVersion: null })).toBeNull();
    expect(sealedIpOf({ ...session, ipEncrypted: null })).toBeNull();
  });
});

describe("every terminal transition clears it", () => {
  it("markDone — an open and a completing session", async () => {
    const owner = await makeUser(db);
    for (const status of ["open", "completing"] as const) {
      const session = await sealedSession(owner, owner, { status });
      expect(await markDone(db, session.id)).toBe(true);
      expect(await row(session.id), status).toMatchObject({ status: "done", ...NONE });
    }
  });

  it("markAborted — an open and a completing session", async () => {
    const owner = await makeUser(db);
    for (const status of ["open", "completing"] as const) {
      const session = await sealedSession(owner, owner, { status });
      expect(await markAborted(db, session.id)).toBe(true);
      expect(await row(session.id), status).toMatchObject({ status: "aborted", ...NONE });
    }
  });

  it("abortOpen (DELETE /uploads/:id)", async () => {
    const owner = await makeUser(db);
    const session = await sealedSession(owner, owner);
    expect(await abortOpen(db, session.id, owner)).toBe(true);
    expect(await row(session.id)).toMatchObject({ status: "aborted", ...NONE });
  });

  describe("(under the trim lock)", () => {
    useTrimLock();
    it("EXCEPTION (ruling 2026-10-21, legal-hold preservation — T29 :119): a session deleteSubtreeRows keeps BECAUSE of a hold is ended as aborted with its address KEPT; trimFinished deletes the row, address and all, once the hold is lifted", async () => {
      const owner = await makeUser(db);
      const heldEditor = await makeUser(db, { legalHold: true });
      const folder = await makeFolder(db, owner, null, "purged");
      const kept = await sealedSession(owner, heldEditor, { parentId: folder.id, size: 300 });
      await deleteSubtreeRows(db, folder.id);
      expect(await row(kept.id)).toMatchObject({ status: "aborted", parentId: null });
      expect(await ipOf(kept.id)).toEqual(KEPT);

      // Past the trim age but still held: preserved as it is.
      await db
        .update(uploads)
        .set({ completedAt: new Date(Date.now() - 30 * 86_400_000) })
        .where(eq(uploads.id, kept.id));
      await trimFinished(db, 7, 100_000);
      expect(await ipOf(kept.id)).toEqual(KEPT);
      // The hold lifted: the retention job's trim deletes the row — the address goes with it.
      await db.update(user).set({ legalHold: false }).where(eq(user.id, heldEditor));
      await trimFinished(db, 7, 100_000);
      expect(await row(kept.id)).toBeNull();
    });
  });

  describe("(under the trim lock)", () => {
    useTrimLock();
    it("the rows that are deleted take it with them: trimFinished, deleteForUser, deleteSubtreeRows", async () => {
      const owner = await makeUser(db);
      // trimFinished — a finished session past the trim age. (Cleared at its end already; this is
      // a row written before that rule, which the trim still removes whole.)
      const old = await sealedSession(owner, owner, {
        status: "aborted",
        completedAt: new Date(Date.now() - 30 * 86_400_000),
      });
      await trimFinished(db, 7, 100_000);
      expect(await row(old.id)).toBeNull();

      const leaving = await makeUser(db);
      const open = await sealedSession(leaving, leaving);
      await deleteForUser(db, leaving);
      expect(await row(open.id)).toBeNull();

      const folder = await makeFolder(db, owner, null, "gone");
      const free = await sealedSession(owner, owner, { parentId: folder.id });
      await deleteSubtreeRows(db, folder.id);
      expect(await row(free.id)).toBeNull();
    });
  });
});

describe("an unfinished session keeps it — the repair sweep reads it from there", () => {
  it("claimCompleting: open → completing keeps it", async () => {
    const owner = await makeUser(db);
    const session = await sealedSession(owner, owner);
    expect(await claimCompleting(db, session.id, owner)).not.toBeNull();
    expect(await row(session.id)).toMatchObject({ status: "completing" });
    expect(await ipOf(session.id)).toEqual(KEPT);
  });

  it("deleteForUser keeps a completing session — and its address", async () => {
    const leaving = await makeUser(db);
    const completing = await sealedSession(leaving, leaving, { status: "completing" });
    await deleteForUser(db, leaving);
    expect(await row(completing.id)).toMatchObject({ status: "completing" });
    expect(await ipOf(completing.id)).toEqual(KEPT);
  });

  it("deleteSubtreeRows keeps a completing session detached and still completing — and its address", async () => {
    const owner = await makeUser(db);
    const folder = await makeFolder(db, owner, null, "purged-while-hashing");
    const completing = await sealedSession(owner, owner, { parentId: folder.id, status: "completing" });
    await deleteSubtreeRows(db, folder.id);
    expect(await row(completing.id)).toMatchObject({ status: "completing", parentId: null });
    expect(await ipOf(completing.id)).toEqual(KEPT);
  });

  it("a terminal helper that finds the session already finished writes nothing", async () => {
    const owner = await makeUser(db);
    // Written finished with the address still on it: a no-op transition must not be what clears it.
    const finished = await sealedSession(owner, owner, { status: "done" });
    expect(await markDone(db, finished.id)).toBe(false);
    expect(await markAborted(db, finished.id)).toBe(false);
    expect(await row(finished.id)).toMatchObject({ status: "done" });
    expect(await ipOf(finished.id)).toEqual(KEPT);
  });
});

describe("ended()", () => {
  it("is the status, its time and the address cleared — nothing else", () => {
    for (const status of ["done", "aborted"] as const) {
      const set = ended(status);
      expect(Object.keys(set).sort()).toEqual(
        ["completedAt", "ipEncrypted", "ipIv", "ipKeyVersion", "status"].sort(),
      );
      expect(set).toMatchObject({ status, ...NONE });
    }
  });

  it("is the only way a session is written done or aborted — but for the one hold-preservation exception: a scan of every worker source file", () => {
    const root = fileURLToPath(new URL("../../../src/worker/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const offenders: string[] = [];
    let updates = 0;
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      // Raw SQL that writes the table directly.
      if (/\b(UPDATE|INSERT\s+INTO)\s+"?uploads"?\s/i.test(source)) offenders.push(`${file}: raw SQL`);
      // Every Drizzle update of the table: the `.set(…)` up to its `.where(` / `.returning(`.
      for (const m of source.matchAll(/\.update\(uploads\)\s*\.set\(([\s\S]*?)\)\s*\.(where|returning)\(/g)) {
        updates += 1;
        const set = m[1]!.trim();
        if (/["'](done|aborted)["']/.test(set) && !/^ended\(["'](done|aborted)["']\)$/.test(set))
          offenders.push(`${file}: .set(${set})`);
      }
    }
    // The scan saw the updates it is about (claim, the three terminal helpers, the trash purge…).
    expect(updates).toBeGreaterThanOrEqual(6);
    // Exactly ONE named exception (ruling 2026-10-21): deleteSubtreeRows ends the sessions a legal
    // hold keeps without clearing the address — preservation keeps a held user's rows as they are.
    // A second exception, or this one moved, is red.
    expect(offenders.map((o) => o.slice(root.length))).toEqual([
      'db/queries/trash.ts: .set({ status: "aborted", completedAt: sql`now()` })',
    ]);
  });
});
