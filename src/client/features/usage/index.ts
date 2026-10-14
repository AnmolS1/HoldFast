// The storage slot of the shell: the sidebar's bar reads `useUsageSummary()`.
import type { UsageSummary } from "../../components/slots";
import { useUsage } from "./queries";

export { routes } from "./routes";

/** Used and quota bytes, or `null` while they are not known — loading, or the request failed. */
export function useUsageSummary(): UsageSummary | null {
  const { data } = useUsage();
  return data ? { usedBytes: data.usedBytes, quotaBytes: data.quotaBytes } : null;
}
