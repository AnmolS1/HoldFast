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

import { and, eq, gt, isNull, sql } from "drizzle-orm";
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
 * first) passes null: the row that exists is someone else's.
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
export async function grantAdminRole(db: Executor, userId: string): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ role: "admin" })
    .where(and(eq(user.id, userId), sql`${user.role} IS DISTINCT FROM 'admin'`))
    .returning({ id: user.id });
  return rows.length > 0;
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes every session row of the user and returns how many there were. A browser that holds
 * one keeps working until its cookie cache expires (at most 60 s); the session middleware
 * refuses a suspended, banned or deleted account in the meantime.
 */
export async function deleteUserSessions(db: Executor, userId: string): Promise<number> {
  const rows = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
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
    await tx.delete(verification).where(eq(verification.value, userId));
    const removed = await tx.delete(user).where(eq(user.id, userId)).returning({ id: user.id });
    return removed.length > 0;
  });
}
