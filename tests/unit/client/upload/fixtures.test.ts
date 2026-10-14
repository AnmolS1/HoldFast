// The stand-in sessions must never be past their end on the day the tests run: a fixed expiry a
// day after the fixtures were written dropped every restored row as expired once that day came
// (resume, fix2, minors, edge-cases went red on every tree at 2026-10-14 09:00 UTC).
import { describe, expect, it } from "vitest";
import { EXPIRES, initResponse, uploadSession } from "./fixtures";

const YEAR_MS = 365 * 24 * 3_600_000;

describe("the upload fixtures", () => {
  it("end their sessions far from today, whatever today is", () => {
    for (const expiresAt of [EXPIRES, initResponse(10).expiresAt, uploadSession().expiresAt]) {
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(YEAR_MS);
    }
  });
});
