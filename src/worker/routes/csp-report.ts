// POST /api/public/csp-report — where browsers send Content-Security-Policy violation reports
// (`report-uri` and `report-to csp` in security-headers.ts). Both formats:
//   application/csp-report    { "csp-report": { "violated-directive", "blocked-uri", … } }  (report-uri)
//   application/reports+json  [ { "type": "csp-violation", "body": { "effectiveDirective", … } } ]  (Reporting API)
//
// EVERY BYTE HERE IS THE SENDER'S. Anyone can post anything, so:
//   - the body is read to at most 8 KB, counted as it streams (a Content-Length can lie or be
//     absent); a longer body is dropped unread;
//   - the one tag written to the metric is the violated directive's NAME from a fixed list,
//     else `other` — never a URL, a sample or a policy;
//   - the Sentry message is sampled, and every URI and the sample go through the shared
//     redaction first (a public-link page carries its token in the path);
//   - nothing is logged, nothing is stored, no session is read (the pipeline skips
//     /api/public/*), no cookie is set; the answer is 204 whatever was sent.
//
// THE COST IS BOUNDED, whoever sends. `report-uri` may name any URL, so a third-party page can aim
// every one of its visitors' browsers here — from as many addresses as it has visitors. So:
//   - a report whose document is not on this app's origin or the files origin is dropped
//     uncounted (a worker's reports name its script, which is on the app origin);
//   - at most 10 reports are taken from one body, and at most ONE Sentry message is sampled per
//     request, whatever the body holds;
//   - at most SENTRY_MESSAGES_PER_MINUTE messages a minute leave one isolate;
//   - the endpoint has a bucket of its own on RL_API (`csp:<address>`); over it a report is
//     dropped (204). The pipeline's RL_API by address skips this path (middleware/rate-limit.ts),
//     so a page with a repeating violation never spends its address's budget for the API.
//   - a body over the cap leaves one `oversize` data point, so the loss is visible.

import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { redactText } from "../../shared/sentry-redact";
import { normalise } from "../services/ip-hash";
import { metric } from "../services/metrics";
import { checkRateLimit } from "../services/ratelimit";
import type { AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

export const MAX_REPORT_BYTES = 8 * 1024;
/** Reports taken from one body (the Reporting API may batch several). */
const MAX_REPORTS = 10;
/** The share of requests whose (first) report becomes a Sentry message; the metric counts every report. */
export const SENTRY_SAMPLE_RATE = 0.1;
/** The most Sentry messages one isolate sends in a minute. */
export const SENTRY_MESSAGES_PER_MINUTE = 10;

// A ceiling, not an exact count: per isolate, reset each minute.
const sentryBudget = { minute: 0, sent: 0 };

function takeSentryBudget(nowMs: number): boolean {
  const minute = Math.floor(nowMs / 60_000);
  if (minute !== sentryBudget.minute) {
    sentryBudget.minute = minute;
    sentryBudget.sent = 0;
  }
  if (sentryBudget.sent >= SENTRY_MESSAGES_PER_MINUTE) return false;
  sentryBudget.sent += 1;
  return true;
}

/** Tests only: a fresh minute. */
export function resetSentryBudgetForTests(): void {
  sentryBudget.minute = 0;
  sentryBudget.sent = 0;
}

/** Fetch directives, document, navigation and reporting directives of CSP Level 3, and the sub-kinds browsers report. */
const DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "media-src",
  "connect-src",
  "font-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "object-src",
  "prefetch-src",
  "fenced-frame-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "navigate-to",
  "sandbox",
  "trusted-types",
  "require-trusted-types-for",
  "upgrade-insecure-requests",
  "webrtc",
]);

/** The directive name as a metric tag: the first token of what was sent, if it is a known name. */
export function directiveTag(raw: unknown): string {
  if (typeof raw !== "string") return "other";
  const name = raw.trim().split(/\s/, 1)[0]?.toLowerCase() ?? "";
  return DIRECTIVES.has(name) ? name : "other";
}

const REPORT_TYPES = new Set(["application/csp-report", "application/reports+json"]);

type Report = { directive: string; document: unknown; blocked: unknown; referrer: unknown; sample: unknown };

/** Is the report about a document (or a worker script) of this app or of its files host? */
function fromHere(report: Report, origins: ReadonlySet<string>): boolean {
  if (typeof report.document !== "string") return false;
  try {
    return origins.has(new URL(report.document).origin);
  } catch {
    return false;
  }
}

/** The body; `oversize` when it is longer than `max` bytes (then it is not read any further). */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<string | "oversize" | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return "oversize";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The reports in a body, or [] for anything that is not one of the two formats. */
export function parseReports(contentType: string, text: string): Report[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (contentType === "application/csp-report") {
    const body = isObject(parsed) ? parsed["csp-report"] : undefined;
    if (!isObject(body)) return [];
    return [
      {
        directive: directiveTag(body["effective-directive"] ?? body["violated-directive"]),
        document: body["document-uri"],
        blocked: body["blocked-uri"],
        referrer: body.referrer,
        sample: body["script-sample"],
      },
    ];
  }
  if (contentType === "application/reports+json") {
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => isObject(item) && item.type === "csp-violation")
      .map((item) => (isObject(item.body) ? item.body : {}))
      .slice(0, MAX_REPORTS)
      .map((body) => ({
        directive: directiveTag(body.effectiveDirective),
        document: body.documentURL,
        blocked: body.blockedURL,
        referrer: body.referrer,
        sample: body.sample,
      }));
  }
  return [];
}

/** A field as Sentry may see it: a string, redacted, or nothing. */
const redacted = (value: unknown): string | undefined =>
  typeof value === "string" ? redactText(value) : undefined;

function toSentry(report: Report): void {
  try {
    Sentry.withScope((scope) => {
      scope.setTag("csp_directive", report.directive);
      scope.setContext("csp", {
        documentUri: redacted(report.document),
        blockedUri: redacted(report.blocked),
        referrer: redacted(report.referrer),
        sample: redacted(report.sample),
      });
      Sentry.captureMessage(`CSP violation: ${report.directive}`, "warning");
    });
  } catch {
    // Reporting a report must never fail the request.
  }
}

router.post("/public/csp-report", async (c) => {
  try {
    const contentType = (c.req.header("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (!REPORT_TYPES.has(contentType)) {
      await c.req.raw.body?.cancel();
      return c.body(null, 204);
    }
    if (!(await checkRateLimit(c.env, "RL_API", `csp:${normalise(c.get("ip"))}`))) {
      await c.req.raw.body?.cancel();
      return c.body(null, 204);
    }
    const text = await readCapped(c.req.raw.body, MAX_REPORT_BYTES);
    if (text === "oversize") {
      metric("csp", { reason: "oversize" });
    } else if (text !== null) {
      const origins = new Set([new URL(c.env.APP_ORIGIN).origin, new URL(c.env.FILES_ORIGIN).origin]);
      const reports = parseReports(contentType, text).filter((report) => fromHere(report, origins));
      for (const report of reports) metric("csp", { reason: report.directive });
      // One message at most per request, whatever the body held.
      const first = reports[0];
      if (first && Math.random() < SENTRY_SAMPLE_RATE && takeSentryBudget(Date.now())) toSentry(first);
    }
  } catch {
    // A body that cannot be read is dropped like a malformed one.
  }
  return c.body(null, 204);
});
