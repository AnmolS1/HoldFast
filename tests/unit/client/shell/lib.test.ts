// Small pure helpers: sizes, dates, the i18n catalogue, the shortcut map, Sentry wiring.
import { describe, expect, it, vi } from "vitest";
import { en } from "../../../../src/client/lib/en";
import {
  formatBytes,
  formatCountdown,
  formatDate,
  formatRelative,
  resolveTimeZone,
} from "../../../../src/client/lib/format";
import { t } from "../../../../src/client/lib/i18n";
import {
  initSentry,
  redactOrDrop,
  reportError,
  resetSentryForTests,
} from "../../../../src/client/lib/sentry";
import {
  isEditableTarget,
  matchShortcut,
  shortcutLabel,
  SHORTCUTS,
} from "../../../../src/client/lib/shortcuts";

// The real shared redaction, wrapped in a spy only so one test can make it throw.
vi.mock("../../../../src/shared/sentry-redact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/shared/sentry-redact")>();
  return { ...actual, redactEvent: vi.fn(actual.redactEvent) };
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1024, "1 KB"],
    [12 * 1024, "12 KB"],
    [626_688, "612 KB"],
    [2_516_582, "2.4 MB"],
    [193_147_699, "184.2 MB"],
    [1_503_238_553, "1.4 GB"],
    [5_368_709_120, "5 GB"],
    [2_000_000_000, "1.9 GB"],
    [1024 * 1024 * 1024 - 1, "1 GB"],
  ])("%d → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it("nothing sensible → an em dash", () => {
    for (const value of [null, undefined, -1, Number.NaN]) expect(formatBytes(value)).toBe("—");
  });
});

describe("dates", () => {
  const now = new Date("2026-10-08T12:00:00Z");

  it("uses the account's time zone", () => {
    const instant = "2026-10-02T03:30:00Z";
    expect(formatDate(instant, { timeZone: "UTC", now })).toBe("Oct 02");
    expect(formatDate(instant, { timeZone: "America/Chicago", now })).toBe("Oct 01");
    expect(formatDate(instant, { timeZone: "UTC", style: "long" })).toBe("October 2, 2026");
    expect(formatDate(instant, { timeZone: "UTC", style: "dateTime" })).toBe("Oct 02, 2026, 03:30");
  });

  it("adds the year when it is not this year", () => {
    expect(formatDate("2025-03-09T12:00:00Z", { timeZone: "UTC", now })).toBe("Mar 09, 2025");
  });

  it("an unknown zone falls back to the browser's instead of throwing", () => {
    expect(resolveTimeZone("Mars/Olympus")).toBeUndefined();
    expect(resolveTimeZone(null)).toBeUndefined();
    expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(() => formatDate("2026-10-02T03:30:00Z", { timeZone: "Mars/Olympus" })).not.toThrow();
  });

  it("relative time, then a date after a week", () => {
    expect(formatRelative(new Date(now.getTime() - 10_000), { now })).toBe("now");
    expect(formatRelative(new Date(now.getTime() - 3 * 60_000), { now })).toBe("3 minutes ago");
    expect(formatRelative(new Date(now.getTime() - 2 * 3_600_000), { now })).toBe("2 hours ago");
    expect(formatRelative(new Date(now.getTime() - 86_400_000), { now })).toBe("yesterday");
    expect(formatRelative("2026-09-14T12:00:00Z", { now, timeZone: "UTC" })).toBe("Sep 14");
    expect(formatRelative("not a date")).toBe("—");
  });

  it("countdown", () => {
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(41.2)).toBe("0:42");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});

describe("i18n", () => {
  it("fills holes and leaves an unknown hole visible", () => {
    expect(t("selection.count", { count: 3 })).toBe("3 selected");
    expect(t("storage.of", { used: "1.4 GB", quota: "5 GB" })).toBe("1.4 GB of 5 GB");
    expect(t("selection.count")).toBe("{count} selected");
  });

  it("voice: no exclamation marks, no all-caps labels, no emoji in the catalogue", () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toContain("!");
      expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
    }
  });

  it("the exact strings other tasks and the design quote", () => {
    expect(en["status.infected"]).toBe("Blocked — flagged by the malware scan");
    expect(en["signup.birth.note"]).toBe("Used once to check you're 13 or older; we don't keep it.");
    expect(en["banner.deletion.cancelled"]).toBe("Deletion cancelled.");
    expect(en["banner.deletion.started"]).toBe("Deletion has already started — contact support.");
    expect(en["toast.impersonationReadOnly"]).toBe("Read-only while impersonating");
    expect(en["banner.readOnly"]).toBe("Holdfast is read-only for maintenance.");
    expect(en["placeholder.shared.note"]).toBe("Shared files appear here once sharing is switched on.");
    expect(en["app.preparing"]).toBe("This page is being prepared.");
    expect(en["terms.title"]).toBe("We've updated the Terms and Privacy Policy.");
    expect(`${en["reauth.title"]} — ${en["reauth.body"].toLowerCase()}`).toBe(
      "Your session ended — sign in to continue.",
    );
  });
});

describe("shortcuts", () => {
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {},
  ) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

  it.each([
    ["/", {}, "search"],
    ["k", { ctrlKey: true }, "palette"],
    ["K", { ctrlKey: true }, "palette"],
    ["ArrowDown", {}, "next"],
    ["j", {}, "next"],
    ["ArrowUp", {}, "previous"],
    ["k", {}, "previous"],
    ["Enter", {}, "open"],
    [" ", {}, "quickLook"],
    ["a", { ctrlKey: true }, "selectAll"],
    ["Delete", {}, "trash"],
    ["Backspace", {}, "trash"],
    ["Escape", {}, "escape"],
    ["?", { shiftKey: true }, "help"],
    ["N", { shiftKey: true }, "newFolder"],
    ["F2", {}, "rename"],
  ] as const)("%j %j → %s (non-Apple)", (k, mods, id) => {
    expect(matchShortcut(key(k, mods), false)).toBe(id);
  });

  it("⌘ on Apple platforms, Ctrl elsewhere — never both", () => {
    expect(matchShortcut(key("k", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(key("k", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(key("k", { metaKey: true }), false)).toBeNull();
    expect(matchShortcut(key("n"), false)).toBeNull();
    expect(matchShortcut(key("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it("labels for menus", () => {
    expect(shortcutLabel("palette", true)).toBe("⌘K");
    expect(shortcutLabel("palette", false)).toBe("Ctrl+K");
    expect(shortcutLabel("newFolder", true)).toBe("⇧N");
    expect(shortcutLabel("help", true)).toBe("?");
    expect(shortcutLabel("trash", true)).toBe("Del");
    expect(shortcutLabel("escape", false)).toBe("Esc");
  });

  it("covers the whole keyboard map of the specification", () => {
    expect(SHORTCUTS.map((s) => s.id).sort()).toEqual([
      "escape",
      "help",
      "newFolder",
      "next",
      "open",
      "palette",
      "previous",
      "quickLook",
      "rename",
      "search",
      "selectAll",
      "theme",
      "trash",
      "upload",
    ]);
  });

  it("text fields are editable targets; checkboxes and buttons are not", () => {
    const make = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.firstElementChild as HTMLElement;
    };
    expect(isEditableTarget(make('<input type="text">'))).toBe(true);
    expect(isEditableTarget(make('<input type="search">'))).toBe(true);
    expect(isEditableTarget(make("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(make('<input type="checkbox">'))).toBe(false);
    expect(isEditableTarget(make("<button></button>"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("sentry", () => {
  const config = {
    sentryDsnWeb: "https://public@o0.ingest.example/1",
    sentryEnvironment: "test",
    release: "abc",
  };

  it("is not initialised (and the SDK is not even loaded) without a DSN", async () => {
    resetSentryForTests();
    const load = vi.fn();
    await expect(initSentry({ ...config, sentryDsnWeb: null }, load)).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("initialises once with the DSN, environment and release, and redacts events and breadcrumbs", async () => {
    resetSentryForTests();
    const init = vi.fn();
    const captureException = vi.fn();
    const load = vi.fn(async () => ({ init, captureException }) as never);
    await expect(initSentry(config, load)).resolves.toBe(true);
    await initSentry(config, load);
    expect(load).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]![0] as {
      dsn: string;
      environment: string;
      release: string;
      beforeSend(e: unknown): unknown;
      beforeBreadcrumb(b: unknown): unknown;
    };
    expect(options).toMatchObject({ dsn: config.sentryDsnWeb, environment: "test", release: "abc" });
    expect(options.beforeSend({ request: { url: "https://app.test/s/SECRETTOKEN" } })).toEqual({
      request: { url: "https://app.test/s/[redacted]" },
    });
    // Everything after the marker segment goes: the node id, the size and the bearer token.
    expect(options.beforeBreadcrumb({ data: { url: "https://files.test/t/n1/320/BEARER" } })).toEqual({
      data: { url: "https://files.test/t/[redacted]" },
    });
    // What the real redaction also covers: query tokens, cookies, emails.
    expect(
      options.beforeSend({
        request: {
          url: "https://app.test/reset-password?token=SECRET",
          headers: { cookie: "session=SECRET", accept: "text/html" },
        },
        message: "mail to ada@example.com failed",
      }),
    ).toEqual({
      request: { url: "https://app.test/reset-password?token=[redacted]", headers: { accept: "text/html" } },
      message: "mail to [email] failed",
    });
    reportError(new Error("x"), { where: "test" });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("when redaction throws the item is dropped, never sent raw", async () => {
    const redact = await import("../../../../src/shared/sentry-redact");
    vi.mocked(redact.redactEvent).mockImplementationOnce(() => {
      throw new Error("redaction failed");
    });
    expect(redactOrDrop({ request: { url: "https://app.test/s/SECRET" } })).toBeNull();
  });

  it("reportError never throws, initialised or not", () => {
    resetSentryForTests();
    expect(() => reportError(new Error("x"))).not.toThrow();
  });
});
