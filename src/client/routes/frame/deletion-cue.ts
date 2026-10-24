import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "../../components/Toaster/store";
import { t, type MessageKey } from "../../lib/i18n";
import { deletionStatusQuery, refreshSession } from "../../lib/query";

/** The deletion link's other answers (src/worker/routes/auth.ts): a sentence each, nothing else. */
const LINK_ANSWERS: Readonly<Record<string, MessageKey>> = {
  other_account: "banner.deletion.linkOtherAccount",
  link_invalid: "banner.deletion.linkInvalid",
};

/**
 * `?deletion=scheduled` on any route is the cue that the emailed deletion link was just followed:
 * re-read the deletion status and the session so the banner shows at once, then drop the
 * parameter. A repeat visit does the same and simply finds the banner already there.
 * `?deletion=other_account` / `?deletion=link_invalid` (the link was for another account, or is
 * used up or expired) say so in a toast, and the parameter is dropped the same way.
 */
export function useDeletionCue(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const cue = params.get("deletion");
    if (cue === "scheduled") {
      void queryClient.invalidateQueries({ queryKey: deletionStatusQuery.queryKey });
      void refreshSession().catch(() => {});
    } else if (cue !== null && Object.hasOwn(LINK_ANSWERS, cue)) {
      toast({ message: t(LINK_ANSWERS[cue]!), key: "deletion" });
    } else return;
    params.delete("deletion");
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate, queryClient]);
}
