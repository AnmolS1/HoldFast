// scripts/create-invite.ts — the bootstrap tool that writes straight into a database.
//   - a database that is not on this machine needs an explicit `--remote`: without it the script
//     refuses BEFORE connecting (a shell that still carries a hosted URL is one Enter away from
//     writing invites into it);
//   - it never prints the host or the URL — only the database NAME and whether it is local or
//     remote — on success and on failure alike.
// Run as a person runs it: a child process. The "remote" database here is a loopback address
// (in its IPv4-mapped spelling, which is not on the script's list of local names) on a port
// nothing listens on: it classifies as remote, is refused at once, and no packet leaves the machine.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { localDbName, localDbUrl } from "../../../setup/local-env";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));

const REMOTE_HOST = "[::ffff:127.0.0.1]";
const REMOTE_PASSWORD = "zzSECRETzzpassword";
const REMOTE_URL = `postgres://zzuser:${REMOTE_PASSWORD}@${REMOTE_HOST}:1/zzremotedb`;

async function invite(args: string[], url: string) {
  const env = { ...process.env, DATABASE_URL_DIRECT: url, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" };
  try {
    const done = await run("npx", ["tsx", "scripts/create-invite.ts", ...args], { cwd: root, env });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

function expectNoTarget(text: string): void {
  for (const secret of [
    REMOTE_HOST,
    "127.0.0.1",
    "7f00",
    "::ffff",
    REMOTE_PASSWORD,
    "zzuser",
    "postgres://",
  ]) {
    expect(text, secret).not.toContain(secret);
  }
}

describe("scripts/create-invite.ts", () => {
  it("refuses a remote database without --remote — before connecting, naming neither host nor URL", async () => {
    const started = Date.now();
    const out = await invite(["--uses", "1"], REMOTE_URL);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain('database "zzremotedb" (remote)');
    expect(out.stderr).toContain("--remote");
    expectNoTarget(out.stderr);
    // No connection attempt: the refusal is immediate.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it("with --remote it goes on to connect — and a failure still names neither host nor URL", async () => {
    const out = await invite(["--uses", "1", "--remote"], REMOTE_URL);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/^create-invite: the database could not be written to( \([A-Z0-9_]+\))?\n$/);
    expectNoTarget(out.stderr);
  }, 60_000);

  it("a local database needs no flag; the output is the code, and the name and class of the database", async () => {
    const out = await invite(["--uses", "1", "--note", "create-invite test"], localDbUrl());
    expect(out.code, out.stderr).toBe(0);
    const code = out.stdout.trim();
    expect(code).toMatch(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);
    expect(out.stderr).toContain(`on database "${localDbName()}" (local)`);
    expect(out.stderr).not.toMatch(/localhost|127\.0\.0\.1|postgres:\/\//);
    const client = new Client({ connectionString: localDbUrl() });
    await client.connect();
    try {
      const found = await client.query("SELECT max_uses, uses FROM invites WHERE code = $1", [code]);
      expect(found.rows).toEqual([{ max_uses: 1, uses: 0 }]);
      await client.query("DELETE FROM invites WHERE code = $1", [code]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("--remote on a local database is refused too: the flag is a statement about the target, not a habit", async () => {
    const out = await invite(["--uses", "1", "--remote"], localDbUrl());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("(local)");
  }, 30_000);
});
