// Open redirect (T26 item 15): `?next=` on login (routes/auth/validation.ts `safeNext`, used by
// Login.tsx) is honoured only as a same-origin path. T08's table (shell/guards.test.tsx) covers the
// plain forms; this one adds the ENCODED and dot-segment forms, and checks the property that
// matters for every one of them: what comes back, resolved the way the router and the browser
// resolve it, is on this origin and is not a protocol-relative or scheme URL.
import { describe, expect, it } from "vitest";
import { safeNext } from "../../../../src/client/routes/auth";

const ORIGIN = "http://localhost:3000";

const HOSTILE = [
  // Resolve to another host after dot-segment removal: the path itself becomes "//evil...".
  "/.//evil.example",
  "/..//evil.example",
  "/a/..//evil.example",
  "/./..//evil.example/x",
  "/%2E%2E//evil.example",
  "/%2e/%2e%2e//evil.example",
  // Scheme and protocol-relative forms, upper case and with whitespace browsers strip.
  "HTTPS://evil.example",
  "//EVIL.example",
  "/\u0009/evil.example",
  "/\u000B/evil.example",
  " //evil.example",
  "JaVaScRiPt:alert(1)",
  "vbscript:x",
  "%2F%2Fevil.example",
  "%5C%5Cevil.example",
];

const STAY = [
  // Encoded separators are path characters, never a host: they stay on this origin.
  ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
  ["/%2f%2fevil.example", "/%2f%2fevil.example"],
  ["/%5C%5Cevil.example", "/%5C%5Cevil.example"],
  ["/%252F%252Fevil.example", "/%252F%252Fevil.example"],
  ["/%09/evil.example", "/%09/evil.example"],
  ["/folder?next=//evil.example", "/folder?next=//evil.example"],
  ["/folder#//evil.example", "/folder#//evil.example"],
] as const;

describe("safeNext: encoded and dot-segment forms", () => {
  it.each(HOSTILE)("%j -> /", (raw) => {
    expect(safeNext(raw, ORIGIN)).toBe("/");
  });

  it.each(STAY)("%j stays a path on this origin: %j", (raw, expected) => {
    expect(safeNext(raw, ORIGIN)).toBe(expected);
  });

  it("whatever comes back is a single-slash path that resolves to this origin", () => {
    for (const raw of [...HOSTILE, ...STAY.map(([value]) => value)]) {
      const next = safeNext(raw, ORIGIN);
      expect(next.startsWith("/"), raw).toBe(true);
      expect(next.startsWith("//"), raw).toBe(false);
      expect(next).not.toMatch(/\\/);
      expect(new URL(next, ORIGIN).origin, raw).toBe(ORIGIN);
    }
  });
});
