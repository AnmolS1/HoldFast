// scripts/create-session.ts — the tool that writes a signed-in session straight into a database.
//   T10: which database it may touch (`classifyTarget`) and where it may write the cookie
//        (`outsideRepo`) — the refusals were untested;
//   T20: WHICH USER it may touch — only one it made itself. Run as a person runs it: a child
//        process, against this checkout's local database.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { classifyTarget, isSeedAddress, outsideRepo } from "../../../../scripts/lib/session-target";
import { localDbUrl } from "../../../setup/local-env";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("classifyTarget: every database that is not on this machine is presumed to be production", () => {
  const HOSTED = "postgres://user:pw@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb";

  it.each(["localhost", "127.0.0.1", "[::1]"])("%s is local, and its URL is left as it is", (host) => {
    const found = classifyTarget(`postgres://postgres:postgres@${host}:5432/holdfast`, {});
    expect(found.target).toBe("local");
    expect(found.url).not.toContain("sslmode");
  });

  it("a hosted database is refused with no flag — and the refusal says why, without the URL's credentials", () => {
    expect(() => classifyTarget(HOSTED, {})).toThrow(/presumed to be\s+PRODUCTION/);
    try {
      classifyTarget(HOSTED, {});
    } catch (error) {
      expect(String(error)).not.toContain("user:pw");
      expect(String(error)).not.toContain("postgres://");
    }
  });

  it("--non-prod-host must be exactly the URL's host; a different name, a substring or a suffix is refused", () => {
    const host = "ep-cool-name-123.eu-central-1.aws.neon.tech";
    expect(classifyTarget(HOSTED, { nonProdHost: host }).target).toBe("non-prod");
    expect(classifyTarget(HOSTED, { nonProdHost: ` ${host.toUpperCase()} ` }).target).toBe("non-prod");
    for (const wrong of [
      "",
      "neon.tech",
      "ep-cool-name-123",
      `x${host}`,
      `${host}.evil.example`,
      "localhost",
    ]) {
      expect(() => classifyTarget(HOSTED, { nonProdHost: wrong }), wrong).toThrow(/refusing/);
    }
  });

  it("--i-know-this-is-prod is the only way to production; a hosted target is asked for full certificate verification", () => {
    const prod = classifyTarget(HOSTED, { iKnowThisIsProd: true });
    expect(prod.target).toBe("prod");
    expect(new URL(prod.url).searchParams.get("sslmode")).toBe("verify-full");
    expect(
      new URL(classifyTarget(`${HOSTED}?sslmode=disable`, { iKnowThisIsProd: true }).url).searchParams.get(
        "sslmode",
      ),
    ).toBe("verify-full");
  });

  it("a look-alike of a local name is not local", () => {
    for (const host of [
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "[::ffff:127.0.0.1]",
      "127.0.0.2",
      "0.0.0.0",
    ]) {
      expect(() => classifyTarget(`postgres://u:p@${host}:5432/x`, {}), host).toThrow(/refusing/);
    }
  });

  it("no URL, not a URL, not postgres: refused before anything else", () => {
    expect(() => classifyTarget(undefined, {})).toThrow(/not set/);
    expect(() => classifyTarget("", {})).toThrow(/not set/);
    expect(() => classifyTarget("not a url", {})).toThrow(/not a URL/);
    expect(() => classifyTarget("https://localhost/x", {})).toThrow(/not a postgres URL/);
    expect(() => classifyTarget("mysql://localhost/x", {})).toThrow(/not a postgres URL/);
  });
});

describe("outsideRepo: the cookie file never lands in the repository", () => {
  it("refuses the repository root, anything under it, and a relative path (which is under it)", () => {
    for (const out of [
      root,
      join(root, "session.json"),
      join(root, "tmp", "deep", "session.json"),
      "session.json",
      "./x/../session.json",
    ]) {
      expect(() => outsideRepo(out, [root.replace(/\/$/, "")]), out).toThrow(/OUTSIDE the repository/);
    }
  });

  it("accepts a path outside every root — and refuses one under ANY of several roots (a worktree and its main checkout)", () => {
    const dir = mkdtempSync(join(tmpdir(), "holdfast-out-"));
    expect(outsideRepo(join(dir, "session.json"), [root.replace(/\/$/, "")])).toBe(join(dir, "session.json"));
    expect(() => outsideRepo(join(dir, "session.json"), ["/somewhere/else", dir])).toThrow(/OUTSIDE/);
    // A sibling whose name merely starts with the root's is outside it.
    expect(outsideRepo(`${dir}-sibling/session.json`, [dir])).toBe(`${dir}-sibling/session.json`);
  });
});

describe("isSeedAddress: the only addresses the script makes users for", () => {
  it.each([
    "remote-spec@holdfast.ponderance.dev",
    "remote-spec+admin@holdfast.ponderance.dev",
    "remote-spec-1760000000000@holdfast-e2e.example",
    "remote-spec.a@x.y.test",
  ])("%s", (email) => expect(isSeedAddress(email)).toBe(true));

  it.each([
    "anmol@holdfast.ponderance.dev",
    "remote-spec@gmail.com",
    "remote-spec@ponderance.dev",
    "xremote-spec@holdfast.ponderance.dev",
    "remote-spec@holdfast.ponderance.dev.evil.com",
    "remote-spec@example",
    "remote-spec@evil.example.com",
    "Remote-Spec@holdfast.ponderance.dev",
  ])("%s is not", (email) => expect(isSeedAddress(email)).toBe(false));
});

// ── the script itself, against the local database ───────────────────────────────────────────

async function script(args: string[]) {
  const env = {
    ...process.env,
    DATABASE_URL_DIRECT: localDbUrl(),
    // Signs the cookie of a throwaway user in the local test database: not anybody's secret.
    BETTER_AUTH_SECRET: "create-session-test-secret-0123456789abcdef",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  };
  try {
    const done = await run("npx", ["tsx", "scripts/create-session.ts", ...args], { cwd: root, env });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: localDbUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

describe("scripts/create-session.ts touches only a user it made (T20)", () => {
  const tag = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const outDir = mkdtempSync(join(tmpdir(), "holdfast-session-"));
  const out = join(outDir, "session.json");
  const base = ["--origin", "http://localhost:5173", "--out", out];

  it("an address that is not a seed address is refused — for a session and for --delete", async () => {
    for (const args of [
      [...base, "--email", `someone-${tag}@gmail.com`],
      ["--delete", "--email", `someone-${tag}@gmail.com`],
    ]) {
      const done = await script(args);
      expect(done.code).toBe(1);
      expect(done.stderr).toContain("seed address");
    }
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("a REAL user at a seed-shaped address (someone signed up with it): not verified, not unsuspended, not made admin, given no session — and not deleted", async () => {
    const email = `remote-spec-squatter-${tag}@holdfast-e2e.example`;
    const id = `squat${tag}`.padEnd(32, "x").slice(0, 32);
    await withDb(async (db) => {
      await db.query(
        `INSERT INTO "user" (id, name, email, email_verified, role, banned, suspended_at, created_at, updated_at)
         VALUES ($1, 'Remote Spec', $2, false, 'user', true, now(), now(), now())`,
        [id, email],
      );
    });
    try {
      const created = await script([...base, "--email", email, "--role", "admin", "--two-factor"]);
      expect(created.code).toBe(1);
      expect(created.stderr).toContain("NOT made by this script");
      expect(existsSync(out)).toBe(false);
      const removed = await script(["--delete", "--email", email]);
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain("NOT made by this script");
      await withDb(async (db) => {
        const row = await db.query(
          `SELECT email_verified, role, banned, suspended_at IS NOT NULL AS suspended, two_factor_enabled IS TRUE AS two_factor FROM "user" WHERE id = $1`,
          [id],
        );
        expect(row.rows).toEqual([
          { email_verified: false, role: "user", banned: true, suspended: true, two_factor: false },
        ]);
        expect((await db.query(`SELECT 1 FROM session WHERE user_id = $1`, [id])).rows).toEqual([]);
      });
    } finally {
      await withDb((db) => db.query(`DELETE FROM "user" WHERE id = $1`, [id]));
    }
  }, 120_000);

  it("the control: a seed address nobody has → created (cookie file mode 600, nothing secret printed), reused, deleted", async () => {
    const email = `remote-spec-${tag}@holdfast-e2e.example`;
    const created = await script([...base, "--email", email]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stderr).toContain("created a user");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(out, "utf8")) as { cookie: { name: string; value: string } };
    expect(file.cookie.name).toBe("hf.session_token");
    expect(created.stdout + created.stderr).not.toContain(file.cookie.value);
    expect(created.stdout + created.stderr).not.toContain("postgres://");
    const again = await script([...base, "--email", email]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).toContain("reused a user");
    const removed = await script(["--delete", "--email", email]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stderr).toContain("removed");
    await withDb(async (db) => {
      expect((await db.query(`SELECT 1 FROM "user" WHERE email = $1`, [email])).rows).toEqual([]);
      expect(
        (
          await db.query(
            `SELECT 1 FROM verification WHERE identifier LIKE 'create-session:%' AND created_at > now() - interval '10 minutes' AND identifier NOT IN (SELECT 'create-session:' || id FROM "user")`,
          )
        ).rows,
      ).toEqual([]);
    });
  }, 180_000);
});
