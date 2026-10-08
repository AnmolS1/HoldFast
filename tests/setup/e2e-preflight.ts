// Checks that must pass BEFORE Playwright starts its own dev server. Called from
// playwright.config.ts, because Playwright launches `webServer` before it runs `globalSetup`
// (so a check in globalSetup would come too late: the run would already have failed with
// Playwright's generic "already used" error, or with a readiness timeout).
//
// A checkout has one `.dev.vars` and therefore one port. The Worker dispatches on the host
// including that port, so:
//   1. nothing else may hold the port (a dev server and an e2e run cannot coexist in one checkout);
//   2. `.dev.vars` must name the same port, or every request is answered 421.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appOrigin, filesOrigin } from "./local-env";

/** Pids listening on a TCP port, or [] when it is free or `lsof` is not installed. */
export function listenersOn(port: number): string[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    // lsof exits 1 when nothing matches; a missing lsof is treated the same (Playwright still
    // refuses a port that answers, only with a less helpful message).
    return [];
  }
}

/** Reads the given keys from a dotenv-style file. Returns only those keys; nothing is logged. */
export function readVars(path: string, keys: string[]): Record<string, string | undefined> {
  const found: Record<string, string | undefined> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || !keys.includes(match[1]!)) continue;
    found[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return found;
}

export function preflight(root: string, port: number): void {
  const holders = listenersOn(port);
  if (holders.length > 0) {
    throw new Error(
      `port ${port} is in use — stop this worktree's dev server (npm run dev) before running e2e ` +
        `(pid ${holders.join(", ")}; check whose it is: lsof -a -p ${holders[0]} -d cwd)`,
    );
  }

  const devVars = join(root, ".dev.vars");
  if (!existsSync(devVars)) {
    throw new Error(`.dev.vars is missing — write it for this checkout's port: scripts/dev-env.sh ${port}`);
  }
  const vars = readVars(devVars, ["APP_ORIGIN", "FILES_ORIGIN"]);
  const expected = { APP_ORIGIN: appOrigin(port), FILES_ORIGIN: filesOrigin(port) };
  for (const [name, want] of Object.entries(expected)) {
    if (vars[name] !== want) {
      throw new Error(
        `.dev.vars has ${name}=${vars[name] ?? "(unset)"} but this e2e run uses port ${port} (${want}) — ` +
          `the Worker would answer 421 to every request. Either run with the port .dev.vars names ` +
          `(HOLDFAST_PORT) or rewrite it: scripts/dev-env.sh ${port}`,
      );
    }
  }
}
