// scripts/verify-gate-b.sh's own checks, in `npm test`, with NO remote call (Common §1): its
// --self-test (every evaluator on made-up passing and failing input); --local-only never exits 0;
// and the whole gate on the FAKE runner (HOLDFAST_GATE_B_FAKE: every remote command's output comes
// from a fixture) — all green (exit 4, never 0), then each check made to fail on its own while every
// other check still passes. Every remote check must print exactly the command it ran, and no value
// a command printed that could be a secret (a secret's value, a connection password) is printed.
//
// Every fixture is made up: the structure of the real outputs, none of their content.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../..");
const SCRIPT = join(ROOT, "scripts/verify-gate-b.sh");
const SHA = "a".repeat(40);
// Made up, planted in the fake outputs to prove the gate never prints them.
const SECRET_VALUE = "made-up-secret-value-3f9c";
const DB_PASSWORD = "made-up-db-password-71ad";

const LOCAL_IDS = [
  "legal-files",
  "dmca-agent-page",
  "dmca-registered",
  "dmca-procedure",
  "csam-procedure",
  "ncmec-requested",
  "residual-risks",
];
const REMOTE_IDS = [
  "ponderance-pages",
  "stamp",
  "health",
  "files-host",
  "secrets",
  "hyperdrive",
  "r2-rule",
  "headers",
  "prod-safe-e2e",
  "backup-manifest",
  "ci-run",
];
const TEN = [
  "BETTER_AUTH_SECRET",
  "FILES_TOKEN_SECRET",
  "IP_ENC_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "TURNSTILE_SECRET",
  "SENTRY_DSN",
  "ADMIN_EMAILS",
  "CF_ANALYTICS_TOKEN",
];

const scratch = mkdtempSync(join(tmpdir(), "gate-b-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A complete plan directory and agent file, as Anmol will leave them (made-up names and dates). */
function completePlan(dir: string) {
  mkdirSync(join(dir, "legal"), { recursive: true });
  writeFileSync(
    join(dir, "legal/gate-b-legal.md"),
    "| 2 | agent | HUMAN | DONE | registered 2026-10-01, renewal 2029-10-01 |\n| 6 | NCMEC | HUMAN | DONE | NCMEC ESP requested 2026-10-02 |\n",
  );
  writeFileSync(
    join(dir, "legal/residual-risks.md"),
    "| # | Risk | Source | Date | Initials |\n|---|---|---|---|---|\n| 1 | A made-up risk. | X | 2026-10-03 | AB |\n\nCompleted by: A. Person on: 2026-10-03\n",
  );
  for (const name of ["csam-procedure", "dmca-procedure"]) {
    writeFileSync(join(dir, `legal/${name}.md`), "# A procedure (v1)\n\nAdopted: 2026-10-03 AB\n");
  }
  writeFileSync(
    join(dir, "gate-b-report.md"),
    "probe key: u/_probe/gate-b-20261003T101500Z\nprobe first invocation: 4.2 s\nprobe control invocations: 0\n",
  );
  const agent = join(dir, "agent.ts");
  writeFileSync(agent, 'export const AGENT = {\n  name: "A. Person",\n  email: "agent@example.test",\n};\n');
  return agent;
}

function headersFor(host: string, label: string, app: string, files: string): string {
  const snapshot = JSON.parse(
    readFileSync(join(ROOT, "tests/unit/security/__snapshots__/headers.json"), "utf8"),
  );
  const want = snapshot[host][label] as { status: number; headers: Record<string, string> };
  const lines = [`HTTP/2 ${want.status}`, "date: Sat, 03 Oct 2026 10:00:00 GMT", "server: cloudflare"];
  for (const [name, value] of Object.entries(want.headers)) {
    lines.push(
      `${name}: ${value
        .replaceAll("<NONCE>", "Ab3dE5gH7jK9mN1pQ2rS4t==")
        .replaceAll("<FILES_ORIGIN>", files)
        .replaceAll("<APP_ORIGIN>", app)
        .replaceAll("<SENTRY_ORIGIN>", "https://o1.ingest.us.sentry.io")
        .replaceAll("<validator>", '"v1"')}`,
    );
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** Every remote command's output, all passing, for `env`. */
function passingFakes(dir: string, env: "dev" | "production") {
  mkdirSync(dir, { recursive: true });
  const app =
    env === "production" ? "https://holdfast.ponderance.dev" : "https://holdfast-dev.ponderance.dev";
  const files =
    env === "production" ? "https://holdfastusercontent.com" : "https://dev.holdfastusercontent.com";
  const queue = env === "production" ? "holdfast-scan" : "holdfast-scan-dev";
  const branch = env === "production" ? "prod" : "dev";
  const put = (key: string, text: string) => writeFileSync(join(dir, key), text);
  for (const page of ["privacy", "terms", "support"]) put(`ponderance-${page}.out`, "<p>Holdfast</p>\n");
  put("branch-head.out", `${SHA}\trefs/heads/${branch}\n`);
  put("meta.out", JSON.stringify({ project: "holdfast", commit: SHA }));
  put("health.out", JSON.stringify({ ok: true, db: true, config: true }));
  put("files-host.out", "HTTP/2 404\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n");
  // A list whose entries carry a planted value field: whatever wrangler printed, only names are read.
  put(
    "secrets.out",
    ` ⛅️ wrangler\n${JSON.stringify(TEN.map((name) => ({ name, type: "secret_text", value: SECRET_VALUE })))}\n`,
  );
  for (const which of ["dev", "production"]) {
    put(
      `hyperdrive-${which}.out`,
      JSON.stringify({
        id: "x",
        origin: { host: "db.example.test", user: "u", password: DB_PASSWORD },
        caching: { disabled: true },
      }),
    );
  }
  put(
    "r2-rule.out",
    `Fetching notification rules for bucket b...\nrule_id:     r-1\ncreated_at:  2026-10-01T00:00:00Z\nqueue_name:  ${queue}\nprefix:      u/\nsuffix:      (all suffixes)\nevent_type:  PutObject,CompleteMultipartUpload,CopyObject\n`,
  );
  const app2 = "app host, https (a deploy)";
  const files2 = "files host, https (a deploy)";
  put("headers-app-root.out", headersFor(app2, "GET /", app, files));
  put("headers-app-health.out", headersFor(app2, "GET /api/health", app, files));
  put("headers-app-share.out", headersFor(app2, "GET /s/x", app, files));
  put("headers-files-root.out", headersFor(files2, "GET / (404)", app, files));
  put("headers-files-d.out", headersFor(files2, "GET /d/… refused (403)", app, files));
  put("prod-safe.out", "  8 passed (20s)\n");
  put("prod-safe.writes", JSON.stringify({ stats: { expected: 8, unexpected: 0, skipped: 0, flaky: 0 } }));
  const meta = join(ROOT, "drizzle/meta");
  const snapshot = readdirSync(meta)
    .filter((name) => name.endsWith("_snapshot.json"))
    .sort()
    .at(-1)!;
  const tables = Object.values(
    JSON.parse(readFileSync(join(meta, snapshot), "utf8")).tables as Record<string, { name: string }>,
  ).map(({ name }) => ({ name, rows: 0 }));
  put("manifest-0.out", JSON.stringify({ tables }));
  put("manifest-1.out", JSON.stringify({ tables }));
  put(
    "ci-runs.out",
    JSON.stringify([{ headSha: SHA, status: "completed", conclusion: "success", databaseId: 7 }]),
  );
  return { tables };
}

let counter = 0;
function setup(env: "dev" | "production") {
  const base = join(scratch, `case-${counter++}`);
  const agent = completePlan(join(base, "plan"));
  const fakes = join(base, "fake");
  const { tables } = passingFakes(fakes, env);
  const gate = () =>
    run([...(env === "production" ? ["--prod"] : []), "--plan", join(base, "plan"), "--agent-file", agent], {
      HOLDFAST_GATE_B_FAKE: fakes,
    });
  return {
    base,
    fakes,
    tables,
    gate,
    put: (key: string, text: string) => writeFileSync(join(fakes, key), text),
  };
}

const verdicts = (out: string) =>
  Object.fromEntries([...out.matchAll(/^(PASS|FAIL) {2}(\S+)/gm)].map((m) => [m[2]!, m[1]!]));

/** The `ran:` lines printed under one check's verdict. */
function ranUnder(out: string, id: string): string[] {
  const lines = out.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^(PASS|FAIL) {2}${id} `).test(line));
  const ran: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^(PASS|FAIL) {2}/.test(line) || line.startsWith("──")) break;
    const m = /^ {6}ran: (.*)$/.exec(line);
    if (m) ran.push(m[1]!);
  }
  return ran;
}

describe("verify-gate-b.sh", () => {
  it("--self-test: every evaluator gives the right verdict", () => {
    const { status, out } = run(["--self-test"]);
    expect(out).not.toContain("WRONG");
    expect(out).toContain("verify-gate-b --self-test: OK");
    expect(status).toBe(0);
  }, 120_000);

  it("--local-only on an empty plan directory: every legal check fails by name, never exit 0", () => {
    const plan = mkdtempSync(join(scratch, "empty-plan-"));
    const { status, out } = run(["--local-only", "--plan", plan]);
    expect(status).toBe(1);
    for (const id of LOCAL_IDS.filter((id) => id !== "dmca-agent-page")) {
      expect(out).toMatch(new RegExp(`^FAIL  ${id} `, "m"));
    }
  }, 120_000);
});

describe("the gate on the fake runner (no remote call)", () => {
  it("dev, everything in order: all 18 checks PASS — exit 4 (faked outputs are never a gate result)", () => {
    const { gate } = setup("dev");
    const { status, out } = gate();
    expect(out).toContain("FAKE RUNNER");
    const seen = verdicts(out);
    expect(Object.keys(seen).sort()).toEqual([...LOCAL_IDS, ...REMOTE_IDS].sort());
    expect(
      Object.values(seen).every((v) => v === "PASS"),
      out,
    ).toBe(true);
    expect(out).toContain("every check passed ON FAKED OUTPUTS — 18 of 18");
    expect(status).toBe(4);
  }, 120_000);

  it("every remote check prints exactly the command it ran", () => {
    const { gate } = setup("dev");
    const { out } = gate();
    expect(ranUnder(out, "ponderance-pages")).toEqual([
      "curl -fsS --max-time 20 https://ponderance.dev/privacy",
      "curl -fsS --max-time 20 https://ponderance.dev/terms",
      "curl -fsS --max-time 20 https://ponderance.dev/support/holdfast",
    ]);
    expect(ranUnder(out, "stamp")).toEqual([
      "git ls-remote origin refs/heads/dev",
      "curl -sS --max-time 15 -H cache-control:\\ no-cache https://holdfast-dev.ponderance.dev/__meta",
    ]);
    expect(ranUnder(out, "health")).toEqual([
      "curl -sS --max-time 15 https://holdfast-dev.ponderance.dev/api/health",
    ]);
    expect(ranUnder(out, "files-host")).toEqual([
      "curl -sS --max-time 15 -D - -o /dev/null https://dev.holdfastusercontent.com/",
    ]);
    expect(ranUnder(out, "secrets")).toEqual(["npx wrangler secret list --name holdfast-dev --format json"]);
    expect(ranUnder(out, "hyperdrive")).toEqual([
      "npx wrangler hyperdrive get 097127f66b124f61abf6e7f5d26925ec",
    ]);
    expect(ranUnder(out, "r2-rule")).toEqual(["npx wrangler r2 bucket notification list holdfast-files-dev"]);
    expect(ranUnder(out, "headers")).toHaveLength(5);
    expect(ranUnder(out, "prod-safe-e2e")).toHaveLength(1);
    expect(ranUnder(out, "prod-safe-e2e")[0]).toMatch(
      /^env HOLDFAST_E2E_BASE_URL=https:\/\/holdfast-dev\.ponderance\.dev HOLDFAST_E2E_FAIL_ON_SKIP=1 .* npx playwright test --grep @prod-safe /,
    );
    expect(ranUnder(out, "backup-manifest")).toEqual([
      expect.stringMatching(
        /^npx wrangler r2 object get holdfast-files-dev\/b\/db\/\d{4}-\d{2}-\d{2}\/_manifest\.json --remote --pipe$/,
      ),
    ]);
    expect(ranUnder(out, "ci-run")).toEqual([
      "git ls-remote origin refs/heads/dev",
      "gh run list --workflow deploy-dev.yml --branch dev --limit 40 --json headSha\\,status\\,conclusion\\,databaseId",
    ]);
    // The local checks run no command.
    for (const id of LOCAL_IDS) expect(ranUnder(out, id), id).toEqual([]);
  }, 120_000);

  it("never prints a secret value or a connection password that a command printed; secrets are listed by name only", () => {
    const { gate } = setup("production");
    const { out } = gate();
    expect(out).not.toContain(SECRET_VALUE);
    expect(out).not.toContain(DB_PASSWORD);
    expect(out).not.toContain("db.example.test");
    expect(out).toMatch(/^PASS {2}secrets .* holdfast: all ten names present \(10 listed\)$/m);
    expect(ranUnder(out, "secrets")).toEqual(["npx wrangler secret list --name holdfast --format json"]);
  }, 120_000);

  it("production: 19 checks — the R2 probe's evidence, and BOTH Hyperdrive configs", () => {
    const { gate } = setup("production");
    const { status, out } = gate();
    const seen = verdicts(out);
    expect(Object.keys(seen).sort()).toEqual([...LOCAL_IDS, ...REMOTE_IDS, "r2-probe"].sort());
    expect(
      Object.values(seen).every((v) => v === "PASS"),
      out,
    ).toBe(true);
    expect(ranUnder(out, "hyperdrive")).toEqual([
      "npx wrangler hyperdrive get e899309ce0d543bb99bd09fa582aac90",
      "npx wrangler hyperdrive get 097127f66b124f61abf6e7f5d26925ec",
    ]);
    expect(ranUnder(out, "ci-run")[1]).toContain("--workflow deploy-prod.yml --branch prod");
    expect(status).toBe(4);
  }, 120_000);

  // Each check made to fail on its own: it FAILs with its reason, every other check still PASSes.
  const breaks: Array<[string, (c: ReturnType<typeof setup>) => void, RegExp]> = [
    ["ponderance-pages", (c) => c.put("ponderance-terms.out", "<p>Other</p>\n"), /terms:no-Holdfast/],
    [
      "stamp",
      (c) => c.put("meta.out", JSON.stringify({ project: "holdfast", commit: "b".repeat(40) })),
      /deployed commit 'b{40}' != origin\/dev/,
    ],
    ["health", (c) => c.put("health.out", JSON.stringify({ ok: true, config: false })), /config='false'/],
    [
      "files-host",
      (c) => c.put("files-host.out", "HTTP/2 200\r\ncontent-type: text/html\r\n\r\n"),
      /answered 200, content-type 'text\/html'/,
    ],
    [
      "secrets",
      (c) =>
        c.put("secrets.out", JSON.stringify(TEN.slice(0, 9).map((name) => ({ name, type: "secret_text" })))),
      /missing: CF_ANALYTICS_TOKEN/,
    ],
    [
      "hyperdrive",
      (c) => c.put("hyperdrive-dev.out", JSON.stringify({ id: "x", caching: { disabled: false } })),
      /caching\.disabled is 'false'/,
    ],
    [
      "r2-rule",
      (c) =>
        c.put(
          "r2-rule.out",
          "rule_id: r-1\nqueue_name: holdfast-scan-dev\nprefix: (all prefixes)\nsuffix: (all suffixes)\nevent_type: PutObject\n",
        ),
      /1 rule\(s\) listed, 0 of them object-create on prefix u\//,
    ],
    [
      "headers",
      (c) => {
        const file = join(c.fakes, "headers-app-root.out");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace("x-frame-options: DENY", "x-frame-options: SAMEORIGIN"),
        );
      },
      /difference\(s\)/,
    ],
    [
      "prod-safe-e2e",
      (c) => {
        c.put(
          "prod-safe.writes",
          JSON.stringify({ stats: { expected: 7, unexpected: 0, skipped: 1, flaky: 0 } }),
        );
        c.put("prod-safe.rc", "1");
      },
      /7 passed, 0 failed, 1 skipped/,
    ],
    [
      "backup-manifest",
      (c) => c.put("manifest-0.out", JSON.stringify({ tables: c.tables.slice(1) })),
      /lacks table\(s\)/,
    ],
    [
      "ci-run",
      (c) =>
        c.put(
          "ci-runs.out",
          JSON.stringify([{ headSha: SHA, status: "completed", conclusion: "failure", databaseId: 9 }]),
        ),
      /conclusion='failure'/,
    ],
  ];

  it.each(breaks)(
    "%s fails on its own, with its reason; every other check passes",
    (id, breakIt, reason) => {
      const c = setup("dev");
      breakIt(c);
      const { status, out } = c.gate();
      const seen = verdicts(out);
      expect(seen[id], out).toBe("FAIL");
      expect(out.split("\n").find((line) => line.startsWith(`FAIL  ${id} `))! + out).toMatch(reason);
      for (const other of [...LOCAL_IDS, ...REMOTE_IDS].filter((x) => x !== id))
        expect(seen[other], other).toBe("PASS");
      expect(out).toMatch(
        new RegExp(`GATE B \\(dev\\): FAIL — 1 of 18 checks failed \\(18 expected\\): ${id}$`, "m"),
      );
      expect(status).toBe(1);
    },
    120_000,
  );

  it("a command that fails or a fixture that is missing is a FAIL, never a pass", () => {
    const c = setup("dev");
    c.put("secrets.out", "");
    c.put("secrets.rc", "1");
    rmSync(join(c.fakes, "branch-head.out"));
    const { status, out } = c.gate();
    const seen = verdicts(out);
    expect(seen.secrets).toBe("FAIL");
    expect(out).toMatch(/^FAIL {2}secrets .* the secret list is empty or could not be read$/m);
    // No head of origin/dev: both checks that compare against it fail.
    expect([seen.stamp, seen["ci-run"]]).toEqual(["FAIL", "FAIL"]);
    expect(out).toContain("could not read the head of origin/dev");
    expect(status).toBe(1);
  }, 120_000);

  it("the probe's evidence missing fails --prod (r2-probe)", () => {
    const c = setup("production");
    writeFileSync(join(c.base, "plan/gate-b-report.md"), "probe key: u/_probe/gate-b-20261003T101500Z\n");
    const { status, out } = c.gate();
    expect(verdicts(out)["r2-probe"]).toBe("FAIL");
    expect(status).toBe(1);
  }, 120_000);
});
