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

import { and, eq, gt, isNotNull, isNull, like, ne, sql } from "drizzle-orm";
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

export type UnprovenReset = {
  /** What the person who now PROVES the address stated at the intent step. */
  termsAcceptedAt: Date;
  termsVersion: string;
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
    const tokens = await tx
      .delete(verification)
      .where(eq(verification.value, userId))
      .returning({ id: verification.id });
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
 * The same emptying for a MAILBOX proof (auth/mailbox-proof.ts): a verification link opened in a
 * browser that did not create the account. Under the row lock and only while the account is
 * still unverified AND still at `email` (the address the link proves): every credential and
 * session, every passkey, two-factor secret and token is deleted, the profile its creator typed
 * is reset, and the address is marked verified — one transaction. The policy fields (terms, age,
 * invite, quota) stay as the sign-up wrote them. Null when the row is not in that state: nothing
 * is touched.
 */
export async function clearForMailboxProof(
  db: Executor,
  userId: string,
  email: string,
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
    const tokens = await tx
      .delete(verification)
      .where(eq(verification.value, userId))
      .returning({ id: verification.id });
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
    const tokens = await tx
      .delete(verification)
      .where(eq(verification.value, userId))
      .returning({ id: verification.id });
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
  verified: boolean;
  role: string | null;
  email: string;
  name: string;
  restricted: boolean;
} | null> {
  const [row] = await db
    .select({
      secret: twoFactor.secret,
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
 * Admits ONE attempt at the account's second factor, or refuses it — in a single statement, so
 * that any number of simultaneous attempts are admitted at most `cap` times: the attempt is
 * COUNTED HERE, before its code is looked at, and the statement matches no row while the account
 * is locked. The attempt that brings the count to `cap` sets the lock (`lockSeconds` from now).
 * A lock that has run out starts a new count. Returns null when refused (locked, or no enrolment).
 *
 * The columns are the two-factor plugin's own; its own accounting is switched off
 * (create-auth.ts `accountLockout`), so this is the one budget for the sign-in challenge and the
 * step-up, for TOTP and backup codes, across every session and address.
 * (`now() AT TIME ZONE 'UTC'`: Better Auth's timestamp columns carry no zone.)
 */
export async function admitSecondFactorAttempt(
  db: Executor,
  userId: string,
  cap: number,
  lockSeconds: number,
): Promise<{ count: number; lockedNow: boolean } | null> {
  const result = await db.execute<{ count: number; locked: boolean }>(sql`
    UPDATE ${twoFactor} SET
      failed_verification_count =
        CASE WHEN locked_until IS NOT NULL THEN 1 ELSE coalesce(failed_verification_count, 0) + 1 END,
      locked_until =
        CASE WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE coalesce(failed_verification_count, 0) + 1 END) >= ${cap}
             THEN (now() AT TIME ZONE 'UTC') + make_interval(secs => ${lockSeconds})
             ELSE NULL END
    WHERE user_id = ${userId}
      AND (locked_until IS NULL OR locked_until <= (now() AT TIME ZONE 'UTC'))
    RETURNING failed_verification_count AS count, (locked_until IS NOT NULL) AS locked`);
  const row = result.rows[0];
  return row ? { count: Number(row.count), lockedNow: row.locked === true } : null;
}

/** A correct code: the count of attempts starts again, and a lock set by this very attempt is lifted. */
export async function resetSecondFactorAttempts(db: Executor, userId: string): Promise<void> {
  await db
    .update(twoFactor)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(eq(twoFactor.userId, userId));
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
//   passkey-2f:<passkeyId>    this passkey was registered by a session that had passed a second factor
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

export async function deleteAuthMarker(db: Executor, identifier: string): Promise<void> {
  await db.delete(verification).where(eq(verification.identifier, identifier));
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
