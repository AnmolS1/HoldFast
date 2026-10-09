// Errors the query helpers throw.
//
// `QueryError` carries one of the shared error codes (src/shared/errors.ts), so the Worker's
// error handler can turn it into the matching response. `LegalHoldError` carries none on
// purpose: it must never reach a response.

import type { ErrorCode } from "../../shared/errors";

/** A failure a route may show to the caller. `code` decides the HTTP status. */
export class QueryError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "QueryError";
    this.code = code;
    this.details = details;
  }
}

/** Why a root cannot be permanently deleted. Shown to admins only. */
export type HoldCause =
  "node_legal_hold" | "owner_legal_hold" | "under_review" | "suspected_csam" | "open_notice";

/**
 * Thrown by `assertPurgeable`. Internal: the cron skips the root, the manual paths record a purge
 * request and answer as if the delete had happened. The hold is never disclosed to the owner.
 */
export class LegalHoldError extends Error {
  readonly heldRootIds: string[];
  /** Root id → every cause found in its subtree. For the admin console only. */
  readonly causes: Record<string, HoldCause[]>;

  constructor(causes: Record<string, HoldCause[]>) {
    super("held");
    this.name = "LegalHoldError";
    this.heldRootIds = Object.keys(causes);
    this.causes = causes;
  }
}

/**
 * The Postgres error behind a failed query, or undefined. Drizzle wraps the driver's error, so
 * the SQLSTATE `code` and the `constraint` name are on a `cause`.
 */
export function pgError(error: unknown): { code: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      severity?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code) && candidate.severity) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/** True for a unique violation (SQLSTATE 23505), optionally on one of the named constraints. */
export function isUniqueViolation(error: unknown, constraints?: readonly string[]): boolean {
  const pg = pgError(error);
  if (!pg || pg.code !== "23505") return false;
  return !constraints || (pg.constraint !== undefined && constraints.includes(pg.constraint));
}
