// Abuse reports (decision D6). Paths are relative to /api.
//
//   POST /public/report   a visitor of a public link — proof: the link's token
//   POST /reports         a signed-in user — proof: a share role on the node
//
// Both take `ReportBody` and answer `202 { received: true }`.
//
// PROOF OF ACCESS FIRST. A report is taken only from someone who was actually shown the file: a
// token whose link ANSWERS — the public link routes' own availability table (`resolveLink`, rows
// 1–9: not revoked, expired, at its download cap, paused, locked, links off, owner suspended; a
// password link only with a valid link session in `X-Holdfast-Link-Session`) — and has the file at
// or under its root, or a session holding a share role on it. Until that is proven every failure
// is the one `404 not_found` of an unknown id (a link the visitor may not use is refused before any
// node is looked at, so it says nothing about the node) — and Turnstile comes AFTER it, so its `403` says
// nothing about the node either. The public route reads no session at all (the pipeline skips
// it under /api/public/, and CSRF exempts the path): a signed-in victim's browser cannot be made
// to file a report as them.
//
// A VALID REPORT PAUSES AND HIDES — one transaction: the node `under_review` and its OWN links
// paused with `report` (T05 `setUnderReview`, called unconditionally: an `infected` or
// `suspected_csam` node is left as it is inside that helper), then the report row (T05
// `insertReport`; a duplicate of an open report by the same reporter hash, node and category
// writes nothing). Nothing is revoked, deleted or struck, and nothing moves a node towards
// `suspected_csam`. A duplicate is answered exactly like a new report — while the link still answers:
// a FILE link is itself paused by the first report, so a second report through it is the `404`.
//
// VOLUME. At most REPORTS_PER_REPORTER_DAY reports per reporter (the stable address hash — the
// only reporter identifier) in 24 hours, counted under the reporter's own lock in the report's
// transaction; the dedupe; and the operators are mailed (ROUTINE `sendAdminAlert`: an id and a
// category, never a name, details or reporter data) only while the link has fewer than
// LINK_ALERT_OPEN_REPORTS open reports — the rows are still written, the console lists them.

import { Hono, type Context } from "hono";
import { ReportBody, type ReportResponse } from "../../shared/schemas/report";
import { verifyCaptcha } from "../auth/captcha";
import { lockReporter, openReportsOnLink, reportsByReporterSince } from "../db/queries/abuse";
import { insertReport, setUnderReview } from "../db/queries/moderation";
import { getNode } from "../db/queries/nodes";
import { isDescendantOrSelf, nodeVisibility } from "../db/queries/tree";
import { retryOnDeadlock } from "../db/retry";
import type { ShareLink } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { rateLimitByIp } from "../middleware/rate-limit";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { sendAdminAlert } from "../services/email";
import { AppError } from "../services/errors";
import { ipHashStable } from "../services/ip-hash";
import { metric } from "../services/metrics";
import { getAccess } from "../services/permissions";
import { auth, db, defer, deps, keys, type AppEnv } from "../services/request-context";
import { adminListOf } from "../services/signup-policy";
import { resolveLink } from "./public-links";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

/** Reports one reporter (stable address hash) may file in REPORTER_WINDOW_HOURS. */
export const REPORTS_PER_REPORTER_DAY = 5;
export const REPORTER_WINDOW_HOURS = 24;
/** Open reports filed through one link beyond which a new one is not mailed to the operators. */
export const LINK_ALERT_OPEN_REPORTS = 20;

export const FOLDER_MESSAGE = "Choose the file you want to report.";

const ACCEPTED: ReportResponse = { received: true };

/** What was proven, and about what. */
type Proven = {
  nodeId: string;
  ownerId: string;
  linkId: string | null;
  reporterUserId: string | null;
  reporterEmail: string | null;
};

/** A node that is not there for this reporter: one answer for all of it. */
const missing = () => new AppError("not_found");

/**
 * The link of a token that proves something: one the public link routes would answer, password
 * included (`resolveLink` with `password: "required"`). Every refusal of it — expired, paused,
 * password required, unknown — is the `404` of an unknown token; any other failure is not a
 * refusal and is not hidden.
 */
async function provingLink(c: Ctx, token: string | undefined): Promise<ShareLink> {
  if (token === undefined) throw missing();
  try {
    return (await resolveLink(c, token, { password: "required" })).link;
  } catch (error) {
    if (error instanceof AppError) throw missing();
    throw error;
  }
}

/**
 * The public route's proof: the node is the link's root or under it, exists, is not in the
 * trash and not hidden (taken down, itself or above; locked as suspected CSAM) — all `404` — and
 * is a FILE (a folder: `400`). Its scan state is not asked: a file another visitor's report has
 * just put under review is still reportable by whoever was shown it.
 */
async function proveByLink(c: Ctx, body: ReportBody): Promise<Proven> {
  const link = await provingLink(c, body.linkToken);
  const [under, seen] = await Promise.all([
    isDescendantOrSelf(db(c), body.nodeId, link.nodeId),
    nodeVisibility(db(c), body.nodeId),
  ]);
  if (!under || seen.hidden || seen.trashed || seen.kind === null) throw missing();
  if (seen.kind !== "file") throw new AppError("validation", FOLDER_MESSAGE, { fields: ["nodeId"] });
  const node = await getNode(db(c), body.nodeId);
  if (!node || node.system !== null) throw missing();
  return {
    nodeId: node.id,
    ownerId: node.ownerId,
    linkId: link.id,
    reporterUserId: null,
    reporterEmail: body.reporterEmail ?? null,
  };
}

/**
 * The session route's proof: `getAccess` (not in the trash) is a role THROUGH A SHARE — a hidden
 * node, one the caller may not see, an unknown id: `404`; the owner: `400` (an owner removes their
 * own file). A folder: `400`. The session is read ONCE, here: the report is filed under the
 * identity that proved access, whatever happens to the session afterwards.
 */
async function proveBySession(c: Ctx, body: ReportBody): Promise<Proven> {
  const user = requireVerified(c);
  const access = await getAccess(c, body.nodeId, { notTrashed: true });
  if (!access) throw missing();
  if (access.role === "owner" || access.via !== "share") {
    throw new AppError("validation", "You can't report your own file. Delete it instead.");
  }
  const node = await getNode(db(c), body.nodeId);
  if (!node || node.system !== null) throw missing();
  if (node.kind !== "file") throw new AppError("validation", FOLDER_MESSAGE, { fields: ["nodeId"] });
  return {
    nodeId: node.id,
    ownerId: node.ownerId,
    linkId: null,
    reporterUserId: user.id,
    reporterEmail: user.email,
  };
}

export type FiledReport = { reportId: string | null; alert: boolean; changed: boolean };

/**
 * THE EFFECT of a report, one transaction (DATABASE STATEMENTS ONLY — it may run again on a
 * deadlock): the reporter's lock and cap, the per-link count, the node's transition and its
 * links' `report` pause, then the row. `reportId` null: a duplicate (nothing written). Exported
 * for the state-table tests, which file on nodes no route lets a reporter reach.
 */
export async function fileReport(
  exec: Parameters<typeof retryOnDeadlock>[0],
  proven: Proven,
  report: { category: ReportBody["category"]; details: string; reporterIpHashStable: string },
): Promise<FiledReport | { capped: true; retryAfterSec: number }> {
  return retryOnDeadlock(exec, async (tx) => {
    await lockReporter(tx, report.reporterIpHashStable);
    const filed = await reportsByReporterSince(tx, report.reporterIpHashStable, REPORTER_WINDOW_HOURS);
    if (filed.count >= REPORTS_PER_REPORTER_DAY) {
      return { capped: true as const, retryAfterSec: Math.max(1, filed.retryAfterSec) };
    }
    const openOnLink = proven.linkId ? await openReportsOnLink(tx, proven.linkId) : 0;
    // The node, then its links (lock order: nodes before the rest), then the report row.
    const { changed } = await setUnderReview(tx, proven.nodeId);
    const reportId = await insertReport(tx, {
      source: "user",
      category: report.category,
      nodeId: proven.nodeId,
      ownerId: proven.ownerId,
      linkId: proven.linkId,
      reporterUserId: proven.reporterUserId,
      reporterEmail: proven.reporterEmail,
      reporterIpHashStable: report.reporterIpHashStable,
      details: report.details,
    });
    return { reportId, alert: openOnLink < LINK_ALERT_OPEN_REPORTS, changed };
  });
}

/** After the commit: the operators' routine alert (deferred), the audit row, the metric. */
function announce(c: Ctx, proven: Proven, category: ReportBody["category"], filed: FiledReport): void {
  if (filed.reportId === null) {
    metric("report", { outcome: "duplicate", kind: category });
    return;
  }
  const reportId = filed.reportId;
  audit(
    c,
    "report.created",
    { type: "report", id: reportId },
    { nodeId: proven.nodeId, linkId: proven.linkId, category, source: "user", underReview: filed.changed },
  );
  metric("report", { outcome: "created", kind: category });
  if (!filed.alert) {
    metric("report", { outcome: "alert_capped", kind: category });
    return;
  }
  const source = deps(c);
  for (const to of adminListOf(c.env).addresses) {
    defer(
      c,
      sendAdminAlert(source, { to, kind: "report", id: reportId, category }).catch(() => {
        metric("error", { kind: "report_alert" });
      }),
    );
  }
}

/** Turnstile, the cap, the effect, the answer — the part both routes share once access is proven. */
async function intake(c: Ctx, body: ReportBody, proven: Proven): Promise<Response> {
  // Turnstile is answered inside the Worker in test mode, by the stand-in the auth instance
  // installs (auth/captcha.ts): build it first. It reads no session.
  auth(c);
  await verifyCaptcha(c.env, body.turnstileToken, c.get("ip"));
  const reporterIpHashStable = await ipHashStable(keys(c), c.get("ip"));
  const filed = await fileReport(db(c), proven, {
    category: body.category,
    details: body.details,
    reporterIpHashStable,
  });
  if ("capped" in filed) {
    metric("report", { outcome: "rate_limited", kind: body.category });
    throw new AppError("rate_limited", "You have sent several reports today. Try again later.", undefined, {
      "Retry-After": String(filed.retryAfterSec),
    });
  }
  announce(c, proven, body.category, filed);
  return c.json(ACCEPTED, 202);
}

router.post("/public/report", rateLimitByIp("RL_LINKS"), async (c) => {
  const body = ReportBody.parse(await jsonBody(c));
  return intake(c, body, await proveByLink(c, body));
});

router.post("/reports", async (c) => {
  requireVerified(c);
  const body = ReportBody.parse(await jsonBody(c));
  return intake(c, body, await proveBySession(c, body));
});
