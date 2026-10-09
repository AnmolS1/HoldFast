// The schema itself: id families, ON DELETE behaviour for every reference to `user`, the unique
// name rule, and the CHECK constraints.

import { eq, inArray, sql } from "drizzle-orm";
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as authSchema from "../../../src/worker/db/auth-schema";
import type { Db } from "../../../src/worker/db/client";
import { pgError } from "../../../src/worker/db/errors";
import { isUuid, uuidv7 } from "../../../src/worker/db/ids";
import * as schema from "../../../src/worker/db/schema";
import {
  baId,
  makeFile,
  makeFolder,
  makeLink,
  makeShare,
  makeUpload,
  makeUser,
  openDb,
  rand,
  rejection,
} from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const tables = Object.entries(schema as Record<string, unknown>).filter(
  (entry): entry is [string, PgTable] => entry[1] instanceof PgTable,
);
const authTableNames = new Set(
  Object.values(authSchema as Record<string, unknown>)
    .filter((v): v is PgTable => v instanceof PgTable)
    .map((t) => getTableConfig(t).name),
);

/** Unnamed columns carry their property name until the `snake_case` casing is applied. */
const snake = (name: string) => name.replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase());

/** `table.column` → the ON DELETE action, for every FK to `user.id`. */
function userReferences(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, table] of tables) {
    const config = getTableConfig(table);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (getTableConfig(ref.foreignTable).name !== "user") continue;
      out[`${config.name}.${snake(ref.columns[0]!.name)}`] = fk.onDelete ?? "no action";
    }
  }
  return out;
}

describe("id families", () => {
  it("uuidv7() makes lower-case version-7 UUIDs that sort by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(a.slice(0, 13)).toBe("018bcfe5-6800");
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
    expect(isUuid(a)).toBe(true);
    expect(isUuid(baId())).toBe(false);
  });

  it("user.id and session.id are text with no generator of ours", () => {
    for (const column of [authSchema.user.id, authSchema.session.id]) {
      expect(column.getSQLType()).toBe("text");
      expect(column.dataType).toBe("string");
      expect(column.hasDefault).toBe(false);
      expect(column.defaultFn).toBeUndefined();
    }
  });

  it("every column that references user.id or session.id is text, not uuid", () => {
    let checked = 0;
    for (const [, table] of tables) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const ref = fk.reference();
        const target = `${getTableConfig(ref.foreignTable).name}.${ref.foreignColumns[0]!.name}`;
        if (target !== "user.id" && target !== "session.id") continue;
        for (const column of ref.columns) {
          expect(column.getSQLType(), `${getTableConfig(table).name}.${column.name}`).toBe("text");
          expect(column.dataType).toBe("string");
          checked++;
        }
      }
    }
    // 22 references from our tables plus Better Auth's own four; nothing references session.id.
    expect(checked).toBe(26);
  });

  it("the FK-less columns that hold a user id, and the polymorphic id columns, are text", () => {
    const columns: PgColumn[] = [
      schema.auditLog.actorUserId,
      schema.uploadIps.uploaderId,
      schema.pendingUserPurges.userId,
      schema.user.invitedBy,
      schema.auditLog.targetId,
      schema.downloadLedger.subjectId,
    ];
    for (const column of columns) {
      expect(column.getSQLType(), column.name).toBe("text");
      expect(column.dataType).toBe("string");
    }
    for (const table of [schema.auditLog, schema.uploadIps, schema.pendingUserPurges]) {
      expect(getTableConfig(table).foreignKeys).toHaveLength(0);
    }
  });

  it("our own ids are uuid columns with the v7 generator", () => {
    for (const table of [
      schema.nodes,
      schema.uploads,
      schema.shares,
      schema.shareLinks,
      schema.reports,
      schema.auditLog,
    ]) {
      expect(table.id.getSQLType()).toBe("uuid");
      expect(isUuid(table.id.defaultFn!())).toBe(true);
    }
  });
});

describe("timestamps", () => {
  it("every timestamp of our own tables is timestamptz; Better Auth's are zone-less", () => {
    let ours = 0;
    let theirs = 0;
    for (const [, table] of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const type = column.getSQLType();
        if (!type.startsWith("timestamp")) continue;
        if (authTableNames.has(config.name)) {
          expect(type, `${config.name}.${column.name}`).toBe("timestamp");
          theirs++;
        } else {
          expect(type, `${config.name}.${column.name}`).toBe("timestamp with time zone");
          ours++;
        }
      }
    }
    expect(ours).toBeGreaterThan(50);
    expect(theirs).toBeGreaterThanOrEqual(15);
  });

  it("quota and usage are 64-bit columns", () => {
    expect(authSchema.user.quotaBytes.getSQLType()).toBe("bigint");
    expect(authSchema.user.usedBytes.getSQLType()).toBe("bigint");
  });
});

describe("ON DELETE for every reference to user", () => {
  it("the declared actions are exactly the tabled ones", () => {
    expect(userReferences()).toEqual({
      // RESTRICT — the user-purge job must clean up first.
      "nodes.owner_id": "restrict",
      "uploads.owner_id": "restrict",
      "uploads.uploader_id": "restrict",
      // SET NULL — authorship is anonymised.
      "nodes.created_by": "set null",
      "nodes.trashed_by": "set null",
      "nodes.takedown_by": "set null",
      "node_versions.created_by": "set null",
      "shares.granted_by": "set null",
      "hash_blocklist.added_by": "set null",
      "invites.created_by": "set null",
      "reports.owner_id": "set null",
      "reports.reporter_user_id": "set null",
      "reports.assigned_to": "set null",
      "dmca_notices.handled_by": "set null",
      "dmca_notices.restored_by": "set null",
      "strikes.issued_by": "set null",
      "strikes.lifted_by": "set null",
      "settings.updated_by": "set null",
      // CASCADE — the row is only about that user.
      "shares.grantee_user_id": "cascade",
      "share_links.created_by": "cascade",
      "strikes.user_id": "cascade",
      "user_prefs.user_id": "cascade",
      "session.user_id": "cascade",
      "account.user_id": "cascade",
      "passkey.user_id": "cascade",
      "two_factor.user_id": "cascade",
    });
  });

  it("deleting a user nulls authorship, cascades the user's own rows, and keeps FK-less rows", async () => {
    const owner = await makeUser(db);
    const gone = await makeUser(db);

    // SET NULL targets, all on rows that belong to `owner`.
    const folder = await makeFolder(db, owner, null, `shared-${rand()}`);
    const file = await makeFile(db, owner, folder.id, "by-editor.txt", {
      createdBy: gone,
      trashedBy: gone,
      takedownBy: gone,
    });
    await db.insert(schema.nodeVersions).values({
      nodeId: file.id,
      versionId: "v0",
      r2Key: `u/${owner}/${file.id}/v0`,
      size: 1,
      createdBy: gone,
      purgeAfter: new Date(),
    });
    const granted = await makeShare(db, folder.id, gone, { email: `pending-${rand()}@example.test` });
    const sha = rand(32);
    await db.insert(schema.hashBlocklist).values({ sha256: sha, reason: "malware", addedBy: gone });
    const code = `inv-${rand()}`;
    await db.insert(schema.invites).values({ code, createdBy: gone });
    const [report] = await db
      .insert(schema.reports)
      .values({
        nodeId: file.id,
        ownerId: gone,
        reporterUserId: gone,
        assignedTo: gone,
        category: "spam",
        source: "user",
      })
      .returning();
    const [notice] = await db
      .insert(schema.dmcaNotices)
      .values({ receivedVia: "email", handledBy: gone, restoredBy: gone })
      .returning();
    const [strikeOnOwner] = await db
      .insert(schema.strikes)
      .values({ userId: owner, kind: "abuse", issuedBy: gone, liftedBy: gone })
      .returning();
    const settingKey = `test-${rand()}`;
    await db.insert(schema.settings).values({ key: settingKey, value: true, updatedBy: gone });

    // CASCADE targets.
    const activeShare = await makeShare(db, folder.id, owner, { userId: gone });
    const ownFolder = await makeFolder(db, owner, null, `linked-${rand()}`);
    const link = await makeLink(db, ownFolder.id, gone);
    const [strikeOnGone] = await db
      .insert(schema.strikes)
      .values({ userId: gone, kind: "abuse" })
      .returning();
    await db.insert(schema.userPrefs).values({ userId: gone });
    const sessionId = baId();
    await db.insert(schema.session).values({
      id: sessionId,
      userId: gone,
      token: rand(16),
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    });
    await db
      .insert(schema.account)
      .values({ id: baId(), userId: gone, accountId: gone, providerId: "credential", updatedAt: new Date() });
    await db.insert(schema.passkey).values({
      id: baId(),
      userId: gone,
      publicKey: "pk",
      credentialID: rand(),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    await db.insert(schema.twoFactor).values({ id: baId(), userId: gone, secret: "s", backupCodes: "b" });

    // FK-less rows that must outlive the account.
    const [audit] = await db
      .insert(schema.auditLog)
      .values({ actorUserId: gone, actorType: "user", action: "test" })
      .returning();
    const [ip] = await db
      .insert(schema.uploadIps)
      .values({
        nodeId: file.id,
        versionId: "v1",
        uploaderId: gone,
        ipEncrypted: Buffer.from("x"),
        iv: Buffer.from("y"),
        keyVersion: 1,
      })
      .returning();
    await db.insert(schema.pendingUserPurges).values({ userId: gone, scheduledFor: new Date() });
    const invited = await makeUser(db, { invitedBy: gone });

    await db.delete(schema.user).where(eq(schema.user.id, gone));

    const [fileAfter] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, file.id));
    expect(fileAfter).toMatchObject({ ownerId: owner, createdBy: null, trashedBy: null, takedownBy: null });
    const [version] = await db
      .select()
      .from(schema.nodeVersions)
      .where(eq(schema.nodeVersions.nodeId, file.id));
    expect(version!.createdBy).toBeNull();
    const [grantedAfter] = await db.select().from(schema.shares).where(eq(schema.shares.id, granted.id));
    expect(grantedAfter!.grantedBy).toBeNull();
    const [blocked] = await db
      .select()
      .from(schema.hashBlocklist)
      .where(eq(schema.hashBlocklist.sha256, sha));
    expect(blocked!.addedBy).toBeNull();
    const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.code, code));
    expect(invite!.createdBy).toBeNull();
    const [reportAfter] = await db.select().from(schema.reports).where(eq(schema.reports.id, report!.id));
    expect(reportAfter).toMatchObject({
      ownerId: null,
      reporterUserId: null,
      assignedTo: null,
      nodeId: file.id,
    });
    const [noticeAfter] = await db
      .select()
      .from(schema.dmcaNotices)
      .where(eq(schema.dmcaNotices.id, notice!.id));
    expect(noticeAfter).toMatchObject({ handledBy: null, restoredBy: null });
    const [strikeAfter] = await db
      .select()
      .from(schema.strikes)
      .where(eq(schema.strikes.id, strikeOnOwner!.id));
    expect(strikeAfter).toMatchObject({ userId: owner, issuedBy: null, liftedBy: null });
    const [setting] = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey));
    expect(setting!.updatedBy).toBeNull();
    await db.delete(schema.settings).where(eq(schema.settings.key, settingKey));

    expect(await db.select().from(schema.shares).where(eq(schema.shares.id, activeShare.id))).toHaveLength(0);
    expect(await db.select().from(schema.shareLinks).where(eq(schema.shareLinks.id, link.id))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(schema.strikes).where(eq(schema.strikes.id, strikeOnGone!.id)),
    ).toHaveLength(0);
    expect(await db.select().from(schema.userPrefs).where(eq(schema.userPrefs.userId, gone))).toHaveLength(0);
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, gone))).toHaveLength(0);
    expect(await db.select().from(schema.account).where(eq(schema.account.userId, gone))).toHaveLength(0);
    expect(await db.select().from(schema.passkey).where(eq(schema.passkey.userId, gone))).toHaveLength(0);
    expect(await db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, gone))).toHaveLength(0);

    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.id, audit!.id))).toHaveLength(1);
    expect(await db.select().from(schema.uploadIps).where(eq(schema.uploadIps.id, ip!.id))).toHaveLength(1);
    expect(
      await db.select().from(schema.pendingUserPurges).where(eq(schema.pendingUserPurges.userId, gone)),
    ).toHaveLength(1);
    const [invitedAfter] = await db.select().from(schema.user).where(eq(schema.user.id, invited));
    expect(invitedAfter!.invitedBy).toBe(gone);
    // The owner's folder is untouched: nothing cascades into another owner's tree.
    expect(
      await db
        .select()
        .from(schema.nodes)
        .where(inArray(schema.nodes.id, [folder.id, ownFolder.id])),
    ).toHaveLength(2);
  });

  it("a user who still owns nodes or has upload sessions cannot be deleted (RESTRICT)", async () => {
    const cases: [string, (userId: string, other: string) => Promise<unknown>][] = [
      ["nodes_owner_id_user_id_fk", (userId) => makeFolder(db, userId, null, "mine")],
      ["uploads_owner_id_user_id_fk", (userId, other) => makeUpload(db, userId, other)],
      ["uploads_uploader_id_user_id_fk", (userId, other) => makeUpload(db, other, userId)],
    ];
    for (const [constraint, arrange] of cases) {
      const userId = await makeUser(db);
      const other = await makeUser(db);
      await arrange(userId, other);
      const error = await rejection(db.delete(schema.user).where(eq(schema.user.id, userId)));
      expect(pgError(error), constraint).toMatchObject({ code: "23503", constraint });
      expect(await db.select().from(schema.user).where(eq(schema.user.id, userId))).toHaveLength(1);
    }
  });
});

describe("the tree's own references", () => {
  it("a parent cannot be deleted alone, but a whole subtree goes in one statement", async () => {
    const owner = await makeUser(db);
    const top = await makeFolder(db, owner, null, `top-${rand()}`);
    const mid = await makeFolder(db, owner, top.id, "mid");
    const leaf = await makeFile(db, owner, mid.id, "leaf.txt");
    const error = await rejection(db.delete(schema.nodes).where(eq(schema.nodes.id, top.id)));
    expect(pgError(error)).toMatchObject({ code: "23503" });
    await db.delete(schema.nodes).where(inArray(schema.nodes.id, [top.id, mid.id, leaf.id]));
    expect(
      await db
        .select()
        .from(schema.nodes)
        .where(inArray(schema.nodes.id, [top.id, mid.id, leaf.id])),
    ).toHaveLength(0);
  });
});

describe("one live name per folder", () => {
  it("refuses two root-level folders with the same name", async () => {
    const owner = await makeUser(db);
    await makeFolder(db, owner, null, "Photos");
    const error = await rejection(makeFolder(db, owner, null, "photos"));
    expect(pgError(error)).toMatchObject({ code: "23505", constraint: "nodes_live_name_root_uq" });
  });

  it("refuses two children with the same name, whatever their kind", async () => {
    const owner = await makeUser(db);
    const parent = await makeFolder(db, owner, null, `p-${rand()}`);
    await makeFile(db, owner, parent.id, "Report.pdf");
    const error = await rejection(makeFolder(db, owner, parent.id, "report.pdf"));
    expect(pgError(error)).toMatchObject({ code: "23505", constraint: "nodes_live_name_child_uq" });
  });

  it("allows the same name in another folder, for another owner, and next to a trashed one", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const a = await makeFolder(db, owner, null, "A");
    const b = await makeFolder(db, owner, null, "B");
    await makeFile(db, owner, a.id, "same.txt");
    await makeFile(db, owner, b.id, "same.txt");
    await makeFolder(db, other, null, "A");
    // A trashed same-name node does not block: at the root and in a folder.
    await makeFolder(db, owner, null, "Old", { deletedAt: new Date(), trashedRoot: true });
    await makeFolder(db, owner, null, "Old");
    await makeFile(db, owner, a.id, "old.txt", { deletedAt: new Date(), trashedRoot: true });
    await makeFile(db, owner, a.id, "old.txt");
    // System nodes are outside the rule.
    await makeFile(db, owner, null, "avatar", { system: "avatar" });
    await makeFile(db, owner, null, "avatar", { system: "avatar" });
  });
});

describe("CHECK constraints", () => {
  it("share_links rejects an unknown pause reason", async () => {
    const owner = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `f-${rand()}`);
    const error = await rejection(
      makeLink(db, folder.id, owner, { pauseReasons: ["because" as never], pausedAt: new Date() }),
    );
    expect(pgError(error)).toMatchObject({ code: "23514", constraint: "share_links_pause_reasons_known" });
  });

  it("share_links rejects pausedAt without a reason, and a reason without pausedAt", async () => {
    const owner = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `f-${rand()}`);
    const link = await makeLink(db, folder.id, owner);
    const withoutReason = await rejection(
      db.update(schema.shareLinks).set({ pausedAt: new Date() }).where(eq(schema.shareLinks.id, link.id)),
    );
    expect(pgError(withoutReason)).toMatchObject({
      code: "23514",
      constraint: "share_links_paused_at_matches",
    });
    const withoutTime = await rejection(
      db
        .update(schema.shareLinks)
        .set({ pauseReasons: sql`ARRAY['owner']::text[]` })
        .where(eq(schema.shareLinks.id, link.id)),
    );
    expect(pgError(withoutTime)).toMatchObject({
      code: "23514",
      constraint: "share_links_paused_at_matches",
    });
    // Both together are fine.
    await db
      .update(schema.shareLinks)
      .set({ pauseReasons: ["owner"], pausedAt: new Date() })
      .where(eq(schema.shareLinks.id, link.id));
  });

  it("nodes rejects an unknown scan reason and accepts the six known ones", async () => {
    const owner = await makeUser(db);
    const error = await rejection(
      makeFile(db, owner, null, `x-${rand()}.bin`, { scanReason: "mood" as never }),
    );
    expect(pgError(error)).toMatchObject({ code: "23514", constraint: "nodes_scan_reason_known" });
    for (const reason of schema.SCAN_REASONS) {
      await makeFile(db, owner, null, `${reason}-${rand()}.bin`, {
        scanStatus: "skipped",
        scanReason: reason,
      });
    }
  });

  it("emails are case-insensitive (citext)", async () => {
    const owner = await makeUser(db);
    const folder = await makeFolder(db, owner, null, `f-${rand()}`);
    const address = `Mixed.Case-${rand()}@Example.Test`;
    await makeShare(db, folder.id, owner, { email: address });
    const error = await rejection(makeShare(db, folder.id, owner, { email: address.toLowerCase() }));
    expect(pgError(error)).toMatchObject({ code: "23505", constraint: "shares_node_email_uq" });
  });
});
