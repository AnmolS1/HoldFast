// The one call of the report dialog: the public route when it has a link token (the proof of
// access on a public page), the signed-in route otherwise. One request per submit — never
// retried here; a `429` names its wait (`Retry-After`), which the dialog honours.
import type { ReportBody } from "../../../shared/schemas/report";
import { ReportResponse } from "../../../shared/schemas/report";
import type { ReportTarget } from "../../components/slots";
import { api } from "../../lib/api";

export type ReportInput = Omit<ReportBody, "nodeId" | "linkToken">;

/** The wait key of the report form: one per browser, as the server's cap is per reporter. */
export const REPORT_WAIT_KEY = "report:submit";

export function sendReport(target: ReportTarget, input: ReportInput) {
  const publicRoute = target.linkToken !== undefined;
  const body: ReportBody = {
    nodeId: target.nodeId,
    category: input.category,
    details: input.details,
    turnstileToken: input.turnstileToken,
    // The signed-in route takes the reporter's address from the session: none is sent there.
    ...(publicRoute ? { linkToken: target.linkToken } : {}),
    ...(publicRoute && input.reporterEmail ? { reporterEmail: input.reporterEmail } : {}),
  };
  return api(publicRoute ? "/api/public/report" : "/api/reports", {
    method: "POST",
    body,
    schema: ReportResponse,
    // Announced by the dialog itself, in its own words.
    silent: [
      "validation",
      "not_found",
      "forbidden",
      "rate_limited",
      "feature_disabled",
      "internal",
      "http_error",
    ],
  });
}
