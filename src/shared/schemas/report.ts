// The abuse report form.

import { z } from "zod";
import { Email, NodeId, PathToken } from "./common";

export const ReportCategory = z.enum(["malware", "csam", "copyright", "phishing", "spam", "other"]);
export type ReportCategory = z.infer<typeof ReportCategory>;

/**
 * PROOF OF ACCESS IS REQUIRED: either `linkToken` for a link whose subtree contains `nodeId`, or
 * a signed-in session with a role on it. A bare `nodeId` is refused with `not_found`.
 */
export const ReportBody = z.strictObject({
  nodeId: NodeId,
  linkToken: PathToken.optional(),
  category: ReportCategory,
  details: z.string().max(4000),
  reporterEmail: Email.optional(),
  turnstileToken: z.string().min(1).max(4096),
});
export type ReportBody = z.infer<typeof ReportBody>;

export const ReportResponse = z.object({ received: z.literal(true) });
export type ReportResponse = z.infer<typeof ReportResponse>;
