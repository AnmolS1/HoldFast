// The storage slot of the shell: the sidebar's bar reads `useUsageSummary()`.
import type { UsageSlotValue } from "../../components/slots";
import { hasFailed, isWaitingOffline } from "../starred/view-state";
import { useUsage } from "./queries";

export { routes } from "./routes";

/**
 * Used and quota bytes; `null` while they load; `"unavailable"` when they could not be read (the
 * request failed, or the browser is offline with nothing in hand). A later read that succeeds —
 * the tab coming back, a reconnect — brings the numbers.
 */
export function useUsageSummary(): UsageSlotValue {
  const query = useUsage();
  const { data } = query;
  if (data) return { usedBytes: data.usedBytes, quotaBytes: data.quotaBytes };
  return hasFailed(query) || isWaitingOffline(query) ? "unavailable" : null;
}
