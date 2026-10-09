// The additional `user` and `session` fields the RUNTIME instance declares (create-auth.ts).
//
// The single definition: auth/config.ts — the file `npm run auth:generate` reads — imports and
// re-exports these same objects, so the generated schema and the runtime cannot drift.
//
// Why they live here and not in config.ts (create-auth.ts must not import that module): importing ANY binding from that module
// evaluates it, and it builds a second `betterAuth()` instance at module scope — over a database
// URL that is never connected to and with no Drizzle schema. In the Worker that is an instance
// cached on the isolate (the one thing the #10315 rules forbid) and an
// "ERROR [Better Auth]: Drizzle schema mismatch — Missing tables user, session, …" line in the
// log at every isolate start. This module has no imports.
//
// `returned: false` is not a column attribute (the generated schema is the same without it):
// a field so marked is never part of a session answer — neither `GET /api/auth/get-session` nor
// the signed-but-readable cookie cache — so the browser never sees it:
//   legalHold        a hold must not be observable by the account holder
//   invitedBy        another account's id
//   suspendedReason  an operator's note

/** 5 GiB, the beta quota. The real value is written at sign-up from `QUOTA_BYTES`. */
const DEFAULT_QUOTA_BYTES = 5_368_709_120;

export const userAdditionalFields = {
  quotaBytes: {
    type: "number",
    bigint: true,
    required: true,
    defaultValue: DEFAULT_QUOTA_BYTES,
    input: false,
  },
  usedBytes: { type: "number", bigint: true, required: true, defaultValue: 0, input: false },
  ageVerifiedAt: { type: "date", required: false, input: false },
  termsAcceptedAt: { type: "date", required: false, input: false },
  termsVersion: { type: "string", required: false, input: false },
  invitedBy: { type: "string", required: false, input: false, returned: false },
  suspendedAt: { type: "date", required: false, input: false },
  suspendedReason: { type: "string", required: false, input: false, returned: false },
  legalHold: { type: "boolean", required: true, defaultValue: false, input: false, returned: false },
  deleteScheduledAt: { type: "date", required: false, input: false },
  displayNameKey: { type: "string", required: false, input: false },
  timezone: { type: "string", required: false, input: false },
  locale: { type: "string", required: true, defaultValue: "en", input: false },
  avatarNodeId: { type: "string", required: false, input: false },
} as const;

export const sessionAdditionalFields = {
  country: { type: "string", required: false, input: false },
  uaFamily: { type: "string", required: false, input: false },
  // When THIS session passed a second factor — a TOTP or backup code (at sign-in, at enrolment
  // or as a step-up on the session), or a passkey assertion with user verification. Null for a
  // session that Google, a passkey without user verification, a trusted device or a mailed link
  // created. "An admin has two-factor" is a property of the session, not of the account
  // (middleware/guards.ts, auth/admin-gate.ts). `input: false`: no request body can set it
  // (Better Auth's /update-session takes only input fields) — only auth/second-factor.ts does.
  secondFactorAt: { type: "date", required: false, input: false },
} as const;
