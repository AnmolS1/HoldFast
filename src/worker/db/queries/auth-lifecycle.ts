// Queries only the auth task makes: the sign-up reservation (velocity counters, invite use,
// single-use intent), session revocation, the suspension columns, terms acceptance, the pending
// address of an unverified account, the known-device read and the final removal of an account's
// auth rows. Everything else it needs comes from the shared modules beside this one.
//
// TIME. `user`, `session`, `account` and `verification` are Better Auth's tables: their
// timestamps are zone-less and hold UTC. A `Date` is written to them only through the Drizzle
// column, and they are never compared with `now()` in SQL — where a stored instant decides
// something, the row is read and compared in application code. `invites` and
// `pending_user_purges` are ours (`timestamptz`) and compare with `now()` freely.

import { and, eq, gt, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import { hasAdminRole } from "../../../shared/roles";
import type { Executor } from "../client";
import { isUniqueViolation } from "../errors";
import {
  account,
  auditLog,
  downloadLedger,
  invites,
  type LedgerSubject,
  passkey,
  pendingUserPurges,
  session,
  twoFactor,
  user,
  userPrefs,
  verification,
} from "../schema";
import { addUsageIfUnder } from "./ledger";

// ── invites ─────────────────────────────────────────────────────────────────────────────────

const inviteIsLive = sql`${invites.uses} < ${invites.maxUses}
  AND ${invites.revokedAt} IS NULL
  AND (${invites.expiresAt} IS NULL OR ${invites.expiresAt} > now())`;

/** Would this code admit a sign-up right now? Reads only; nothing is consumed. */
export async function inviteUsable(db: Executor, code: string): Promise<boolean> {
  if (!code) return false;
  const rows = await db
    .select({ code: invites.code })
    .from(invites)
    .where(and(eq(invites.code, code), inviteIsLive))
    .limit(1);
  return rows.length > 0;
}

// ── the sign-up reservation ─────────────────────────────────────────────────────────────────

export type VelocitySubject = { type: LedgerSubject; id: string; limit: number };

export type SignupReservation = {
  /** The UTC day (`YYYY-MM-DD`) the counters belong to. */
  day: string;
  subjects: VelocitySubject[];
  /** The invite that was used, or null when none was needed. */
  inviteCode: string | null;
};

export type ReserveResult =
  | { ok: true; reservation: SignupReservation; invitedBy: string | null }
  | { ok: false; reason: "velocity"; subject: LedgerSubject }
  | { ok: false; reason: "invite" }
  | { ok: false; reason: "intent" };

class Refused extends Error {
  constructor(readonly result: Extract<ReserveResult, { ok: false }>) {
    super("refused");
  }
}

/** The identifier of a sign-up intent's single-use marker in `verification`. */
export const intentIdentifier = (nonce: string) => `signup-intent:${nonce}`;

/**
 * Takes everything one sign-up uses up, or nothing — ONE transaction:
 *   1. one count on each velocity subject, each refused at its limit (the check and the add are
 *      one statement per subject, so concurrent sign-ups cannot pass a limit together);
 *   2. one use of the invite (`inviteCode` null = no invite needed): a single conditional
 *      UPDATE, so a one-use code admits exactly one of any number of concurrent sign-ups;
 *   3. the intent's single-use marker (`intentNonce` null = not an OAuth sign-up).
 * The invite and the intent are last, so a sign-up refused for velocity burns neither.
 * Subjects are taken in the order given; every caller passes them in the same order (one lock
 * order, no deadlock between two sign-ups).
 */
export async function reserveSignup(
  db: Executor,
  input: {
    day: string;
    subjects: VelocitySubject[];
    inviteCode: string | null;
    intentNonce: string | null;
    now: Date;
  },
): Promise<ReserveResult> {
  try {
    return await db.transaction(async (tx) => {
      for (const subject of input.subjects) {
        const counted = await addUsageIfUnder(
          tx,
          input.day,
          subject.type,
          subject.id,
          { bytes: 0, count: 1 },
          { count: subject.limit },
        );
        if (!counted) throw new Refused({ ok: false, reason: "velocity", subject: subject.type });
      }

      let invitedBy: string | null = null;
      if (input.inviteCode !== null) {
        const used = await tx
          .update(invites)
          .set({ uses: sql`${invites.uses} + 1` })
          .where(and(eq(invites.code, input.inviteCode), inviteIsLive))
          .returning({ createdBy: invites.createdBy });
        if (used.length === 0) throw new Refused({ ok: false, reason: "invite" });
        invitedBy = used[0]!.createdBy;
      }

      if (input.intentNonce !== null) {
        // Deleting IS the consumption: of two requests replaying one intent, one deletes a row.
        const consumed = await tx
          .delete(verification)
          .where(eq(verification.identifier, intentIdentifier(input.intentNonce)))
          .returning({ expiresAt: verification.expiresAt });
        const live = consumed.some((row) => row.expiresAt.getTime() > input.now.getTime());
        if (!live) throw new Refused({ ok: false, reason: "intent" });
      }

      return {
        ok: true as const,
        reservation: { day: input.day, subjects: input.subjects, inviteCode: input.inviteCode },
        invitedBy,
      };
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

/**
 * Gives a reservation back after a sign-up that did NOT create its user: one count off each
 * subject and one use off the invite, never below zero.
 *
 * `unlessUserExists`: the address to check first, for a caller that does not KNOW whether its
 * user row was written (the request threw somewhere after the reservation) — if a user with
 * that address exists, nothing is given back and false is returned. A caller that knows its
 * insert failed (Better Auth answered "failed to create user": another sign-up took the address
 * first) passes null: the row that exists is someone else's. So does a sign-up that creates no
 * row at all (a Google sign-up at an account that was there before): "a user with that address
 * exists" cannot tell a row made by this sign-up from one made before it, so it is asked only
 * where the address had no row when the reservation was taken.
 */
export async function releaseSignup(
  db: Executor,
  reservation: SignupReservation,
  unlessUserExists: string | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (unlessUserExists !== null) {
      const created = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, unlessUserExists))
        .limit(1);
      if (created.length > 0) return false;
    }
    for (const subject of reservation.subjects) {
      await tx
        .update(downloadLedger)
        .set({ count: sql`GREATEST(${downloadLedger.count} - 1, 0)` })
        .where(
          and(
            eq(downloadLedger.day, reservation.day),
            eq(downloadLedger.subjectType, subject.type),
            eq(downloadLedger.subjectId, subject.id),
          ),
        );
    }
    if (reservation.inviteCode !== null) {
      await tx
        .update(invites)
        .set({ uses: sql`GREATEST(${invites.uses} - 1, 0)` })
        .where(eq(invites.code, reservation.inviteCode));
    }
    return true;
  });
}

/** Records a sign-up intent's single-use marker. `id` is a Better Auth-format row id. */
export async function insertIntent(
  db: Executor,
  row: { id: string; nonce: string; expiresAt: Date; now: Date },
): Promise<void> {
  await db.insert(verification).values({
    id: row.id,
    identifier: intentIdentifier(row.nonce),
    value: "1",
    expiresAt: row.expiresAt,
    createdAt: row.now,
    updatedAt: row.now,
  });
}

// ── account rows ────────────────────────────────────────────────────────────────────────────

export type AccountRow = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string | null;
  twoFactorEnabled: boolean;
  banned: boolean;
  banExpires: Date | null;
  suspendedAt: Date | null;
  deleteScheduledAt: Date | null;
  termsVersion: string | null;
};

const accountColumns = {
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerified,
  role: user.role,
  twoFactorEnabled: user.twoFactorEnabled,
  banned: user.banned,
  banExpires: user.banExpires,
  suspendedAt: user.suspendedAt,
  deleteScheduledAt: user.deleteScheduledAt,
  termsVersion: user.termsVersion,
};

function toAccount(row: {
  [K in keyof typeof accountColumns]: (typeof accountColumns)[K]["_"]["data"] | null;
}): AccountRow {
  return {
    id: row.id!,
    email: row.email!,
    name: row.name!,
    emailVerified: row.emailVerified === true,
    role: row.role,
    twoFactorEnabled: row.twoFactorEnabled === true,
    banned: row.banned === true,
    banExpires: row.banExpires,
    suspendedAt: row.suspendedAt,
    deleteScheduledAt: row.deleteScheduledAt,
    termsVersion: row.termsVersion,
  };
}

/** The account as the database has it NOW (never a cookie-cached copy). Null when unknown. */
export async function getAccount(db: Executor, userId: string): Promise<AccountRow | null> {
  const [row] = await db.select(accountColumns).from(user).where(eq(user.id, userId)).limit(1);
  return row ? toAccount(row) : null;
}

/** `email` is matched exactly: pass it lower-cased, as Better Auth stores it. */
export async function getAccountByEmail(db: Executor, email: string): Promise<AccountRow | null> {
  const [row] = await db.select(accountColumns).from(user).where(eq(user.email, email)).limit(1);
  return row ? toAccount(row) : null;
}

/** When the purge of this account began, or null (not scheduled, or scheduled and not begun). */
export async function purgeStartedAt(db: Executor, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: pendingUserPurges.startedAt })
    .from(pendingUserPurges)
    .where(eq(pendingUserPurges.userId, userId))
    .limit(1);
  return row?.startedAt ?? null;
}

/** Creates the user's preferences row with its defaults. Safe to repeat. */
export async function ensureUserPrefs(db: Executor, userId: string): Promise<void> {
  await db.insert(userPrefs).values({ userId }).onConflictDoNothing();
}

/** Gives the account the `admin` role. False when it already has it or does not exist. */
const bootstrapMarker = (userId: string) => `admin-bootstrap:${userId}`;

/**
 * Makes the account an admin BY THE BOOTSTRAP LIST — and marks it so (a `verification` row
 * `admin-bootstrap:<user id>`): a role that `ADMIN_EMAILS` gave is one that `ADMIN_EMAILS` can
 * take back (`revokeBootstrapAdmin`); a role another admin gave through /admin/set-role carries
 * no mark and is not the list's to revoke. One transaction. False when it already was an admin.
 */
export async function grantAdminRole(db: Executor, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(user)
      .set({ role: "admin" })
      .where(and(eq(user.id, userId), sql`${user.role} IS DISTINCT FROM 'admin'`))
      .returning({ id: user.id });
    if (rows.length === 0) return false;
    const at = new Date();
    await tx.delete(verification).where(eq(verification.identifier, bootstrapMarker(userId)));
    await tx.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: bootstrapMarker(userId),
      value: "ADMIN_EMAILS",
      // Never, in practice: the nightly sweep removes only rows that have expired.
      expiresAt: new Date(at.getTime() + 20 * 365 * 86_400_000),
      createdAt: at,
      updatedAt: at,
    });
    return true;
  });
}

/**
 * Takes the admin role back from an account that has it FROM THE BOOTSTRAP LIST (the mark) — one
 * statement, so it happens once however many requests see it. True when the role was taken.
 */
export async function revokeBootstrapAdmin(db: Executor, userId: string): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    WITH marked AS (
      DELETE FROM verification WHERE identifier = ${bootstrapMarker(userId)} RETURNING id
    )
    UPDATE "user" SET role = 'user'
    WHERE id = ${userId} AND role = 'admin' AND EXISTS (SELECT 1 FROM marked)
    RETURNING id`);
  return result.rows.length > 0;
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes every session row of the user and returns how many there were. Effective at once:
 * every request reads the session row (there is no cookie cache).
 */
export async function deleteUserSessions(db: Executor, userId: string): Promise<number> {
  const rows = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
  return rows.length;
}

/**
 * EVERYTHING an account can act with or stand on, ended at once — its sessions, and every kind
 * in STANDING_KINDS below (known-device proofs, key marks, remembered devices). The ONE function for every way an account
 * is locked or unlocked (services/account-state.ts: suspension — which is also what a strike or
 * a content lock does — ban, their lifting, and a deletion date that has passed). It takes the
 * user's ROW LOCK first: whatever mints one of these for the account takes the same row (shared)
 * before it writes (`putKnownDevice`), so a success racing the lock either lands before this and
 * is deleted here, or comes after and sees the locked state. Call it INSIDE the transaction that
 * changes the state. Returns how many sessions there were.
 */
export async function revokeAccess(tx: Executor, userId: string): Promise<number> {
  await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
  const sessions = await deleteUserSessions(tx, userId);
  for (const kind of STANDING_KINDS) await kind.forget(tx, userId);
  return sessions;
}

/**
 * THE REGISTRY of what an account's browsers and keys can have STANDING beside a session — every
 * kind, with the statement that ends it. `revokeAccess` ends each of them; so does
 * auth/second-factor.ts `endStandingProofs` (a password or two-factor change). A new kind of
 * standing is added HERE, and tests/unit/auth/revocation-fails-loud.test.ts then insists that it
 * can be planted and that every caller ends it.
 *   known_device    a browser's own second-factor code budget (`known-device:<id>`)
 *   passkey_mark    a passkey counts as a second factor (`passkey-2f:<id>`)
 *   trusted_device  Better Auth's "remember this device": the browser SKIPS the second-factor
 *                   challenge for thirty days (`trust-device-…`)
 */
export const STANDING_KINDS: ReadonlyArray<{
  name: string;
  forget(db: Executor, userId: string): Promise<number>;
}> = [
  { name: "known_device", forget: (db, userId) => forgetKnownDevices(db, userId) },
  { name: "passkey_mark", forget: (db, userId) => forgetPasskeyMarks(db, userId) },
  { name: "trusted_device", forget: (db, userId) => deleteTrustedDevices(db, userId) },
];

/**
 * Every OTHER outstanding reset / set-password token of the account (`reset-password:<token>`
 * rows whose value is the user): a password that has just been changed or reset must not be
 * reset again by a link mailed before it. (Better Auth consumes only the token that was used —
 * api/routes/password.mjs.) Returns how many there were.
 */
export async function forgetResetTokens(db: Executor, userId: string): Promise<number> {
  const rows = await db
    .delete(verification)
    .where(and(eq(verification.value, userId), like(verification.identifier, "reset-password:%")))
    .returning({ id: verification.id });
  return rows.length;
}

/**
 * The (country, browser family) pairs this account has signed in from since `since`: its
 * `auth.sign_in` audit rows, and its live sessions other than `exceptSessionId`.
 */
export async function knownDevices(
  db: Executor,
  userId: string,
  since: Date,
  exceptSessionId: string,
): Promise<Array<{ country: string | null; uaFamily: string | null }>> {
  const audited = await db
    .select({ country: auditLog.country, uaFamily: sql<string | null>`${auditLog.meta}->>'uaFamily'` })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, "auth.sign_in"), gt(auditLog.at, since)))
    .limit(500);
  const live = await db
    .select({ id: session.id, country: session.country, uaFamily: session.uaFamily })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.createdAt, since)))
    .limit(500);
  return [
    ...audited,
    ...live
      .filter((row) => row.id !== exceptSessionId)
      .map(({ country, uaFamily }) => ({ country, uaFamily })),
  ];
}

// ── suspension ──────────────────────────────────────────────────────────────────────────────

/**
 * Marks the account suspended. False — and nothing changes — when it already is, or when no
 * user has that id: the caller's side effects (sessions, links, the email) hang on `true`.
 */
export async function setSuspended(db: Executor, userId: string, at: Date, reason: string): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ suspendedAt: at, suspendedReason: reason })
    .where(and(eq(user.id, userId), isNull(user.suspendedAt)))
    .returning({ id: user.id });
  return rows.length > 0;
}

/** Clears the suspension. False when the account was not suspended. */
export async function clearSuspended(db: Executor, userId: string): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ suspendedAt: null, suspendedReason: null })
    .where(and(eq(user.id, userId), sql`${user.suspendedAt} IS NOT NULL`))
    .returning({ id: user.id });
  return rows.length > 0;
}

// ── the admins that are left ────────────────────────────────────────────────────────────────

/**
 * Locks EVERY row whose role names `admin`, in id order, and returns the ids of those that can
 * still act: not suspended, not banned, no deletion scheduled. Call it FIRST in the transaction
 * that suspends or schedules the deletion of an admin — before that transaction locks any other
 * user row — so two admins acting on each other at once are served one after the other, and the
 * second sees the first's change (a waiting `FOR UPDATE` reads the row as it was committed).
 */
export async function lockActiveAdmins(tx: Executor, at: Date): Promise<string[]> {
  const rows = await tx
    .select({
      id: user.id,
      role: user.role,
      suspendedAt: user.suspendedAt,
      banned: user.banned,
      banExpires: user.banExpires,
      deleteScheduledAt: user.deleteScheduledAt,
    })
    .from(user)
    .where(like(user.role, "%admin%"))
    .orderBy(user.id)
    .for("update");
  return rows
    .filter(
      (row) =>
        hasAdminRole(row.role) &&
        row.suspendedAt === null &&
        row.deleteScheduledAt === null &&
        !(row.banned === true && (row.banExpires === null || row.banExpires.getTime() > at.getTime())),
    )
    .map((row) => row.id);
}

// ── a deletion an admin ordered ─────────────────────────────────────────────────────────────

/**
 * The mark of a deletion an ADMIN scheduled (R1 secsrv-1, ruling Q6): a `verification` row
 * `admin-deletion:<user id>`, as `admin-bootstrap:` is the bootstrap list's. The identifier ends
 * with the user id, so every path that removes an account's verification rows (`tokensOf`: the
 * purge's `purgeAuthRows`, the unproven-address reset) removes it too; the value is NOT a user
 * id, so no other account's cleanup can. Written and read under the user's row lock.
 */
const adminDeletionMarker = (userId: string) => `admin-deletion:${userId}`;

export async function markAdminDeletion(tx: Executor, userId: string): Promise<void> {
  const at = new Date();
  await tx.delete(verification).where(eq(verification.identifier, adminDeletionMarker(userId)));
  await tx.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: adminDeletionMarker(userId),
    value: "admin",
    // Never, in practice: the nightly sweep removes only rows that have expired, and a held
    // account's deletion can stay scheduled for as long as the hold lasts.
    expiresAt: new Date(at.getTime() + 20 * 365 * 86_400_000),
    createdAt: at,
    updatedAt: at,
  });
}

export async function clearAdminDeletion(tx: Executor, userId: string): Promise<void> {
  await tx.delete(verification).where(eq(verification.identifier, adminDeletionMarker(userId)));
}

export async function adminDeletionMarked(db: Executor, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: verification.id })
    .from(verification)
    .where(eq(verification.identifier, adminDeletionMarker(userId)))
    .limit(1);
  return rows.length > 0;
}

/** Takes the user's row lock (the estate's lock order: the user row first). False: no such user. */
export async function lockUser(tx: Executor, userId: string): Promise<boolean> {
  const rows = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
  return rows.length > 0;
}

// ── terms ───────────────────────────────────────────────────────────────────────────────────

export async function setTermsAccepted(
  db: Executor,
  userId: string,
  version: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ termsAcceptedAt: at, termsVersion: version })
    .where(eq(user.id, userId))
    .returning({ id: user.id });
  return rows.length > 0;
}

// ── the address of an account that has not verified it yet ──────────────────────────────────

/**
 * Replaces the address of an UNVERIFIED account. False — and nothing changes — when the account
 * is verified or gone (the condition is part of the UPDATE), or when another account already
 * has the new address.
 */
export async function replaceUnverifiedEmail(
  db: Executor,
  userId: string,
  newEmail: string,
): Promise<boolean> {
  try {
    // A savepoint when called inside a transaction: a unique violation must not abort the caller's.
    return await db.transaction(async (tx) => {
      const rows = await tx
        .update(user)
        .set({ email: newEmail })
        .where(and(eq(user.id, userId), eq(user.emailVerified, false)))
        .returning({ id: user.id });
      return rows.length > 0;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

// ── how often one sign-up has changed its pending address ───────────────────────────────────
//
// Kept HERE, not in the cookie: a signed cookie can be sent again, and a counter that travels in
// it starts from wherever the oldest copy says. One `verification` row per sign-up
// (`pending-email:<userId>`, value = the number of changes so far).

const pendingChangesIdentifier = (userId: string) => `pending-email:${userId}`;

/** How many address changes the sign-up `userId` has made (0 when none is recorded). */
export async function pendingChanges(db: Executor, userId: string): Promise<number> {
  const rows = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, pendingChangesIdentifier(userId)));
  const live = rows.filter((row) => row.expiresAt.getTime() > Date.now()).map((row) => Number(row.value));
  return Math.max(0, ...live.filter(Number.isInteger));
}

/**
 * Takes one change for the sign-up — only if the count is still `expected` (what the presented
 * cookie says, or null when there is no cookie to compare) and below `max`. One transaction
 * under an advisory lock on the sign-up's id, so the same cookie sent several times at once is
 * honoured once. Returns the new count, or why not.
 */
export async function takePendingChange(
  db: Executor,
  change: { id: string; userId: string; expected: number | null; max: number },
): Promise<{ ok: true; count: number } | { ok: false; reason: "stale" | "exhausted" }> {
  const identifier = pendingChangesIdentifier(change.userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identifier}, 0))`);
    const stored = await pendingChanges(tx, change.userId);
    if (change.expected !== null && change.expected !== stored)
      return { ok: false, reason: "stale" } as const;
    if (stored >= change.max) return { ok: false, reason: "exhausted" } as const;
    await tx.delete(verification).where(eq(verification.identifier, identifier));
    const at = new Date();
    await tx.insert(verification).values({
      id: change.id,
      identifier,
      value: String(stored + 1),
      // Longer than any chain of re-minted one-hour cookies can last.
      expiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000),
      createdAt: at,
      updatedAt: at,
    });
    return { ok: true, count: stored + 1 } as const;
  });
}

// ── an account whose address was never proven ───────────────────────────────────────────────

/**
 * Every `verification` row that belongs to an account, whichever way it names it:
 *   - `value` IS the user id (a reset token, a two-factor challenge, a trusted device, our own
 *     markers);
 *   - `value` is JSON that carries the user id (a passkey challenge:
 *     `{"type":"registration","userData":{"id":…}}`, @better-auth/passkey/dist/index.mjs:192);
 *   - the IDENTIFIER ends with the user id (`totp-step:<id>`, the newest TOTP step it used).
 * A user id is 32 URL-safe characters, so it cannot contain a LIKE wildcard.
 */
function tokensOf(userId: string) {
  return or(
    eq(verification.value, userId),
    and(like(verification.value, "{%"), like(verification.value, `%"${userId}"%`)),
    like(verification.identifier, `%:${userId}`),
  );
}

export type UnprovenReset = {
  /** What the person who now PROVES the address stated at the intent step. */
  termsAcceptedAt: Date;
  termsVersion: string;
  /** The closed-test notice's assent (null: none was asked for). */
  demoNoticeAcceptedAt: Date | null;
  demoNoticeVersion: string | null;
  ageVerifiedAt: Date;
  invitedBy: string | null;
  quotaBytes: number;
  name: string;
};

/**
 * Empties an UNVERIFIED account of everything whoever created it could have planted, in one
 * transaction: its password (every `account` row), its sessions, passkeys, two-factor secret and
 * backup codes, the tokens that name it, and the profile it was given — and writes the policy
 * fields of the person who is about to prove the address. The row itself (its id, its address)
 * stays. Returns what was removed, or null when the account is not there or IS verified (then
 * nothing is touched: a proven owner's credentials are never removed this way).
 *
 * The row is locked first (`FOR UPDATE`) and its state re-read under the lock, so whatever races
 * this — a verification, an address change, a second callback for the same address — either
 * landed before (→ null, nothing touched) or waits and then finds the row changed.
 *
 * The same transaction marks the address VERIFIED. The caller only gets here once the provider
 * has vouched for the address, and from this commit on the row must not be movable: the one thing
 * its creator can still do without a session is change an UNVERIFIED account's address (the
 * pending-address route), which would otherwise slip between this cleanup and the link and leave
 * the owner's Google identity on a row whose address — and so whose password reset — is the
 * stranger's.
 */
export async function clearUnprovenAccount(
  db: Executor,
  userId: string,
  reset: UnprovenReset,
): Promise<{
  accounts: number;
  sessions: number;
  passkeys: number;
  twoFactor: number;
  tokens: number;
} | null> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, userId), eq(user.emailVerified, false)))
      .for("update");
    if (locked.length === 0) return null;
    const sessions = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
    const accounts = await tx.delete(account).where(eq(account.userId, userId)).returning({ id: account.id });
    const passkeys = await tx.delete(passkey).where(eq(passkey.userId, userId)).returning({ id: passkey.id });
    const factors = await tx
      .delete(twoFactor)
      .where(eq(twoFactor.userId, userId))
      .returning({ id: twoFactor.id });
    // Reset, delete-account, two-factor and trusted-device tokens carry the user id as value.
    const tokens = await tx.delete(verification).where(tokensOf(userId)).returning({ id: verification.id });
    await tx
      .update(user)
      .set({
        emailVerified: true,
        name: reset.name,
        image: null,
        timezone: null,
        locale: "en",
        displayNameKey: null,
        avatarNodeId: null,
        twoFactorEnabled: false,
        role: "user",
        termsAcceptedAt: reset.termsAcceptedAt,
        termsVersion: reset.termsVersion,
        demoNoticeAcceptedAt: reset.demoNoticeAcceptedAt,
        demoNoticeVersion: reset.demoNoticeVersion,
        ageVerifiedAt: reset.ageVerifiedAt,
        invitedBy: reset.invitedBy,
        quotaBytes: reset.quotaBytes,
      })
      .where(eq(user.id, userId));
    return {
      accounts: accounts.length,
      sessions: sessions.length,
      passkeys: passkeys.length,
      twoFactor: factors.length,
      tokens: tokens.length,
    };
  });
}

/**
 * The same emptying for a MAILBOX proof (auth/mailbox-proof.ts `confirmMailbox`): the holder of
 * a verification link, in a browser that did not create the account, confirmed it with a POST. Under the row lock and only while the account is
 * still unverified AND still at `email` (the address the link proves): every credential and
 * session, every passkey, two-factor secret and token is deleted, the profile its creator typed
 * is reset, and the address is marked verified — one transaction. The terms and age statement
 * (and the demo notice's assent) on the row becomes `statement` — the PROVER's own, given with the confirmation — and the invite
 * reference is cleared: what the row's creator stated is not what the owner stated. The quota
 * stays. Null when the row is not in that state: nothing is touched.
 */
export async function clearForMailboxProof(
  db: Executor,
  userId: string,
  email: string,
  statement: {
    termsAcceptedAt: Date;
    termsVersion: string;
    demoNoticeAcceptedAt: Date | null;
    demoNoticeVersion: string | null;
    ageVerifiedAt: Date;
  },
): Promise<{
  accounts: number;
  sessions: number;
  passkeys: number;
  twoFactor: number;
  tokens: number;
} | null> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, userId), eq(user.emailVerified, false), eq(user.email, email)))
      .for("update");
    if (locked.length === 0) return null;
    const sessions = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
    const accounts = await tx.delete(account).where(eq(account.userId, userId)).returning({ id: account.id });
    const passkeys = await tx.delete(passkey).where(eq(passkey.userId, userId)).returning({ id: passkey.id });
    const factors = await tx
      .delete(twoFactor)
      .where(eq(twoFactor.userId, userId))
      .returning({ id: twoFactor.id });
    const tokens = await tx.delete(verification).where(tokensOf(userId)).returning({ id: verification.id });
    await tx
      .update(user)
      .set({
        emailVerified: true,
        // The name the row's creator typed is theirs, not the owner's.
        name: email.split("@")[0] ?? "",
        image: null,
        displayNameKey: null,
        avatarNodeId: null,
        twoFactorEnabled: false,
        role: "user",
        termsAcceptedAt: statement.termsAcceptedAt,
        termsVersion: statement.termsVersion,
        demoNoticeAcceptedAt: statement.demoNoticeAcceptedAt,
        demoNoticeVersion: statement.demoNoticeVersion,
        ageVerifiedAt: statement.ageVerifiedAt,
        invitedBy: null,
      })
      .where(eq(user.id, userId));
    return {
      accounts: accounts.length,
      sessions: sessions.length,
      passkeys: passkeys.length,
      twoFactor: factors.length,
      tokens: tokens.length,
    };
  });
}

/**
 * The second half of the cleanup, run AFTER the provider's account row exists and BEFORE the
 * owner's session does (delete, link, delete again): under the same row lock, everything that
 * could have been attached to the account in the window between `clearUnprovenAccount` and the
 * link is removed — every session, every password, passkey, two-factor secret and token — and a
 * provider identity linked twice by two simultaneous callbacks is reduced to one row. What is
 * left is the account, its proven address and the provider link. Returns what it removed.
 */
export async function sweepAfterLink(
  db: Executor,
  userId: string,
): Promise<{ accounts: number; sessions: number; passkeys: number; twoFactor: number; tokens: number }> {
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
    const sessions = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
    const passwords = await tx
      .delete(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
      .returning({ id: account.id });
    // One row per provider identity: the earliest stays.
    const duplicates = await tx.execute<{ id: string }>(sql`
      DELETE FROM ${account} a USING ${account} b
      WHERE a.user_id = ${userId} AND b.user_id = a.user_id
        AND a.provider_id = b.provider_id AND a.account_id = b.account_id
        AND (a.created_at, a.id) > (b.created_at, b.id)
      RETURNING a.id`);
    const passkeys = await tx.delete(passkey).where(eq(passkey.userId, userId)).returning({ id: passkey.id });
    const factors = await tx
      .delete(twoFactor)
      .where(eq(twoFactor.userId, userId))
      .returning({ id: twoFactor.id });
    const tokens = await tx.delete(verification).where(tokensOf(userId)).returning({ id: verification.id });
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId));
    return {
      accounts: passwords.length + duplicates.rows.length,
      sessions: sessions.length,
      passkeys: passkeys.length,
      twoFactor: factors.length,
      tokens: tokens.length,
    };
  });
}

// ── the second factor of a session (auth/second-factor.ts) ──────────────────────────────────

/** The account's two-factor enrolment as the database has it, with the account's state. */
export async function secondFactorState(
  db: Executor,
  userId: string,
): Promise<{
  secret: string;
  /** The stored (encrypted) backup codes — compared, never read: it changes when one is used. */
  backupCodes: string;
  verified: boolean;
  role: string | null;
  email: string;
  name: string;
  restricted: boolean;
} | null> {
  const [row] = await db
    .select({
      secret: twoFactor.secret,
      backupCodes: twoFactor.backupCodes,
      verified: twoFactor.verified,
      role: user.role,
      email: user.email,
      name: user.name,
      banned: user.banned,
      suspendedAt: user.suspendedAt,
      deleteScheduledAt: user.deleteScheduledAt,
    })
    .from(twoFactor)
    .innerJoin(user, eq(user.id, twoFactor.userId))
    .where(eq(twoFactor.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    secret: row.secret,
    backupCodes: row.backupCodes,
    // Null on a row made before the column existed: Better Auth reads that as enrolled.
    verified: row.verified !== false,
    role: row.role,
    email: row.email,
    name: row.name,
    restricted:
      row.banned === true ||
      row.suspendedAt !== null ||
      (row.deleteScheduledAt !== null && row.deleteScheduledAt.getTime() <= Date.now()),
  };
}

/**
 * Admits ONE attempt on a second-factor budget (auth/second-factor.ts), or refuses it — in a
 * single statement, so that any number of simultaneous attempts are admitted at most `cap` times
 * in a window. The attempt is COUNTED HERE, before its code is looked at. The budget is a row of
 * `rate_limit` under `key`: `last_request` is when its window BEGAN (the first counted attempt),
 * and the count starts again once `windowSeconds` have passed since then — a real window: old
 * mistakes do not add up for ever. The clock is the database's.
 * Admitted: the count including this attempt. Refused: how long until the window ends.
 */
export async function admitSecondFactorAttempt(
  db: Executor,
  key: string,
  cap: number,
  windowSeconds: number,
): Promise<{ ok: true; count: number } | { ok: false; retryAfterSeconds: number }> {
  const windowMs = windowSeconds * 1000;
  const result = await db.execute<{ admitted: number | null; wait_ms: string | number | null }>(sql`
    WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms),
    held AS (
      SELECT r.last_request + ${windowMs} - clock.ms AS wait_ms FROM rate_limit r, clock WHERE r.key = ${key}
    ),
    admitted AS (
      INSERT INTO rate_limit AS r (id, key, count, last_request)
      SELECT gen_random_uuid()::text, ${key}, 1, clock.ms FROM clock
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN r.last_request <= (SELECT ms FROM clock) - ${windowMs} THEN 1 ELSE r.count + 1 END,
        last_request =
          CASE WHEN r.last_request <= (SELECT ms FROM clock) - ${windowMs} THEN (SELECT ms FROM clock)
               ELSE r.last_request END
      WHERE r.last_request <= (SELECT ms FROM clock) - ${windowMs} OR r.count < ${cap}
      RETURNING r.count
    )
    SELECT (SELECT count FROM admitted) AS admitted, (SELECT wait_ms FROM held) AS wait_ms`);
  const row = result.rows[0];
  if (row && row.admitted !== null) return { ok: true, count: Number(row.admitted) };
  const waitMs = row?.wait_ms != null ? Number(row.wait_ms) : windowMs;
  return {
    ok: false,
    retryAfterSeconds: Math.min(windowSeconds, Math.max(1, Math.ceil(waitMs / 1000))),
  };
}

/**
 * A correct code: THIS attempt is given back to the budget it was counted on — one, never more
 * (the wrong codes others sent in the same window stay counted).
 */
export async function returnSecondFactorAttempt(
  db: Executor,
  key: string,
  windowSeconds: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE rate_limit SET count = greatest(count - 1, 0)
    WHERE key = ${key}
      AND last_request > (extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${windowSeconds * 1000}`);
}

/**
 * True for exactly ONE caller per `windowSeconds` and `key` (one statement, arbitrated by the
 * unique key): "has this already been announced in this window?".
 */
export async function claimOncePerWindow(db: Executor, key: string, windowSeconds: number): Promise<boolean> {
  const windowMs = windowSeconds * 1000;
  const result = await db.execute(sql`
    WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms)
    INSERT INTO rate_limit AS r (id, key, count, last_request)
    SELECT gen_random_uuid()::text, ${key}, 1, clock.ms FROM clock
    ON CONFLICT (key) DO UPDATE SET count = 1, last_request = (SELECT ms FROM clock)
    WHERE r.last_request <= (SELECT ms FROM clock) - ${windowMs}
    RETURNING r.key`);
  return result.rows.length > 0;
}

// "This browser has passed the account's second factor before" (auth/signed-cookie.ts
// `hf_device`): a `verification` row `known-device:<deviceId>` whose VALUE is the user id — so
// every "delete what names this user" removes it, and `forgetKnownDevices` ends them all.
const knownDeviceIdentifier = (deviceId: string) => `known-device:${deviceId}`;

/** How many known-device proofs one account may have; the oldest go when a new one is made. */
export const KNOWN_DEVICE_MAX = 20;

export async function putKnownDevice(
  db: Executor,
  device: { id: string; deviceId: string; userId: string; expiresAt: Date },
): Promise<void> {
  const at = new Date();
  // One transaction per account at a time (an advisory lock on the user): the insert and the
  // eviction of everything past the newest KNOWN_DEVICE_MAX are atomic, so simultaneous
  // sign-ins cannot leave more than the cap behind.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`known-device:${device.userId}`}))`);
    // The account's row, shared: a suspension or a ban holds it exclusively while it deletes
    // (`revokeAccess`), so this either commits before that (and is deleted by it) or waits and
    // sees the locked state — an account that is locked gets no proof.
    const [owner] = await tx
      .select({ banned: user.banned, suspendedAt: user.suspendedAt })
      .from(user)
      .where(eq(user.id, device.userId))
      .for("share");
    if (!owner || owner.banned === true || owner.suspendedAt !== null) return;
    await tx.insert(verification).values({
      id: device.id,
      identifier: knownDeviceIdentifier(device.deviceId),
      value: device.userId,
      expiresAt: device.expiresAt,
      createdAt: at,
      updatedAt: at,
    });
    await tx.execute(sql`
      DELETE FROM ${verification} WHERE id IN (
        SELECT id FROM ${verification}
        WHERE value = ${device.userId} AND identifier LIKE 'known-device:%'
        ORDER BY created_at DESC, id DESC
        OFFSET ${KNOWN_DEVICE_MAX}
      )`);
  });
}

export async function isKnownDevice(db: Executor, deviceId: string, userId: string): Promise<boolean> {
  return hasAuthMarker(db, knownDeviceIdentifier(deviceId), userId);
}

/** Every known-device proof of the account stops counting. Returns how many there were. */
export async function forgetKnownDevices(db: Executor, userId: string): Promise<number> {
  const rows = await db
    .delete(verification)
    .where(and(eq(verification.value, userId), like(verification.identifier, "known-device:%")))
    .returning({ id: verification.id });
  return rows.length;
}

const totpStepIdentifier = (userId: string) => `totp-step:${userId}`;

/**
 * Records `step` as the newest TOTP time-step this account has used — unless it has already used
 * that step or a later one (then false: a replay). One transaction under the account's
 * two-factor row lock, so two simultaneous uses of one code cannot both be accepted.
 */
export async function acceptTotpStep(
  db: Executor,
  userId: string,
  accepted: { id: string; step: number },
): Promise<boolean> {
  const identifier = totpStepIdentifier(userId);
  return db.transaction(async (tx) => {
    await tx.select({ id: twoFactor.id }).from(twoFactor).where(eq(twoFactor.userId, userId)).for("update");
    const rows = await tx
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, identifier));
    const last = Math.max(-1, ...rows.map((row) => Number(row.value)).filter(Number.isFinite));
    if (accepted.step <= last) return false;
    if (rows.length > 0) await tx.delete(verification).where(eq(verification.identifier, identifier));
    const at = new Date();
    await tx.insert(verification).values({
      id: accepted.id,
      identifier,
      value: String(accepted.step),
      // Long past the three steps a code is valid for; the step only ever grows.
      expiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000),
      createdAt: at,
      updatedAt: at,
    });
    return true;
  });
}

/** The enrolment is gone: so is the record of the last step its secret was used at. */
export async function forgetTotpStep(db: Executor, userId: string): Promise<void> {
  await db.delete(verification).where(eq(verification.identifier, totpStepIdentifier(userId)));
}

/**
 * No passkey of the account "counts as a second factor" any more (`passkey-2f:<id>` rows): the
 * keys stay and still sign in — as one factor — until one is registered again by a session
 * that has passed the factor. Returns how many marks there were.
 */
export async function forgetPasskeyMarks(db: Executor, userId: string): Promise<number> {
  const rows = await db
    .delete(verification)
    .where(and(eq(verification.value, userId), like(verification.identifier, "passkey-2f:%")))
    .returning({ id: verification.id });
  return rows.length;
}

/** Marks an existing session of `userId` as having passed a second factor. False when it is gone. */
export async function stampSecondFactor(
  db: Executor,
  sessionId: string,
  userId: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(session)
    .set({ secondFactorAt: at })
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), isNull(session.impersonatedBy)))
    .returning({ id: session.id });
  return rows.length > 0;
}

/** Takes the mark off the account's sessions (all of them, or all but one). Returns how many had it. */
export async function clearSecondFactor(
  db: Executor,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await db
    .update(session)
    .set({ secondFactorAt: null })
    .where(
      and(
        eq(session.userId, userId),
        isNotNull(session.secondFactorAt),
        exceptSessionId ? ne(session.id, exceptSessionId) : undefined,
      ),
    )
    .returning({ id: session.id });
  return rows.length;
}

// Small facts about an account that have no column of their own, kept as `verification` rows whose
// VALUE is the user id (so every "delete what names this user" removes them too):
//   2fa-enrol:<sessionId>     the password was just proven on this session (two-factor/enable)
//   email-change:<userId>:<newEmail>   this account asked to move to that address and has not
//                             confirmed yet (auth/mailbox-proof.ts; taken by the confirmation)
//   passkey-2f:<passkeyId>    this passkey was registered by a session that had passed a second factor
//                             (all of an account's are deleted by `forgetPasskeyMarks`)
export async function putAuthMarker(
  db: Executor,
  marker: { id: string; identifier: string; userId: string; expiresAt: Date },
): Promise<void> {
  const at = new Date();
  await db.delete(verification).where(eq(verification.identifier, marker.identifier));
  await db.insert(verification).values({
    id: marker.id,
    identifier: marker.identifier,
    value: marker.userId,
    expiresAt: marker.expiresAt,
    createdAt: at,
    updatedAt: at,
  });
}

export async function hasAuthMarker(db: Executor, identifier: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(and(eq(verification.identifier, identifier), eq(verification.value, userId)));
  return rows.some((row) => row.expiresAt.getTime() > Date.now());
}

/**
 * Takes a marker: deletes it and says whether it was there (and live) — ONE statement, so of
 * any number of simultaneous takers exactly one gets it.
 */
export async function takeAuthMarker(db: Executor, identifier: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(verification)
    .where(and(eq(verification.identifier, identifier), eq(verification.value, userId)))
    .returning({ expiresAt: verification.expiresAt });
  return rows.some((row) => row.expiresAt.getTime() > Date.now());
}

export async function deleteAuthMarker(db: Executor, identifier: string): Promise<void> {
  await db.delete(verification).where(eq(verification.identifier, identifier));
}

/** One `account` row of `userId` — its provider and whether it holds a password — or null: not theirs. */
export async function linkedProvider(
  db: Executor,
  accountRowId: string,
  userId: string,
): Promise<{ providerId: string; hasPassword: boolean } | null> {
  const [row] = await db
    .select({ providerId: account.providerId, password: account.password })
    .from(account)
    .where(and(eq(account.id, accountRowId), eq(account.userId, userId)))
    .limit(1);
  return row ? { providerId: row.providerId, hasPassword: row.password !== null } : null;
}

/** The passkey row behind a WebAuthn credential id. */
export async function passkeyByCredential(
  db: Executor,
  credentialId: string,
): Promise<{ id: string; userId: string } | null> {
  const [row] = await db
    .select({ id: passkey.id, userId: passkey.userId })
    .from(passkey)
    .where(eq(passkey.credentialID, credentialId))
    .limit(1);
  return row ?? null;
}

/** "Remember this device" records of an account (the two-factor plugin's `trust-device-…` rows). */
export async function deleteTrustedDevices(db: Executor, userId: string): Promise<number> {
  const rows = await db
    .delete(verification)
    .where(and(eq(verification.value, userId), like(verification.identifier, "trust-device-%")))
    .returning({ id: verification.id });
  return rows.length;
}

// ── housekeeping ────────────────────────────────────────────────────────────────────────────

/**
 * Deletes `verification` rows that expired more than a day ago — at most `limit` per call —
 * and returns how many. Such rows are created by requests nobody has authenticated (a sign-up
 * intent, passkey options, an OAuth state, a two-factor challenge) and Better Auth removes one
 * only when it is used: without this the table only grows. A day's grace: nothing that expired
 * is ever read again, and a clock that is a little off deletes nothing live.
 * (`now() AT TIME ZONE 'UTC'`: the column carries no zone.)
 */
export async function sweepExpiredVerifications(
  db: Executor,
  options: { limit?: number } = {},
): Promise<number> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 5000), 50_000));
  const result = await db.execute(sql`
    DELETE FROM ${verification}
    WHERE id IN (
      SELECT id FROM ${verification}
      WHERE expires_at < (now() AT TIME ZONE 'UTC') - interval '1 day'
      LIMIT ${limit}
    )`);
  return result.rowCount ?? 0;
}

// ── the end of an account ───────────────────────────────────────────────────────────────────

/**
 * Deletes the user's Better Auth rows: sessions, accounts, passkeys, two-factor secrets, the
 * verification rows that name the user, then the `user` row — in that order, in one
 * transaction. The purge job calls this LAST, after the account's files, links and shares are
 * gone: a foreign key that still points at the user makes this fail, and nothing is deleted.
 * Never reached through Better Auth's delete endpoint.
 */
export async function purgeAuthRows(db: Executor, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(passkey).where(eq(passkey.userId, userId));
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
    // Reset, delete-account, two-factor and trusted-device tokens carry the user id as value.
    await tx.delete(verification).where(tokensOf(userId));
    const removed = await tx.delete(user).where(eq(user.id, userId)).returning({ id: user.id });
    return removed.length > 0;
  });
}

/**
 * The sign-in throttle (auth/signin-throttle.ts), in ONE statement: counts this attempt on the
 * client's row for the account — unless the client has to wait, in which case nothing is written
 * and the wait is returned. `rate_limit.last_request` is in milliseconds; the clock is the
 * database's, for the write and for the comparison alike.
 *
 * The wait of a row with `k` counted attempts, where all OTHER clients have `n` on the account
 * within the window: the whole `maxDelaySeconds` once `n + k >= pressure`; nothing while
 * `k < free`; else 2^(k - free) seconds, at most `maxDelaySeconds`.
 */
export async function admitSignIn(
  db: Executor,
  keys: { account: string; pair: string },
  rule: { windowSeconds: number; free: number; maxDelaySeconds: number; pressure: number },
): Promise<{ ok: true; count: number } | { ok: false; retryAfterSeconds: number }> {
  const windowMs = rule.windowSeconds * 1000;
  const result = await db.execute<{
    admitted: number | null;
    wait_ms: string | number | null;
    others: number | null;
  }>(sql`
    WITH clock AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms),
    others AS (
      SELECT coalesce(sum(r.count), 0)::int AS n FROM rate_limit r, clock
      WHERE r.key LIKE ${keys.account + "%"} AND r.key <> ${keys.pair} AND r.last_request > clock.ms - ${windowMs}
    ),
    held AS (
      SELECT r.last_request + 1000 * (
               CASE WHEN others.n + r.count >= ${rule.pressure} THEN ${rule.maxDelaySeconds}
                    WHEN r.count < ${rule.free} THEN 0
                    ELSE least(${rule.maxDelaySeconds}, power(2, least(r.count - ${rule.free}, 20)))
               END)::bigint AS free_at
      FROM rate_limit r, others, clock
      WHERE r.key = ${keys.pair} AND r.last_request > clock.ms - ${windowMs}
    ),
    admitted AS (
      INSERT INTO rate_limit AS r (id, key, count, last_request)
      -- (an id of its own: two first attempts at once must collide on the KEY, which is arbitrated)
      SELECT gen_random_uuid()::text, ${keys.pair}, 1, clock.ms FROM clock
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN r.last_request <= (SELECT ms FROM clock) - ${windowMs} THEN 1 ELSE r.count + 1 END,
        last_request = (SELECT ms FROM clock)
      WHERE r.last_request <= (SELECT ms FROM clock) - ${windowMs}
         OR r.last_request + 1000 * (
              CASE WHEN (SELECT n FROM others) + r.count >= ${rule.pressure} THEN ${rule.maxDelaySeconds}
                   WHEN r.count < ${rule.free} THEN 0
                   ELSE least(${rule.maxDelaySeconds}, power(2, least(r.count - ${rule.free}, 20)))
              END)::bigint <= (SELECT ms FROM clock)
      RETURNING r.count
    )
    SELECT (SELECT count FROM admitted) AS admitted,
           (SELECT free_at FROM held) - (SELECT ms FROM clock) AS wait_ms,
           (SELECT n FROM others) AS others`);
  const row = result.rows[0];
  if (row && row.admitted !== null) return { ok: true, count: Number(row.admitted) };
  // No row of its own in this statement's snapshot: another attempt of the same client made it
  // this very moment (count 1) — the wait is that of a first failure.
  const waitMs =
    row?.wait_ms != null
      ? Number(row.wait_ms)
      : Number(row?.others ?? 0) + 1 >= rule.pressure
        ? rule.maxDelaySeconds * 1000
        : 1000;
  return { ok: false, retryAfterSeconds: Math.ceil(Math.max(waitMs, 1) / 1000) };
}

/** The password was right: this client's failures on the account are forgotten. */
export async function forgetSignInFailures(db: Executor, pair: string): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit WHERE key = ${pair}`);
}
