// What the worker core knows about a session. Owner: the worker core (T07).
//
// The row types of the generated auth schema (src/worker/db/auth-schema.ts) are assignable to
// these — a type-level test holds them to it (tests/unit/worker-core/integration.test.ts) — so a
// regenerated schema that renames or retypes a field stops the typecheck here, not at run time.
//
// Structural types on purpose: no Better Auth import. Field names come from Better Auth 1.7.7
// (core user and session, the admin plugin, the two-factor plugin) and from the additional fields
// of the auth config. Everything that is nullable in the database is optional and nullable here.

/** A signed-in user as the session lookup returns it. Ids are 32-character strings, not UUIDs. */
export type SessionUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;

  // Admin plugin.
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;

  // Two-factor plugin.
  twoFactorEnabled?: boolean | null;

  // Additional fields.
  quotaBytes: number;
  usedBytes: number;
  ageVerifiedAt?: Date | null;
  termsAcceptedAt?: Date | null;
  termsVersion?: string | null;
  invitedBy?: string | null;
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  legalHold?: boolean | null;
  deleteScheduledAt?: Date | null;
  displayNameKey?: string | null;
  timezone?: string | null;
  locale?: string | null;
  avatarNodeId?: string | null;
};

export type SessionInfo = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;

  // Additional fields.
  country?: string | null;
  uaFamily?: string | null;
  /** When this session passed a second factor (auth/second-factor.ts); null when it never did. */
  secondFactorAt?: Date | null;

  /** Admin plugin: set on an impersonated session to the admin's user id. */
  impersonatedBy?: string | null;
};

/** The subset of a Better Auth instance the Worker uses. */
export type Auth = {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(context: {
      headers: Headers;
      /** `disableCookieCache: true` reads the session and its user from the database. */
      query?: { disableCookieCache?: boolean };
    }): Promise<{ session: SessionInfo; user: SessionUser } | null>;
  };
};
