// The additional `user` and `session` fields the RUNTIME instance declares (create-auth.ts).
//
// They are the fields of auth/config.ts — the file `npm run auth:generate` reads — and a unit
// test (tests/unit/auth/config-agreement.test.ts) fails when the two differ in anything that
// decides a column: name, type, bigint, required, default, input.
//
// Why create-auth.ts does not import them from config.ts: importing ANY binding from that module
// evaluates it, and it builds a second `betterAuth()` instance at module scope — over a database
// URL that is never connected to and with no Drizzle schema. In the Worker that is an instance
// cached on the isolate (the one thing the #10315 rules forbid) and an
// "ERROR [Better Auth]: Drizzle schema mismatch — Missing tables user, session, …" line in the
// log at every isolate start. This module has no imports.
//
// The one deliberate difference from config.ts is `returned: false` (not a column attribute):
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
} as const;
