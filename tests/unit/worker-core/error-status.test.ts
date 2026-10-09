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
  read_only: 503,
  feature_disabled: 503,
};

describe("error status table", () => {
  it("maps exactly the 19 codes to their statuses", () => {
    expect(ERROR_STATUS).toEqual(expected);
  });

  it("uses 401 for a missing session and nothing else", () => {
    const codes = Object.entries(ERROR_STATUS)
      .filter(([, status]) => status === 401)
      .map(([code]) => code);
    expect(codes).toEqual(["unauthorized"]);
  });
});
