// Intl formatters are built once per locale, zone and options and reused: a list draws a date per
// row, and building a formatter costs far more than using one. The key holds the locale and the
// zone, so a formatter made for one is never used for another.
import { describe, expect, it, vi } from "vitest";
import { dateTimeFormat, formatDate, resolveTimeZone } from "../../../../src/client/lib/format";

const instant = new Date("2026-10-02T03:30:00Z");
const now = new Date("2026-10-05T12:00:00Z");

describe("formatter cache", () => {
  it("the same locale and options give the same instance", () => {
    const options = { timeZone: "UTC", month: "short", day: "2-digit" } as const;
    expect(dateTimeFormat("en", options)).toBe(dateTimeFormat("en", { ...options }));
  });

  it("another locale, another zone or other options each get their own", () => {
    const base = dateTimeFormat("en", { timeZone: "UTC", month: "long" });
    const otherLocale = dateTimeFormat("de", { timeZone: "UTC", month: "long" });
    const otherZone = dateTimeFormat("en", { timeZone: "America/Chicago", month: "long" });
    const otherOptions = dateTimeFormat("en", { timeZone: "UTC", month: "short" });
    expect(new Set([base, otherLocale, otherZone, otherOptions]).size).toBe(4);
    expect(otherLocale.format(instant)).toBe("Oktober");
    expect(base.format(instant)).toBe("October");
  });

  it("a change of zone between two calls is honoured (no formatter of the first zone is reused)", () => {
    expect(formatDate(instant, { timeZone: "UTC", now })).toBe("Oct 02");
    expect(formatDate(instant, { timeZone: "America/Chicago", now })).toBe("Oct 01");
    expect(formatDate(instant, { timeZone: "UTC", now })).toBe("Oct 02");
  });

  it("drawing a date many times builds no new formatter after the first", () => {
    formatDate(instant, { timeZone: "Asia/Tokyo", now });
    const built = vi.spyOn(Intl, "DateTimeFormat");
    for (let row = 0; row < 200; row += 1) formatDate(instant, { timeZone: "Asia/Tokyo", now });
    expect(built).not.toHaveBeenCalled();
    built.mockRestore();
  });

  it("a zone is checked once; an unknown one stays unknown", () => {
    expect(resolveTimeZone("Mars/Olympus")).toBeUndefined();
    const built = vi.spyOn(Intl, "DateTimeFormat");
    expect(resolveTimeZone("Mars/Olympus")).toBeUndefined();
    expect(resolveTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(built).not.toHaveBeenCalled();
    built.mockRestore();
  });
});
