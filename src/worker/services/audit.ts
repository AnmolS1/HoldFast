// The audit log writer. Every task audits through this; it is the only caller of `insertAudit`.
//
//   audit(c, "node.trashed", { type: "node", id }, { count: 3 });          from a route
//   audit(deps, "account.suspended", { type: "user", id: userId }, null,    from a service, the
//         { actorUserId: adminId, actorType: "admin" });                   queue consumer or a job
//
// The row is written AFTER the response, through `defer`, so it is never part of the caller's
// transaction and never slows a request. A failed insert is reported and swallowed.
//
//   await auditInTx(tx, c, "node.purge", { type: "node", id }, { bytes });   a PURGE only: the
//                                          row is awaited on `tx`, and a failed insert throws
//
// From a request the row carries `ipHashDaily`, `ua`, `country` and `requestId`, and the actor
// defaults to the session (an impersonated session is recorded as the admin behind it). From a
// `ServiceDeps` those four are null and the actor defaults to `system` — pass `options` to name
// one. `meta` holds short facts only: no raw IPs, no tokens, no passwords.
//
// Not for thumbnail or inline serves (those are aggregated elsewhere).

import { userAgentFamily } from "../../shared/sentry-redact";
import type { Context } from "hono";
import type { Tx } from "../db/client";
import type { AuditRow } from "../db/queries/audit";
import { captureError } from "../sentry";
import { now } from "./clock";
import { dayUTC, ipHashDaily } from "./ip-hash";
import { writeMetric } from "./metrics";
import {
  coreFor,
  coreOf,
  db,
  defer,
  keys,
  type AppEnv,
  type CoreDeps,
  type ServiceDeps,
} from "./request-context";

export type { AuditRow };
export type AuditTarget = { type: string; id?: string | null } | null;
export type AuditOptions = { actorUserId?: string | null; actorType?: AuditRow["actorType"] };

function isContext(source: Context<AppEnv> | ServiceDeps): source is Context<AppEnv> {
  return "req" in source && "executionCtx" in source;
}

const isAdminRole = (role: string | null | undefined) => (role ?? "").split(",").includes("admin");

function requestActor(c: Context<AppEnv>): Required<AuditOptions> {
  const user = c.get("user");
  const impersonator = c.get("session")?.impersonatedBy;
  if (impersonator) return { actorUserId: impersonator, actorType: "admin" };
  if (!user) return { actorUserId: null, actorType: "system" };
  return { actorUserId: user.id, actorType: isAdminRole(user.role) ? "admin" : "user" };
}

async function write(env: Env, insert: () => Promise<void>): Promise<void> {
  try {
    await insert();
  } catch (error) {
    captureError(error, { kind: "audit" });
    writeMetric(env, "error", { kind: "audit" });
  }
}

/** The row but for the daily IP hash, which only a request has and which takes an await. */
type Prepared = {
  core: CoreDeps;
  env: Env;
  row: Omit<AuditRow, "ipHashDaily">;
  ipHash: (() => Promise<string>) | null;
};

/** The one place a row is built: `audit` and `auditInTx` differ only in where they insert it. */
function prepare(
  source: Context<AppEnv> | ServiceDeps,
  action: string,
  target: AuditTarget,
  meta: Record<string, unknown> | null,
  options: AuditOptions,
): Prepared {
  const base = {
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    meta,
  };

  if (isContext(source)) {
    const c = source;
    const actor = { ...requestActor(c), ...options };
    const ip = c.get("ip");
    const requestId = c.get("requestId");
    // The browser FAMILY only ("Chrome", "Safari", "other") — what the session row keeps too. The
    // raw header is 256 characters of anything the client cares to send, and identifies a device.
    const header = c.req.header("user-agent");
    const ua = header === undefined ? null : userAgentFamily(header);
    const cf = c.req.raw.cf as { country?: unknown } | undefined;
    const country = typeof cf?.country === "string" ? cf.country : null;
    const day = dayUTC(now(c));
    return {
      core: coreOf(c),
      env: c.env,
      row: { ...base, ...actor, ua, country, requestId },
      ipHash: () => ipHashDaily(keys(c), ip, day),
    };
  }

  const actor: Required<AuditOptions> = { actorUserId: null, actorType: "system", ...options };
  return {
    core: coreFor(source),
    env: source.env,
    row: { ...base, ...actor, ua: null, country: null, requestId: null },
    ipHash: null,
  };
}

export function audit(
  source: Context<AppEnv> | ServiceDeps,
  action: string,
  target: AuditTarget,
  meta: Record<string, unknown> | null = null,
  options: AuditOptions = {},
): void {
  const { core, env, row, ipHash } = prepare(source, action, target, meta, options);
  const insert = core.insertAudit;
  if (isContext(source)) {
    const c = source;
    defer(
      c,
      write(env, async () => {
        const hash = ipHash ? await ipHash() : null;
        await insert(db(c), { ...row, ipHashDaily: hash });
      }),
    );
    return;
  }
  source.defer(write(env, () => insert(source.db, { ...row, ipHashDaily: null })));
}

/**
 * The same row as `audit` would write, inserted NOW on the caller's transaction — for a purge,
 * whose record must commit or roll back with its deletes. Nothing is deferred and nothing is
 * swallowed: a failed insert throws, and the caller's transaction ends with it.
 */
export async function auditInTx(
  tx: Tx,
  source: Context<AppEnv> | ServiceDeps,
  action: string,
  target: AuditTarget,
  meta: Record<string, unknown> | null = null,
  options: AuditOptions = {},
): Promise<void> {
  const { core, row, ipHash } = prepare(source, action, target, meta, options);
  await core.insertAudit(tx, { ...row, ipHashDaily: ipHash ? await ipHash() : null });
}
