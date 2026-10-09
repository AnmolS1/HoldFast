// Shared fixtures for the database tests (node project, real local Postgres).
//
// Postgres is NOT isolated between tests or files: every fixture uses random ids, and no test
// counts a whole table.

import { randomBytes } from "node:crypto";
import { type Db, createDb } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  type Node,
  nodes,
  type PauseReason,
  type ScanStatus,
  type ShareLink,
  shareLinks,
  shares,
  type Upload,
  uploads,
  user,
} from "../../../src/worker/db/schema";
import { nameKeyOf, extOf } from "../../../src/worker/services/filename";
import { localDbUrl } from "../../setup/local-env";

/** The `Env` the database layer reads under Node: one binding. */
export function testEnv(): Env {
  return { HYPERDRIVE: { connectionString: localDbUrl() } } as Env;
}

export function openDb(): { db: Db; close: () => Promise<void> } {
  return createDb(testEnv());
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A Better Auth-shaped id: 32 characters of [A-Za-z0-9]. */
export function baId(): string {
  let out = "";
  for (const byte of randomBytes(32)) out += ALNUM[byte % ALNUM.length];
  return out;
}

export const rand = (n = 6): string => randomBytes(n).toString("hex");

export async function makeUser(db: Db, overrides: Partial<typeof user.$inferInsert> = {}): Promise<string> {
  const id = overrides.id ?? baId();
  await db.insert(user).values({
    id,
    name: `Test ${id.slice(0, 6)}`,
    email: `${id.toLowerCase()}@example.test`,
    emailVerified: true,
    ...overrides,
  });
  return id;
}

export async function makeFolder(
  db: Db,
  ownerId: string,
  parentId: string | null,
  name: string,
  overrides: Partial<typeof nodes.$inferInsert> = {},
): Promise<Node> {
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      createdBy: ownerId,
      parentId,
      kind: "folder",
      name,
      nameKey: nameKeyOf(name),
      ext: "",
      scanStatus: "clean",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeFile(
  db: Db,
  ownerId: string,
  parentId: string | null,
  name: string,
  overrides: Partial<typeof nodes.$inferInsert> & { scanStatus?: ScanStatus } = {},
): Promise<Node> {
  const id = overrides.id ?? uuidv7();
  const versionId = overrides.versionId ?? rand(8);
  const [row] = await db
    .insert(nodes)
    .values({
      id,
      ownerId,
      createdBy: ownerId,
      parentId,
      kind: "file",
      name,
      nameKey: nameKeyOf(name),
      ext: extOf(name),
      size: 100,
      r2Key: `u/${ownerId}/${id}/${versionId}`,
      versionId,
      sha256: rand(32),
      scanStatus: "clean",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeLink(
  db: Db,
  nodeId: string,
  createdBy: string,
  overrides: Partial<typeof shareLinks.$inferInsert> & { pauseReasons?: PauseReason[] } = {},
): Promise<ShareLink> {
  const reasons = overrides.pauseReasons ?? [];
  const [row] = await db
    .insert(shareLinks)
    .values({
      nodeId,
      createdBy,
      tokenHash: rand(32),
      tokenEnc: randomBytes(48),
      tokenIv: randomBytes(12),
      pausedAt: reasons.length > 0 ? new Date() : null,
      ...overrides,
      pauseReasons: reasons,
    })
    .returning();
  return row!;
}

export async function makeShare(
  db: Db,
  nodeId: string,
  grantedBy: string,
  grantee: { userId: string } | { email: string },
  overrides: Partial<typeof shares.$inferInsert> = {},
) {
  const active = "userId" in grantee;
  const [row] = await db
    .insert(shares)
    .values({
      nodeId,
      grantedBy,
      granteeEmail: active ? `${grantee.userId.toLowerCase()}@example.test` : grantee.email,
      granteeUserId: active ? grantee.userId : null,
      activatedAt: active ? new Date() : null,
      role: "viewer",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeUpload(
  db: Db,
  ownerId: string,
  uploaderId: string,
  overrides: Partial<typeof uploads.$inferInsert> = {},
): Promise<Upload> {
  const nodeId = overrides.nodeId ?? uuidv7();
  const versionId = overrides.versionId ?? rand(8);
  const name = overrides.name ?? `upload-${rand(4)}.bin`;
  const [row] = await db
    .insert(uploads)
    .values({
      ownerId,
      uploaderId,
      parentId: null,
      nodeId,
      versionId,
      name,
      nameKey: nameKeyOf(name),
      size: 1000,
      r2Key: `u/${ownerId}/${nodeId}/${versionId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    })
    .returning();
  return row!;
}

/** Awaits a promise that must reject and returns the error. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
