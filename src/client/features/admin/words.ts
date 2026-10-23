// Words and small helpers of the console's screens: the sentence for a refusal, units and dates,
// labels from the catalogue, and the sentences a screen builds from an answer (each pinned in
// tests/unit/client/admin).
import { useEffect, useState } from "react";
import type {
  AdminAuditResponse,
  AdminRescanResponse,
  AdminStrikeDto,
  AdminUserDetailDto,
  CsamClearResultDto,
} from "../../../shared/schemas/admin";
import { ApiError } from "../../lib/api";
import { formatBytes, formatDate } from "../../lib/format";
import { useWaitUntil } from "../../lib/query";
import { messages, t, type AdminMessage } from "./strings";

/** The `details.reason` of a refusal, when it has one. */
export function reasonOf(error: unknown): string | undefined {
  return error instanceof ApiError && typeof error.details?.reason === "string"
    ? error.details.reason
    : undefined;
}

/** The sentence for a refusal: the screen's own words for its `details.reason`, else the server's. */
export function refusalText(error: unknown, words: Partial<Record<string, string>> = {}): string {
  const reason = reasonOf(error);
  if (reason && words[reason]) return words[reason]!;
  if (error instanceof ApiError) {
    if (error.status === 0) return t("common.offline");
    if (reason === "impersonation_read_only") return t("common.impersonating");
    if (error.status >= 400 && error.status < 500 && error.message) return error.message;
  }
  return t("common.failed");
}

/** Seconds left of the wait under `hash`; 0 when none. Re-renders each second while waiting. */
export function useSecondsLeft(hash: string): number {
  const until = useWaitUntil(hash);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === 0 ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

export function waitText(seconds: number): string {
  if (seconds < 60) return t("wait.seconds", { count: Math.max(1, seconds) });
  return t("wait.minutes", { count: Math.ceil(seconds / 60) });
}

export const bytes = (value: number | null | undefined) => formatBytes(value);
export const when = (value: string | null | undefined) =>
  value ? formatDate(value, { style: "dateTime" }) : "—";
/**
 * A DMCA window date on New York's calendar, whatever the viewer's zone: the window is counted in
 * New York business days (src/worker/services/business-days.ts), so a local or UTC reading of its
 * end can show the day after.
 */
export const eastern = (value: string | null | undefined, style: "dateTime" | "long") =>
  value ? formatDate(value, { timeZone: "America/New_York", style }) : "—";

/** A label from the catalogue for a known value, else the value itself. */
export function label(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  return Object.prototype.hasOwnProperty.call(messages, key) ? t(key as AdminMessage) : value;
}

/** "62 GB of 100 GB" — decimal units, as everywhere. */
export function egressText(detail: AdminUserDetailDto): string {
  return t("users.egressOf", {
    used: bytes(detail.linkEgressToday.bytes),
    cap: bytes(detail.linkEgressToday.capBytes),
  });
}

/** The five states of a strike, as the list words them. A lift by a deleted admin reads "system". */
export function strikeStateText(strike: AdminStrikeDto): string {
  switch (strike.state) {
    case "active":
      return t("strike.active");
    case "lifted":
      return t("strike.lifted", { when: when(strike.liftedAt) });
    case "lifted_expired":
      return t("strike.liftedExpired");
    case "lifted_by_system":
      return t("strike.liftedBySystem");
    case "expired":
      return t("strike.expired");
  }
}

/** What a refused rescan says (task §4); `queued` on an under-review node says the result waits. */
export function rescanText(result: AdminRescanResponse, underReview: boolean): string {
  if (result.queued) return underReview ? t("q.rescan.queuedReview") : t("q.rescan.queued");
  return result.reason === "taken_down" ? t("q.rescan.takenDown") : t("q.rescan.locked");
}

/** An open report older than 24 h carries the badge. */
const DAY = 86_400_000;

export const overdue = (report: { status: string; createdAt: string }, now = Date.now()) =>
  report.status === "open" && now - Date.parse(report.createdAt) > DAY;

/** One sentence per fact of a clear's result (task §6's table, in its words). */
export function clearSentences(result: CsamClearResultDto): string[] {
  if (result.refused === "not_locked") return [t("clear.notLocked")];
  if (result.refused === "reported") return [t("clear.reported")];
  const lines = [t("clear.cleared")];
  if (result.reportIds.length) lines.push(t("clear.reports", { ids: result.reportIds.join(", ") }));
  if (result.blocklistRemoved) lines.push(t("clear.bl.removed"));
  else if (result.blocklistRestoredTo)
    lines.push(t("clear.bl.restored", { reason: result.blocklistRestoredTo }));
  else if (result.blocklistKept) lines.push(t(`clear.bl.kept.${result.blocklistKept}`));
  else lines.push(t("clear.bl.none"));
  return lines;
}

export function actorName(
  entry: { actorUserId: string | null; actorType: string },
  actors: AdminAuditResponse["actors"],
): string {
  if (entry.actorUserId === null) return t("audit.system");
  const known = actors[entry.actorUserId];
  return known ? known.displayName : t("audit.deletedAccount");
}
