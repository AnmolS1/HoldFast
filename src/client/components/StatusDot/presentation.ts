import { Ban, Eye, TriangleAlert, type LucideIcon } from "lucide-react";
import { t, type MessageKey } from "../../lib/i18n";
import type { ScanStatus } from "../types";

/** Which colour token a status uses. `null` = nothing is drawn. */
export type StatusToken = "danger" | "attention" | "textSecondary" | "accentText" | null;

interface Presentation {
  token: StatusToken;
  icon: LucideIcon | null;
  message: MessageKey | null;
}

// The state vocabulary. `suspected_csam` is presented exactly like `under_review`: the owner is
// never shown a category.
export const STATUS_PRESENTATION: Record<ScanStatus, Presentation> = {
  clean: { token: null, icon: null, message: null },
  pending: { token: "accentText", icon: null, message: "status.pending" },
  infected: { token: "danger", icon: Ban, message: "status.infected" },
  under_review: { token: "textSecondary", icon: Eye, message: "status.underReview" },
  suspected_csam: { token: "textSecondary", icon: Eye, message: "status.underReview" },
  skipped: { token: "attention", icon: TriangleAlert, message: "status.skipped" },
  error: { token: "attention", icon: TriangleAlert, message: "status.error" },
};

/** The plain sentence for a status, or null when there is nothing to say (`clean`). */
export function statusSentence(status: ScanStatus, reason?: string | null): string | null {
  if (status === "skipped" && reason === "size") return t("status.skipped.size");
  const key = STATUS_PRESENTATION[status].message;
  return key ? t(key) : null;
}
