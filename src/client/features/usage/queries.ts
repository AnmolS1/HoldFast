import { useQuery } from "@tanstack/react-query";
import { UsageDto } from "../../../shared/schemas/account";
import { ALMOST_FULL } from "../../components/StorageBar";
import { api } from "../../lib/api";
import { viewKeys } from "../starred/view-queries";
import { AUTO_REFETCH } from "../starred/view-state";

/** `GET /api/account/usage`: one query for the sidebar's bar and the Storage page. */
export function useUsage() {
  return useQuery({
    queryKey: viewKeys.usage,
    queryFn: ({ signal }) => api("/api/account/usage", { schema: UsageDto, signal }),
    ...AUTO_REFETCH,
  });
}

export type UsagePart = "files" | "trash" | "versions" | "reserved";
export type UsageLevel = "neutral" | "attention" | "full";

export interface UsageBreakdown {
  /** In the order they are shown. */
  parts: Array<{ part: UsagePart; bytes: number }>;
  /** Used share of the quota, 0..1. */
  ratio: number;
  /** Bytes left; 0 when the quota is reached or passed. */
  freeBytes: number;
  /** Bytes past the quota; 0 while there is room. */
  overBytes: number;
  /** Neutral below 90 %, then "attention" — the same threshold the bar itself uses. */
  level: UsageLevel;
}

export function usageBreakdown(usage: UsageDto): UsageBreakdown {
  const ratio = usage.quotaBytes > 0 ? Math.min(1, Math.max(0, usage.usedBytes / usage.quotaBytes)) : 0;
  return {
    parts: [
      { part: "files", bytes: usage.filesBytes },
      { part: "trash", bytes: usage.trashBytes },
      { part: "versions", bytes: usage.versionsBytes },
      { part: "reserved", bytes: usage.reservedBytes },
    ],
    ratio,
    freeBytes: Math.max(0, usage.quotaBytes - usage.usedBytes),
    overBytes: Math.max(0, usage.usedBytes - usage.quotaBytes),
    level: ratio >= 1 ? "full" : ratio >= ALMOST_FULL ? "attention" : "neutral",
  };
}
