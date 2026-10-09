// Better Auth's log lines, on their way to the Worker's log.
//
// The library logs through `console` by default, and what it logs can carry personal data: an
// email address in a message ("Sign-up attempt for existing email: …"), a whole database error
// object beside "Failed to create user" (Postgres puts the offending key — the address — in the
// error's `detail`), a token inside a URL. Workers Logs are kept; none of that belongs there.
// So every line goes through the same redaction as a Sentry event (src/shared/sentry-redact.ts:
// addresses, token-bearing path segments and query values), an Error is reduced to its name and
// messages (never its fields), and a line is capped in length.

import { redactText } from "../../shared/sentry-redact";

const MAX_LINE = 2_000;

function describe(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const cause =
      value.cause !== undefined && depth < 3 ? ` (cause: ${describe(value.cause, depth + 1)})` : "";
    return `${value.name}: ${value.message}${cause}`;
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** One log line, safe to keep. Exported for the test. */
export function authLogLine(message: unknown, args: unknown[]): string {
  const line = [message, ...args].map((part) => describe(part)).join(" ");
  const safe = redactText(line);
  return safe.length > MAX_LINE ? `${safe.slice(0, MAX_LINE)}…` : safe;
}

/** `logger.log` for Better Auth's options. */
export function authLog(
  level: "debug" | "info" | "success" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  const line = `[auth] ${authLogLine(message, args)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
