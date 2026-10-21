// The remote modes of the e2e suite (tests/e2e/fixtures/remote.ts) and the skip verdict of a remote
// run (tests/e2e/fixtures/skip-reporter.ts), as pure functions. The real runs against a server the
// proof starts are in reports/T28-report.md (a remote run needs a browser and a server).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROD_SAFE, REMOTE_SESSION, remoteMode, remoteProjects, tagPattern } from "../../e2e/fixtures/remote";
import { skipReason, verdict } from "../../e2e/fixtures/skip-reporter";

const DEVICES = [
  { name: "chromium", use: { viewport: { width: 1280, height: 720 } } },
  { name: "mobile-chrome", use: { isMobile: true } },
];

describe("remoteMode", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("unset (every local run): null — and an empty value is unset", () => {
    expect(remoteMode({})).toBeNull();
    expect(remoteMode({ HOLDFAST_E2E_BASE_URL: "  " })).toBeNull();
  });

  it("the base URL is reduced to its origin; the files URL is optional", () => {
    expect(remoteMode({ HOLDFAST_E2E_BASE_URL: "https://holdfast-dev.example.test/some/path" })).toEqual({
      baseURL: "https://holdfast-dev.example.test",
      sessionFile: null,
      filesURL: null,
    });
    expect(
      remoteMode({
        HOLDFAST_E2E_BASE_URL: "http://localhost:7001",
        HOLDFAST_E2E_FILES_URL: "http://files.localhost:7001/",
      })?.filesURL,
    ).toBe("http://files.localhost:7001");
  });

  it("a half-set or malformed mode is an error, never a quiet local run", () => {
    expect(() => remoteMode({ HOLDFAST_E2E_SESSION_FILE: "/tmp/x.json" })).toThrow(
      /set HOLDFAST_E2E_BASE_URL too/,
    );
    expect(() => remoteMode({ HOLDFAST_E2E_FILES_URL: "https://files.example.test" })).toThrow(
      /BASE_URL too/,
    );
    expect(() => remoteMode({ HOLDFAST_E2E_BASE_URL: "holdfast-dev.example.test" })).toThrow(
      /absolute http\(s\) URL/,
    );
    expect(() => remoteMode({ HOLDFAST_E2E_BASE_URL: "ftp://example.test" })).toThrow(/http\(s\) URL/);
    expect(() =>
      remoteMode({
        HOLDFAST_E2E_BASE_URL: "https://example.test",
        HOLDFAST_E2E_SESSION_FILE: "/no/such/file.json",
      }),
    ).toThrow(/names no file/);
  });

  it("a session file that exists is taken", () => {
    dir = mkdtempSync(join(tmpdir(), "remote-mode-"));
    const file = join(dir, "session.json");
    writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
    expect(
      remoteMode({ HOLDFAST_E2E_BASE_URL: "https://example.test", HOLDFAST_E2E_SESSION_FILE: file })
        ?.sessionFile,
    ).toBe(file);
  });
});

describe("remoteProjects", () => {
  it("read-only: each device once, @prod-safe only, no storage state", () => {
    const projects = remoteProjects(
      { baseURL: "https://example.test", sessionFile: null, filesURL: null },
      DEVICES,
    );
    expect(projects.map((project) => project.name)).toEqual([
      "chromium-prod-safe",
      "mobile-chrome-prod-safe",
    ]);
    for (const project of projects) {
      expect(project.grep.test(`the footer links ${PROD_SAFE}`)).toBe(true);
      expect(project.grep.test(`a journey ${REMOTE_SESSION}`)).toBe(false);
      expect(project.grep.test("an untagged test")).toBe(false);
      expect(project.use).not.toHaveProperty("storageState");
    }
  });

  it("with a session file: the @remote-session projects get it, the @prod-safe ones never do", () => {
    const projects = remoteProjects(
      { baseURL: "https://example.test", sessionFile: "/tmp/session.json", filesURL: null },
      DEVICES,
    );
    expect(projects.map((project) => [project.name, project.use.storageState ?? null])).toEqual([
      ["chromium-prod-safe", null],
      ["mobile-chrome-prod-safe", null],
      ["chromium-remote-session", "/tmp/session.json"],
      ["mobile-chrome-remote-session", "/tmp/session.json"],
    ]);
    expect(projects[2]!.grep.test(`reads its own files ${REMOTE_SESSION}`)).toBe(true);
    expect(projects[2]!.grep.test(`the footer ${PROD_SAFE}`)).toBe(false);
  });

  it("a tag matches as a whole word only", () => {
    expect(tagPattern(PROD_SAFE).test("x @prod-safe")).toBe(true);
    expect(tagPattern(PROD_SAFE).test("x @prod-safe @a11y")).toBe(true);
    expect(tagPattern(PROD_SAFE).test("x @prod-safety")).toBe(false);
    expect(tagPattern(PROD_SAFE).test("x @prod-safe-ish")).toBe(false);
  });
});

describe("a remote run's skips", () => {
  it("the reason is the skip annotation's description (the result's first, then the test's)", () => {
    expect(
      skipReason({ annotations: [] }, { annotations: [{ type: "skip", description: " agent unset " }] }),
    ).toBe("agent unset");
    expect(
      skipReason({ annotations: [{ type: "skip", description: "static reason" }] }, { annotations: [] }),
    ).toBe("static reason");
    expect(skipReason({ annotations: [{ type: "skip" }] }, { annotations: [] })).toBe("");
  });

  it("every skip is printed with its reason; one without a reason fails the run", () => {
    expect(verdict([{ title: "dmca agent", reason: "agent details unset" }], false, 2)).toEqual({
      failed: false,
      lines: ["skipped: dmca agent — agent details unset"],
    });
    const unexplained = verdict([{ title: "x", reason: "" }], false, 1);
    expect(unexplained.failed).toBe(true);
    expect(unexplained.lines).toEqual([
      "skipped: x — (NO REASON GIVEN)",
      "1 skip(s) without a reason: the run fails",
    ]);
  });

  it("nothing passed — every test skipped, each with its reason, no flag — fails all the same (review m1)", () => {
    const allSkipped = verdict([{ title: "dmca agent", reason: "agent details unset" }], false, 0);
    expect(allSkipped.failed).toBe(true);
    expect(allSkipped.lines).toContain("no test passed: a remote run that checked nothing fails");
  });

  it("HOLDFAST_E2E_FAIL_ON_SKIP: any skip fails the run (a gate is never carried by a skip)", () => {
    expect(verdict([{ title: "dmca agent", reason: "agent details unset" }], true, 3).failed).toBe(true);
    expect(verdict([], true, 3).failed).toBe(false);
  });
});
