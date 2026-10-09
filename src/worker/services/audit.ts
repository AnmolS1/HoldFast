// The audit log writer. Every task audits through this; it is the only caller of `insertAudit`.
//
//   audit(c, "node.trashed", { type: "node", id }, { count: 3 });          from a route
//   audit(deps, "account.suspended", { type: "user", id: userId }, null,    from a service, the
//         { actorUserId: adminId, actorType: "admin" });                   queue consumer or a job
//
// The row is written AFTER the response, through `defer`, so it is never part of the caller's
// transaction and never slows a request. A failed insert is reported and swallowed.
//
// From a request the row carries `ipHashDaily`, `ua`, `country` and `requestId`, and the actor
// defaults to the session (an impersonated session is recorded as the admin behind it). From a
// `ServiceDeps` those four are null and the actor defaults to `system` — pass `options` to name
// one. `meta` holds short facts only: no raw IPs, no tokens, no passwords.
//
// Not for thumbnail or inline serves (those are aggregated elsewhere).

import type { Context } from "hono";
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

export type AuditRow = Parameters<CoreDeps["insertAudit"]>[1];
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

export function audit(
  source: Context<AppEnv> | ServiceDeps,
  action: string,
  target: AuditTarget,
  meta: Record<string, unknown> | null = null,
  options: AuditOptions = {},
): void {
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
    const ua = c.req.header("user-agent")?.slice(0, 256) ?? null;
    const cf = c.req.raw.cf as { country?: unknown } | undefined;
    const country = typeof cf?.country === "string" ? cf.country : null;
    const day = dayUTC(now(c));
    const insert = coreOf(c).insertAudit;
    defer(
      c,
      write(c.env, async () => {
        const hash = await ipHashDaily(keys(c), ip, day);
        await insert(db(c), { ...base, ...actor, ipHashDaily: hash, ua, country, requestId });
      }),
    );
    return;
  }

  const actor: Required<AuditOptions> = { actorUserId: null, actorType: "system", ...options };
  const insert = coreFor(source).insertAudit;
  source.defer(
    write(source.env, () =>
      insert(source.db, { ...base, ...actor, ipHashDaily: null, ua: null, country: null, requestId: null }),
    ),
  );
}
