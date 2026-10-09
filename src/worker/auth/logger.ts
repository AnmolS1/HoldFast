// Better Auth's log lines, on their way to the Worker's log.
//
// The library logs through `console` by default, and what it logs can carry personal data: an
// address in a message ("Sign-up attempt for existing email: …"), a whole database error object
// beside "Failed to create user" (Postgres puts the offending key — the address — in the error's
// `detail`), an error whose message holds a link. Workers Logs are kept; none of that belongs
// there. So Better Auth is given this logger (create-auth.ts: `logger.log`), and every part of
// every line — the message and each argument — goes through the auth layer's one redaction
// function (./redact.ts) before it is written:
//
//   a string            scanned: addresses, URLs, tokens, codes, IP addresses replaced
//   an Error            its class, its code, its scanned message — never its other fields
//   any other object    the allow-listed fields (event, userId, requestId, code); the rest dropped
//
// The level is `warn` (set in create-auth.ts): Better Auth's `info` and `debug` lines are the
// ones that narrate a request, address included, and nothing is lost without them — what
// happened to an account is in the audit log.

import { describeValue } from "./redact";

const MAX_LINE = 2_000;

/** One log line, safe to keep. Exported for the test. */
export function authLogLine(message: unknown, args: unknown[]): string {
  const line = [message, ...args]
    .map((part) => describeValue(part))
    .filter((part) => part !== "")
    .join(" ");
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
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
