// The rows scripts/create-session.ts writes — a verified user it made itself (the marker rule) and
// a session for it, with the cookie signed by the library's own serializer — as a module of its
// own, free of node-only imports, so that a Workers test can seed a session exactly as the script
// does and send it to the real Worker (tests/unit/security/create-session-admin.test.ts).

import { generateId } from "@better-auth/core/utils/id";
import { hashPassword } from "better-auth/crypto";
import { serializeSignedCookie } from "better-call";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/worker/db/client";
import { account, session, settings, user, userPrefs, verification } from "../../src/worker/db/schema";

/** The default of the `TERMS_VERSION` var; the `settings` row, when there is one, wins. */
const DEFAULT_TERMS_VERSION = "2026-10";

const markerOf = (userId: string) => `create-session:${userId}`;

/** Did this script make that user? */
async function isOurs(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: verification.id })
    .from(verification)
    .where(eq(verification.identifier, markerOf(userId)));
  return rows.length > 0;
}
const NOT_OURS =
  "refusing: a user with that address exists and was NOT made by this script — it is not reused, changed or deleted";

async function currentTermsVersion(db: Db): Promise<string> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "termsVersion"));
  return typeof row?.value === "string" && row.value !== "" ? row.value : DEFAULT_TERMS_VERSION;
}

export async function removeSeededUser(db: Db, email: string): Promise<boolean> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) return false;
  if (!(await isOurs(db, row.id))) throw new Error(NOT_OURS);
  await db.delete(verification).where(eq(verification.identifier, markerOf(row.id)));
  // Sessions, accounts and preferences go with the user (ON DELETE CASCADE); a user that owns
  // files is not a seeded test user and is left alone by the foreign keys.
  await db.delete(session).where(eq(session.userId, row.id));
  await db.delete(account).where(eq(account.userId, row.id));
  await db.delete(user).where(eq(user.id, row.id));
  return true;
}

async function ensureUser(
  db: Db,
  email: string,
  options: { admin: boolean; twoFactor: boolean },
): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const termsVersion = await currentTermsVersion(db);
  const wanted = {
    emailVerified: true,
    role: options.admin ? "admin" : "user",
    twoFactorEnabled: options.twoFactor,
    termsVersion,
    termsAcceptedAt: now,
    ageVerifiedAt: now,
    banned: false,
    suspendedAt: null,
    deleteScheduledAt: null,
  };
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) {
    if (!(await isOurs(db, existing.id))) throw new Error(NOT_OURS);
    await db.update(user).set(wanted).where(eq(user.id, existing.id));
    return { id: existing.id, created: false };
  }
  const id = generateId();
  await db.insert(user).values({ id, name: "Remote Spec", email, ...wanted });
  // A credential account, as a signed-up user has — with a password nobody knows.
  await db.insert(account).values({
    id: generateId(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(generateId(48)),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userPrefs).values({ userId: id }).onConflictDoNothing();
  // The marker: this row is the script's (it never expires in practice, and names no secret).
  await db.insert(verification).values({
    id: generateId(),
    identifier: markerOf(id),
    value: "1",
    expiresAt: new Date(now.getTime() + 10 * 365 * 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  return { id, created: true };
}

export type SeedOptions = {
  email: string;
  admin: boolean;
  /**
   * Two-factor on the ACCOUNT, and a second factor passed by THIS session now (`secondFactorAt`):
   * what an admin who signed in with a code has — without it every /api/admin/* route answers
   * `admin_requires_2fa` (middleware/guards.ts requireAdmin).
   */
  twoFactor: boolean;
  ttlHours: number;
  secret: string;
  /** https: the cookie is `__Host-hf.session_token`; plain http: `hf.session_token`. */
  secure: boolean;
};

/** The user (made, or reused when it is ours) and a new session; the signed cookie of that session. */
export async function seedSession(
  db: Db,
  options: SeedOptions,
): Promise<{ id: string; created: boolean; cookie: { name: string; value: string; expiresAt: Date } }> {
  const owner = await ensureUser(db, options.email, { admin: options.admin, twoFactor: options.twoFactor });
  const token = generateId(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + options.ttlHours * 3_600_000);
  await db.insert(session).values({
    id: generateId(),
    token,
    userId: owner.id,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    userAgent: "scripts/create-session.ts",
    secondFactorAt: options.twoFactor ? now : null,
  });
  const name = `${options.secure ? "__Host-" : ""}hf.session_token`;
  // The library's own signer: `<token>.<signature>`, exactly as its Set-Cookie carries it.
  const serialized = await serializeSignedCookie(name, token, options.secret, {});
  return { ...owner, cookie: { name, value: serialized.slice(name.length + 1), expiresAt } };
}
