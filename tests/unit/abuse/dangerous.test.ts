// The decision table over `dangerousForPublicLink` (Worker code, services/mime.ts — T13/T24 own
// it; the SPA only sees the `dangerous` flag it yields). Extensions, sniffed types and names that
// hide their extension. The client half is tests/unit/client/abuse/interstitial.test.tsx.
import { describe, expect, it } from "vitest";
import { dangerousForPublicLink } from "../../../src/worker/services/mime";

describe("dangerousForPublicLink", () => {
  it.each([
    ["setup.exe", null],
    ["INSTALL.MSI", null],
    ["app.dmg", null],
    ["pkg.pkg", null],
    ["screen.scr", null],
    ["run.bat", null],
    ["run.cmd", null],
    ["old.com", null],
    ["script.ps1", null],
    ["script.sh", null],
    ["lib.jar", null],
    ["app.apk", null],
    ["app.ipa", null],
    ["macro.vbs", null],
    ["code.js", null],
    ["code.jse", null],
    ["host.wsf", null],
    ["page.hta", null],
    ["short.lnk", null],
    ["keys.reg", null],
    ["disk.iso", null],
    ["disk.img", null],
    ["trailing.exe. ", null],
  ])("by name: %s is dangerous", (name, sniffed) => {
    expect(dangerousForPublicLink(name, sniffed)).toBe(true);
  });

  it.each([
    ["photo.jpg", "application/x-msdownload"],
    ["readme.txt", "application/x-elf"],
    ["notes", "application/x-mach-binary"],
    ["image.png", "application/x-apple-diskimage"],
    ["data.bin", "application/x-iso9660-image"],
    ["thing.zip", "application/vnd.android.package-archive"],
    ["thing.zip", "application/java-archive"],
    ["file", "APPLICATION/X-MSDOWNLOAD"],
  ])("by sniffed type, whatever the name: %s as %s is dangerous", (name, sniffed) => {
    expect(dangerousForPublicLink(name, sniffed)).toBe(true);
  });

  it("a name that hides its extension with bidi controls is dangerous whatever it shows", () => {
    expect(dangerousForPublicLink("invoice‮txt.exe", "text/plain")).toBe(true);
    expect(dangerousForPublicLink("photo⁦.jpg", "image/jpeg")).toBe(true);
  });

  it.each([
    ["photo.jpg", "image/jpeg"],
    ["report.pdf", "application/pdf"],
    ["notes.txt", "text/plain"],
    ["archive.zip", "application/zip"],
    ["exe.txt", "text/plain"],
    ["noext", null],
  ])("control: %s (%s) is not", (name, sniffed) => {
    expect(dangerousForPublicLink(name, sniffed)).toBe(false);
  });
});
