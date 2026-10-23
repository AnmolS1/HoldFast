// Pins the error code → HTTP status table. The expected values are written out here, not read
// from the table, so a changed or missing status fails.
import { describe, expect, it } from "vitest";
import { ERROR_STATUS } from "../../../src/shared/errors";

const expected: Record<string, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  terms_required: 403,
  not_found: 404,
  conflict: 409,
  scan_pending: 409,
  scan_blocked: 403,
  quota_exceeded: 413,
  file_too_large: 413,
  ceiling_exceeded: 429,
  rate_limited: 429,
  invalid_token: 403,
  link_expired: 410,
  link_paused: 423,
  password_required: 403,
  admin_requires_2fa: 403,
  // (added with the session-level second factor: auth/second-factor.ts)
  second_factor_required: 403,
  second_factor_throttled: 429,
  read_only: 503,
  feature_disabled: 503,
  // (added with AVWARM: an avatar's scan waited out on a cold scanner, routes/uploads.ts)
  scanner_starting: 503,
  // (added with R1: a JSON body over its byte cap, services/body.ts; and the codes of the R1 fix
  // packages for account lifecycle, moderation and uploads)
  body_too_large: 413,
  deletion_admin_scheduled: 409,
  self_action: 400,
  last_admin: 409,
  not_quarantined: 409,
  replace_in_progress: 409,
  already_taken_down: 409,
  not_taken_down: 409,
  dmca_restore_only: 409,
};

describe("error status table", () => {
  it("maps exactly the 31 codes to their statuses", () => {
    expect(ERROR_STATUS).toEqual(expected);
  });

  it("uses 401 for a missing session and nothing else", () => {
    const codes = Object.entries(ERROR_STATUS)
      .filter(([, status]) => status === 401)
      .map(([code]) => code);
    expect(codes).toEqual(["unauthorized"]);
  });
});
