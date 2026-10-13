// A feature's own catalogue (`features/<name>/strings.ts`) through `defineMessages`.
import { afterEach, describe, expect, it } from "vitest";
import { defineMessages, setLocale, t } from "../../../../src/client/lib/i18n";

const tx = defineMessages({
  "trash.count": "{count} items",
  "trash.empty": "Trash is empty",
  "storage.of": "{used} of {quota}, feature text",
});

afterEach(() => setLocale("en"));

describe("defineMessages", () => {
  it("looks a feature's string up and fills holes exactly as t does", () => {
    expect(tx("trash.empty")).toBe("Trash is empty");
    expect(tx("trash.count", { count: 12 })).toBe("12 items");
    // An unknown hole is left visible, never dropped; a missing params object changes nothing.
    expect(tx("trash.count", { total: 12 })).toBe("{count} items");
    expect(tx("trash.count")).toBe("{count} items");
    // An inherited property is not a parameter.
    expect(tx("trash.count", Object.create({ count: 3 }) as Record<string, number>)).toBe("{count} items");
  });

  it("a feature's key never reads the shell catalogue, and the shell's t is unchanged", () => {
    expect(tx("storage.of", { used: "1 GB", quota: "5 GB" })).toBe("1 GB of 5 GB, feature text");
    expect(t("storage.of", { used: "1 GB", quota: "5 GB" })).toBe("1 GB of 5 GB");
  });

  it("only the catalogue's own keys are accepted (checked by tsc)", () => {
    // @ts-expect-error -- not a key of this catalogue
    expect(tx("nav.files")).toBeUndefined();
    // @ts-expect-error -- a feature key is not a shell key
    expect(() => t("trash.empty")).not.toThrow();
  });

  it("follows the locale: a translation of the same keys is used, English where there is none", () => {
    // No second locale exists in v1, so one is forced in here to show where it would plug in.
    const translated = defineMessages({ hello: "Hello {name}", bye: "Goodbye" }, {
      xx: { hello: "Salut {name}", bye: "Au revoir" },
    } as never);
    expect(translated("hello", { name: "Ada" })).toBe("Hello Ada");
    setLocale("xx" as never);
    expect(translated("hello", { name: "Ada" })).toBe("Salut Ada");
    expect(tx("trash.empty")).toBe("Trash is empty");
  });
});
