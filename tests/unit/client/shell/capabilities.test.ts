// What this browser can do, asked by the frame and the explorer alike (lib/capabilities).
import { afterEach, describe, expect, it } from "vitest";
import { canPickFolders } from "../../../../src/client/lib/capabilities";

const ua = navigator.userAgent;
const setUa = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });
const withPicker = () =>
  Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
    configurable: true,
    get: () => false,
    set: () => {},
  });

afterEach(() => {
  delete (HTMLInputElement.prototype as { webkitdirectory?: boolean }).webkitdirectory;
  setUa(ua);
});

describe("canPickFolders", () => {
  it("no webkitdirectory on the input: no", () => {
    expect("webkitdirectory" in HTMLInputElement.prototype).toBe(false);
    expect(canPickFolders()).toBe(false);
  });

  it("webkitdirectory present: yes", () => {
    withPicker();
    expect(canPickFolders()).toBe(true);
  });

  it("Samsung Internet: no, even with webkitdirectory (it hands back plain files)", () => {
    withPicker();
    setUa(
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    );
    expect(canPickFolders()).toBe(false);
  });
});
