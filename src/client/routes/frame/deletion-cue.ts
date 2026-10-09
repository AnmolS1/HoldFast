import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { deletionStatusQuery, refreshSession } from "../../lib/query";

/**
 * `?deletion=scheduled` on any route is the cue that the emailed deletion link was just followed:
 * re-read the deletion status and the session so the banner shows at once, then drop the
 * parameter. A repeat visit does the same and simply finds the banner already there.
 */
export function useDeletionCue(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("deletion") !== "scheduled") return;
    void queryClient.invalidateQueries({ queryKey: deletionStatusQuery.queryKey });
    void refreshSession().catch(() => {});
    params.delete("deletion");
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate, queryClient]);
}
